"""GitHub API 的一个**窄入口** —— 给 agent 用，不放行裸 curl。

为什么存在
----------
`gh` CLI 没有装（2026-08-21 实测：PATH 与全盘都没有 `gh.exe`），而 agent 需要
建 PR / 读 PR / 评论。放行「任意 curl」等于把「往任意主机发任意东西」交出去；
放行**这一个脚本**只交出「对 api.github.com 做这几件事」。

凭据从哪来
----------
`git credential fill` —— 也就是 `git push` 用的那一份（本机是 Git Credential
Manager）。所以**不新增任何密钥、不需要用户贴 token**，权限边界与 git 本来
能做的事完全一致。

三条硬规矩
----------
1. **token 绝不出现在输出里**。它不进 argv、不进日志；**所有**输出只走 `_out()` /
   `_fail()` 这两个口子，无条件过一遍 `_redact()`，万一 API 把它回显出来也会被
   打成 `***`。逐个字段判断「这行要不要 redact」必漏一个，所以不这么做。
2. **只打 api.github.com**，host 写死并在发请求前再核一次；`--repo` 走**白名单**
   （`[A-Za-z0-9][A-Za-z0-9._-]*`，两段），因此 `#` / `?` 这类能改写或截断路径的
   字符进不来 —— 黑名单只会等下一个变体。
3. **fail-closed**：取不到凭据、host 不对、HTTP 非 2xx —— 一律非零退出并说清
   原因，不静默继续。

平台
----
纯 stdlib（urllib），路径走 pathlib，外部工具经 `shutil.which` 解析
（AGENTS.md 第 3 / 第 6 条）。Windows 与 Ubuntu 同一份代码。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

# 本机控制台是 cp932（日文 Windows），而本脚本的信息是中文 —— 不显式换成 UTF-8
# 的话，报错本身会变成乱码，等于把 fail-closed 的理由弄丢了。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # 被重定向成不支持的流时，不值得为此失败
        pass

API_HOST = "api.github.com"
API_BASE = f"https://{API_HOST}"
_TOKEN: str | None = None


def _fail(msg: str) -> None:
    """一句话说清为什么做不了，然后退出。"""
    print(_redact(f"gh-api: {msg}"), file=sys.stderr)
    raise SystemExit(2)


def _redact(text: str) -> str:
    """输出里凡是出现 token 就打掉 —— 它可能被 API 回显进 error body。"""
    if _TOKEN and _TOKEN in text:
        return text.replace(_TOKEN, "***")
    return text


def _out(text: str) -> None:
    """**唯一的输出口子。**

    脚本里不直接 `print` 任何一行 —— 打出来的东西几乎全部来自 API 响应（标题、
    分支名、PR 正文……），而「哪些字段可能回显 token」不是我们能替 GitHub 保证的。
    逐个字段判断「这个要不要 redact」注定漏一个：codex 就是在 PR 标题那一行抓到
    的。让所有输出无条件过一遍，漏字段就不再是一种可能的写法。
    """
    print(_redact(text))


def _token() -> str:
    """从 git 的凭据管理器取 GitHub token。**不打印，不落盘。**"""
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    git = shutil.which("git")
    if git is None:
        _fail("PATH 上找不到 git —— 无法取凭据（ADR-0049：解析不到就 fail-closed）")
    try:
        # **字节模式，不用 text=True**：本机默认编码是 cp932，git / 凭据管理器
        # 的输出里只要有一个它解不了的字节，读取线程就整个崩掉（实测 0x84），
        # 结果 stdout 变空、错误信息变成「没有凭据」—— 一个假的诊断。
        #
        # env 是 **os.environ 的副本加一个键**，不是只有那一个键：整份替换会把
        # PATH / APPDATA / USERPROFILE 全抹掉，Git Credential Manager 连自己
        # 的存储都找不到。
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [git, "credential", "fill"],
            input=b"protocol=https\nhost=github.com\n\n",
            capture_output=True,
            timeout=30,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except subprocess.TimeoutExpired:
        _fail("git credential fill 超时（凭据管理器可能在等交互输入）")
    text = (out.stdout or b"").decode("utf-8", "replace")
    for line in text.splitlines():
        if line.startswith("password="):
            _TOKEN = line[len("password=") :].strip()
            break
    if not _TOKEN:
        # 把 git 自己说的话带上 —— 「没有凭据」和「helper 起不来」是两回事，
        # 不带原文就只能靠猜（上一版就是这么误诊的）。
        err = (out.stderr or b"").decode("utf-8", "replace").strip()[:500]
        _fail(
            "取不到 github.com 的凭据（git credential fill 退出码 "
            f"{out.returncode}）。先做一次 `git push` 存一份。"
            + (f"\ngit 说：{err}" if err else "")
        )
    return _TOKEN


# GitHub 的 owner / repo 允许的字符集（首字符必须是字母数字）。
# **白名单，不是黑名单**：原来的写法只拦 `/` 和 `..`，于是 `?` 和 `#` 照过 ——
# 一个 `#` 就能把 `/repos/o/n#/pulls` 截断成 `/repos/o/n`，一个 `?` 能塞查询串，
# 「只打这几个端点」的保证当场作废（codex 的 blocking finding）。
# 逐个补 `?`、`#` 只会等下一个变体（`%`、`\`、空格……）；改成白名单，这一类就没了。
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _repo(value: str) -> str:
    """`owner/name`，别的一律拒 —— 不让参数决定打哪个端点。"""
    parts = value.split("/")
    ok = (
        len(parts) == 2
        and all(_NAME_RE.match(p) for p in parts)
        # `a..b` 能过上面那条正则，但路径遍历要单独拦
        and ".." not in value
    )
    if not ok:
        _fail(f"--repo 必须是 owner/name（只允许字母数字 . _ -），收到：{value!r}")
    return value


def _call(method: str, path: str, payload: dict | None = None) -> dict | list:
    """一次 API 调用。host 写死，非 2xx 一律抛。"""
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)  # noqa: S310 - host 写死
    req.add_header("Authorization", f"Bearer {_token()}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "motv-gh-api/1")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if req.host != API_HOST:
        _fail(f"拒绝：目标 host 不是 {API_HOST}（{req.host}）")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = _redact(e.read().decode("utf-8", "replace"))[:2000]
        _fail(f"HTTP {e.code} {method} {path}\n{detail}")
    except urllib.error.URLError as e:
        _fail(f"网络错误 {method} {path}：{e.reason}")
    return json.loads(body) if body else {}


# --------------------------------------------------------------------------- #
# 子命令                                                                       #
# --------------------------------------------------------------------------- #


def cmd_pr_create(a) -> None:
    body = a.body
    if a.body_file:
        body = _read_text(a.body_file)
    pr = _call(
        "POST",
        f"/repos/{a.repo}/pulls",
        {
            "title": a.title,
            "head": a.head,
            "base": a.base,
            "body": body or "",
            "draft": bool(a.draft),
        },
    )
    _out(f"#{pr['number']}  {pr['html_url']}")


def cmd_pr_list(a) -> None:
    prs = _call("GET", f"/repos/{a.repo}/pulls?state={a.state}&per_page={a.limit}")
    if not prs:
        _out("（没有匹配的 PR）")
        return
    for pr in prs:
        _out(
            f"#{pr['number']}  {pr['head']['ref']} -> {pr['base']['ref']}  "
            f"[{pr['state']}]  {pr['title']}"
        )


def cmd_pr_view(a) -> None:
    pr = _call("GET", f"/repos/{a.repo}/pulls/{a.number}")
    _out(f"#{pr['number']}  {pr['title']}")
    _out(
        f"{pr['head']['ref']} -> {pr['base']['ref']}  [{pr['state']}]  "
        f"mergeable={pr.get('mergeable')}"
    )
    _out(
        f"提交 {pr.get('commits')} · 文件 {pr.get('changed_files')} · "
        f"+{pr.get('additions')}/-{pr.get('deletions')}"
    )
    _out(pr["html_url"])
    if pr.get("body"):
        _out("---")
        _out(pr["body"])


def cmd_pr_comment(a) -> None:
    body = a.body if a.body else _read_text(a.body_file)
    if not body:
        _fail("评论内容为空")
    c = _call("POST", f"/repos/{a.repo}/issues/{a.number}/comments", {"body": body})
    _out(c["html_url"])


def _read_text(path: str) -> str:
    from pathlib import Path

    p = Path(path)
    if not p.is_file():
        _fail(f"读不到文件：{path}")
    return p.read_text(encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(prog="gh-api", description=__doc__)
    ap.add_argument("--repo", required=True, type=_repo, help="owner/name")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pr-create", help="建一个 PR")
    p.add_argument("--title", required=True)
    p.add_argument("--head", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="")
    p.add_argument("--draft", action="store_true")
    p.set_defaults(fn=cmd_pr_create)

    p = sub.add_parser("pr-list", help="列 PR")
    p.add_argument("--state", default="open", choices=["open", "closed", "all"])
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(fn=cmd_pr_list)

    p = sub.add_parser("pr-view", help="看一个 PR")
    p.add_argument("--number", required=True, type=int)
    p.set_defaults(fn=cmd_pr_view)

    p = sub.add_parser("pr-comment", help="在 PR 上留一条评论")
    p.add_argument("--number", required=True, type=int)
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="")
    p.set_defaults(fn=cmd_pr_comment)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
