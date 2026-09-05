"""创作者自己那把 key 存在哪、怎么读（ADR-0100 决策 4 · REQ-008 判据 3）。

**它必须能在界面里粘一次就用。** 产品负责人 2026-08-23：「不要加什么自己改不了
自己限制的设置。这样我做什么都不能自动化了。」环境变量 + 启动参数正是那种东西 ——
要他离开对话、改命令行、重启服务。所以权威存储是**应用数据目录里的一个文件**，
由设置页写入，写完立即生效。

环境变量**保留但降级**：只作为 CI 与自动化测试的入口，读取顺序是先设置、后环境。

三条硬规则：

1. **key 只进不出。** 对外只回答「设没设 + 后四位」，任何接口都不回显完整 key。
2. **不进仓库。** 落在 `APP_DATA_DIR`（仓库之外）；而且文件名 `credentials.json`
   本来就已经在 `.gitignore` 里 —— 两层保险，因为 AGENTS.md 第 23 条那条线
   （凭据不得进 Git）没有第二次机会。
3. **不进日志、不进 prompt、不进 Run 记录。** 本模块不打印任何东西。
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

#: 文件名与 `.gitignore` 里那条 `credentials.json` 逐字对应。改名字要连它一起改。
CRED_FILENAME = "credentials.json"

#: 存哪几把 key → 设置里的字段名 → 降级用的环境变量名。
#: 现在只有一把；这张表存在是为了下一把 key 不用再发明一次形状。
KEYS = {
    "gemini": {"field": "gemini_api_key", "env": "GEMINI_API_KEY"},
}

#: key 的形状检查。**不校验它对不对**（那只有供应商说了算），只挡住明显不是 key
#: 的输入：空白、换行、粘贴时带进来的引号、以及长得离谱的东西。
#: 挡在这里的理由是错误信息的质量：一个带换行的 key 会在 HTTP 头那一层炸成一个
#: 谁也看不懂的异常，而不是「这个 key 不像 key」。
_MIN_LEN = 16
_MAX_LEN = 400


class CredentialError(Exception):
    """key 的形状不对，或者存不下去。"""


def key_names() -> tuple[str, ...]:
    return tuple(KEYS)


def _path(app_data_dir: Path) -> Path:
    return Path(app_data_dir) / CRED_FILENAME


def _read_all(app_data_dir: Path) -> dict:
    """读整份凭据文件。读不出来一律当作「没有」——**但不删、不重写**。

    一个坏掉的凭据文件不该让后端起不来，也不该被我们静默覆盖掉：他可能是手工
    编辑时写坏的，里面还有别的东西。所以这里只是读不到，落到「没设置」。
    """
    try:
        raw = _path(app_data_dir).read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def resolve(app_data_dir: Path, name: str = "gemini", env=None) -> tuple[str, str]:
    """拿到可用的 key 与它的来源。

    返回 `(key, source)`，`source` 是 `settings` / `env` / `""`（没有）。
    **顺序是设置优先** —— 界面里粘的那把是他刚刚亲手给的，环境变量可能是几个月前
    某次自动化留下的，让旧的盖住新的会让「我明明改了」变成一个查半天的问题。
    """
    spec = KEYS.get(name)
    if spec is None:
        raise CredentialError(f"unknown credential {name!r}")
    value = _read_all(app_data_dir).get(spec["field"])
    if isinstance(value, str) and value.strip():
        return value.strip(), "settings"
    env_map = os.environ if env is None else env
    value = env_map.get(spec["env"], "")
    if isinstance(value, str) and value.strip():
        return value.strip(), "env"
    return "", ""


def describe(app_data_dir: Path, name: str = "gemini", env=None) -> dict:
    """给界面看的那份 —— **没有 key 本身**，只有「设没设、从哪来、后四位」。

    后四位是为了让他认得出「我粘的是不是这一把」，这是凭据界面的常规做法；
    四位不足以重建 key。
    """
    key, source = resolve(app_data_dir, name, env=env)
    return {
        "name": name,
        "configured": bool(key),
        "source": source,
        "last4": key[-4:] if len(key) >= 4 else "",
        "env_var": KEYS[name]["env"],
    }


def store(app_data_dir: Path, key: str, name: str = "gemini") -> dict:
    """把 key 写进应用数据目录。原子替换 + 尽力收紧权限。

    写法与仓库里其它持久化一处一致：临时文件 → `os.replace`。中途断电不会留下
    半份凭据文件，因为半份 JSON 会让 `_read_all` 读成「没有」，而他会以为自己
    设过了（`CA §5.2` 那条「不静默」的同一个精神）。
    """
    spec = KEYS.get(name)
    if spec is None:
        raise CredentialError(f"unknown credential {name!r}")
    if not isinstance(key, str):
        raise CredentialError("key 必须是字符串")
    key = key.strip()
    if not key:
        raise CredentialError("key 是空的")
    if len(key) < _MIN_LEN or len(key) > _MAX_LEN:
        raise CredentialError(f"key 长度看起来不对（{_MIN_LEN}–{_MAX_LEN} 之间）")
    if any(ch.isspace() for ch in key):
        raise CredentialError("key 里不该有空格或换行 —— 复制时多带了东西？")
    if not key.isprintable():
        raise CredentialError("key 里有不可见字符 —— 复制时多带了东西？")

    data = _read_all(app_data_dir)
    data[spec["field"]] = key
    data.setdefault("schema_version", 1)
    target = _path(app_data_dir)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            # 尽力而为：POSIX 上收成 0600；Windows 上 chmod 基本是空操作，
            # 但那里的保护来自用户目录本身的 ACL。失败不致命 —— 拿不到更严的
            # 权限也好过存不下 key，而这一点必须说出来而不是假装做到了。
            try:
                os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
            os.replace(tmp, target)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as exc:
        raise CredentialError(f"存不下来：{exc}") from exc
    return describe(app_data_dir, name)


def clear(app_data_dir: Path, name: str = "gemini") -> dict:
    """删掉设置里的那把（环境变量那把不归我们管，也删不了）。"""
    spec = KEYS.get(name)
    if spec is None:
        raise CredentialError(f"unknown credential {name!r}")
    data = _read_all(app_data_dir)
    if spec["field"] in data:
        data.pop(spec["field"])
        target = _path(app_data_dir)
        try:
            fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, target)
        except OSError as exc:
            raise CredentialError(f"删不掉：{exc}") from exc
    return describe(app_data_dir, name)
