"""用创作者**自己账号的额度**出一张图（ADR-0100 · REQ-008）。

这是图片生成的**第三条路**，与既有两条并列：

    手工      把 prompt 复制到网页版，生成完再传回来（今天的实际主路）
    付费      ADR-0045 的 MiniMax image-01，$0.0035/张，锁在付费闸后面
    账号额度  ← 本模块。用他 Google 账号的免费额度，**不产生按次账单**

因为不产生账单，它**不过付费闸**（ADR-0100 决策 1：闸的判据是「会不会产生一笔
按次账单」，不是「是不是外部调用」——`claude-code` / `codex-cli` 跑在他订阅上，
也从来不过闸）。

**厂商报文形状只住在这里**（ADR-0100 决策 7）。`server.py` 已经是 358KB 单体
（TASK-087 §3.6.1），再往里塞一家的 JSON 形状只会让那件事更糟；更重要的是：
本模块对外只暴露一个**纯函数** —— 拿 prompt 和一个可调用的 ``transport``，
回图片字节或一个**具名**失败。于是整条路不联网就能测完，而 ADR-0045 那条路
至今只能靠真跑一次才知道对不对。

写入边界与 ADR-0045 决策 4 相同：产物落**草稿域**（手工上传的同一个槽位），
不写核心业务文件，因此不需要经 Command Gateway（AGENTS.md §4 管的是核心事实的
变更命令）。落盘那一半在 `server.py`，本模块不碰文件系统。
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass

#: Gemini 的图片生成入口（Interactions API）。固定常量，不从请求里取 ——
#: 让调用方指定 endpoint 等于给自己开一个 SSRF 面。
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"

#: Nano Banana。选它的理由在 ADR-0100 决策 6：同一个 Google 账号即可取 key，
#: 不要信用卡，免费额度足够日常出图。
DEFAULT_MODEL = "gemini-2.5-flash-image"

#: 与 `server.py` 的 `_IMAGE_PROMPT_MAX` 同值。两处都要挡，因为本模块也可能
#: 被别的调用方用；不同值会让「谁先拒」变成运气问题。
MAX_PROMPT = 1_500

#: 与 `server.py` 的 `_IMAGE_MAX` 同值（20MB）。
MAX_IMAGE_BYTES = 20_000_000

#: 请求超时（秒）。出图是几秒到几十秒的事，120 秒是「肯定不是在等它了」。
DEFAULT_TIMEOUT = 120

#: 「确定没有发生外部副作用」的那一小撮状态码 —— 与创作者系统合同 §5.8 逐字一致。
#: 合同把它定成一个**白名单**而不是黑名单：不在名单里的一律 `unknown`，
#: 因为「不知道有没有跑」必须往危险的那边倒。
_DEFINITIVE_REJECT = frozenset({400, 401, 403, 404, 422})

#: 额度耗尽。它必须是一个**具名**结果而不是笼统的失败（ADR-0100 决策 3）：
#: 界面要说得出「今天的免费额度用完了」，而且**禁止**因此回退到付费那条路。
_QUOTA_STATUS = frozenset({429})


class TransportFailed(Exception):
    """网络层没能拿回一个 HTTP 响应（连接断了、超时、DNS 失败……）。

    调用方（`transport`）抛它。请求**已经发出去过**，所以它落 `unknown`：
    远端可能已经生成、已经消耗了一次额度。
    """


@dataclass(frozen=True)
class ImageResult:
    """一次成功的生成。`side_effect` 恒为 `applied` —— 额度确实被消耗了一次。"""

    data: bytes
    mime_type: str
    model: str
    side_effect: str = "applied"


@dataclass(frozen=True)
class ImageFailure(Exception):
    """一次失败的生成，带**具名**类别与副作用判定。

    `side_effect` 用的是合同 §5.8 的词汇：

        none      确定没消耗额度（请求在生成之前就被拒了）
        unknown   *** 无法确认 *** —— 禁止自动重试（ADR-0100 决策 2）
        applied   确定消耗了（拿到了回复，但回复里没有可用的图）

    最后一种最容易被写错成 `none`。它是「钱花了东西没拿到」的额度版本：
    把它记成没发生，下一次重试就是第二次消耗。
    """

    category: str
    detail: str
    side_effect: str

    def __str__(self) -> str:  # pragma: no cover - 只为异常打印好看
        return f"{self.category}: {self.detail}"


def build_request(prompt: str, *, model: str = DEFAULT_MODEL, api_key: str):
    """把一次生成变成 (url, body, headers)。分出来是为了能单独断言报文形状。

    key 只出现在 header 里，**不进 URL** —— URL 会进日志、进错误信息、进代理的
    访问记录，那是凭据最常见的泄露路径。
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ImageFailure("bad_request", "prompt 不能为空", "none")
    if len(prompt) > MAX_PROMPT:
        raise ImageFailure("bad_request", f"prompt 超过 {MAX_PROMPT} 字", "none")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ImageFailure("no_credential", "还没有设置账号 key", "none")
    body = json.dumps(
        {"model": model, "input": [{"type": "text", "text": prompt}]},
        ensure_ascii=False,
    ).encode("utf-8")
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    return GEMINI_ENDPOINT, body, headers


def generate_image(
    prompt: str,
    *,
    api_key: str,
    transport,
    model: str = DEFAULT_MODEL,
    timeout: float = DEFAULT_TIMEOUT,
) -> ImageResult:
    """出一张图，或抛一个 `ImageFailure`。

    `transport(url, body, headers, timeout) -> (status, raw_bytes)`；网络层失败
    抛 `TransportFailed`。注入它的**唯一**理由是：这条路的每一种失败都要能在
    测试里走一遍，而它们大多数在真实网络里根本不可复现（额度耗尽、半截 JSON、
    图片字节坏掉）。
    """
    url, body, headers = build_request(prompt, model=model, api_key=api_key)
    try:
        status, raw = transport(url, body, headers, timeout)
    except TransportFailed as exc:
        # 请求发出去过 → 可能已经消耗额度 → `unknown` → 禁止自动重试。
        raise ImageFailure("network_failed", str(exc)[:200], "unknown") from exc

    if status in _QUOTA_STATUS:
        raise ImageFailure(
            "quota_exhausted",
            "这个账号今天的额度用完了",
            # **类别与副作用是两条轴，不要混。** 类别是具名的（界面据此说
            # 「额度用完了」而不是笼统的失败，ADR-0100 决策 3）；副作用则严格照
            # 合同 §5.8 的白名单走 —— 而 429 **明确写在 `unknown` 那一侧**
            # （「408 / 409 / 425 / 429 / 所有 5xx / 网络中断 / 超时」）。
            #
            # 第一版这里写的是 `none`，理由是「429 是生成之前的拒绝」。那是**推断
            # 供应商内部行为**，而合同的白名单恰恰存在于「不要那样推断」：不在名单
            # 里就往危险那边倒（codex 补审 2026-09-05 判 P1，判得对 —— 我在
            # Review Package 里引用了这条白名单，然后又例外了它）。
            "unknown",
        )
    if status in _DEFINITIVE_REJECT:
        raise ImageFailure(
            "credential_rejected" if status in (401, 403) else "bad_request",
            _provider_message(raw) or f"供应商拒绝了这次请求（HTTP {status}）",
            "none",
        )
    if status != 200:
        # 5xx、以及一切不在白名单里的状态码。合同 §5.8：不知道就往 `unknown` 倒。
        raise ImageFailure(
            "provider_unavailable",
            _provider_message(raw) or f"供应商返回 HTTP {status}",
            "unknown",
        )

    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        # 200 但 JSON 坏了：远端已经干过活了，额度按消耗算。
        raise ImageFailure("bad_output", "供应商回复不是合法 JSON", "applied") from exc

    b64, mime = _extract_image(payload)
    if b64 is None:
        raise ImageFailure(
            "bad_output",
            _provider_message(raw) or "回复里没有图片",
            "applied",
        )
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageFailure("bad_output", "图片 base64 解不开", "applied") from exc
    if not data:
        raise ImageFailure("bad_output", "图片是空的", "applied")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageFailure(
            "too_large",
            f"图片超过 {MAX_IMAGE_BYTES // 1_000_000}MB",
            "applied",
        )
    return ImageResult(data=data, mime_type=mime or "", model=model)


def _extract_image(payload):
    """从回复里取出 (base64, mime)，**两种形状都认**。

    文档给的是 Interactions API（`steps[].content[]` 里 `type == "image"`），
    而同一个 key 打到经典的 `generateContent` 时形状是
    `candidates[].content.parts[].inlineData`。两种都解，是因为**猜错的代价
    不对称**：多解一种形状是十几行代码，解错了则是「明明出图成功却报没有图」，
    而那一次额度已经消耗掉了。
    """
    if not isinstance(payload, dict):
        return None, None

    # 1) 便利字段：output_image
    out = payload.get("output_image")
    if isinstance(out, dict) and isinstance(out.get("data"), str):
        return out["data"], _str_or_none(out.get("mimeType") or out.get("mime_type"))

    # 2) Interactions API：steps[].content[]
    for step in _as_list(payload.get("steps")):
        if not isinstance(step, dict):
            continue
        for item in _as_list(step.get("content")):
            if not isinstance(item, dict):
                continue
            if item.get("type") == "image" and isinstance(item.get("data"), str):
                return item["data"], _str_or_none(
                    item.get("mimeType") or item.get("mime_type")
                )

    # 3) generateContent：candidates[].content.parts[].inlineData
    for cand in _as_list(payload.get("candidates")):
        if not isinstance(cand, dict):
            continue
        content = cand.get("content")
        if not isinstance(content, dict):
            continue
        for part in _as_list(content.get("parts")):
            if not isinstance(part, dict):
                continue
            inline = part.get("inlineData") or part.get("inline_data")
            if isinstance(inline, dict) and isinstance(inline.get("data"), str):
                return inline["data"], _str_or_none(
                    inline.get("mimeType") or inline.get("mime_type")
                )
    return None, None


def _provider_message(raw: bytes) -> str:
    """供应商自己的错误说明 —— 有就用它，没有就算了。

    截断到 200 字并且**只取消息字段**：错误体里可能回显请求内容，而请求里有
    prompt。整个 body 原样端到界面上，等于把创作者的文字塞进一条错误提示。
    """
    try:
        j = json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, AttributeError):
        return ""
    err = j.get("error") if isinstance(j, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or err.get("status")
        if isinstance(msg, str):
            return msg[:200]
    return ""


def _as_list(x):
    return x if isinstance(x, list) else []


def _str_or_none(x):
    return x if isinstance(x, str) and x else None
