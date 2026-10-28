#!/usr/bin/env python3
"""Tell apart "out of quota" from "upstream no longer recognises us".

Both failures look almost identical: the free tier answers 429 FreeUsageLimitError
with a Retry-After in either case. Measured 2026-10-27, a Node client got exactly
that 429 while the same egress, same minute, through oc2api's uTLS got 200 -- the
refusal had simply been dressed as a quota message.

The discriminating facts:

  * only oc2api can talk to zen, so only its answer means anything about quota.
    A 429 from Node proves nothing (it is the fingerprint refusal).
  * FreeTierError / 426 are shape-and-version problems, never quota.
  * Retry-After pointing at the NEXT UTC midnight means "wait for the daily reset";
    a 429 whose Retry-After points somewhere else is not a quota wall.
  * a 429 that survives a reset is the fingerprint changing under us, because the
    daily counter does come back.

Usage:
  python scripts/check-free-lane.py           # costs nothing, only local probes
  python scripts/check-free-lane.py --probe   # one minimal chat request
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(os.environ.get("TEMP") or "/tmp", "opencode-free-lane-state.json")

# This host's console is GBK (code page 936); printing the Chinese guidance straight to
# it produces mojibake. Force UTF-8 on the stream and keep going on odd characters.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def load_config() -> dict:
    with open(os.path.join(ROOT, "gateway.config.json"), encoding="utf-8-sig") as fh:
        return json.load(fh)


def get(url: str, key: str | None = None, timeout: int = 10):
    headers = {"authorization": f"Bearer {key}"} if key else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
            return r.status, r.read(400).decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(400).decode("utf-8", "replace"), dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return "ERR", repr(e)[:160], {}


def next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def classify(status, body: str, headers: dict) -> tuple[str, str]:
    """Return (kind, what_to_do). kind is stable, the text is for humans."""
    text = (body or "").lower()

    if status == 200:
        return "OK", "额度与指纹都正常，直接用。"

    if "regionerror" in text or "not available in your country" in text:
        return "REGION", (
            "该模型地区受限（beam-free 就是这样）。不是额度、不是指纹，换一个免费模型即可。"
        )

    if "freetiererror" in text:
        return "FINGERPRINT", (
            "上游不认这个客户端形状/指纹了 —— 这是 oc2api 失效的典型信号。"
            "重建 oc2api（拉上游最新源码），或临时退回 CLI 通道。"
        )

    if status == 426 or "upgrade required" in text:
        return "VERSION", "客户端自称的版本过旧 —— 升级 oc2api。"

    # The free tier has reported exhaustion as 402 insufficient_quota at least once
    # (2026-10-24, "Free usage exceeded, subscribe to Go"), not only as 429. Both mean
    # the same thing, so neither may fall through to UNKNOWN.
    if status == 402 or "free usage exceeded" in text or "insufficient_quota" in text:
        return "QUOTA", (
            "额度耗尽。历史上这条以 402 `insufficient_quota`（Free usage exceeded）出现过，"
            "不是 429；按 UTC 日重置，等到那个时刻即可。"
        )

    if status == 429 or "freeusagelimit" in text:
        raw = headers.get("retry-after") or headers.get("Retry-After")
        if not raw:
            return "SUSPECT", "429 但没有 Retry-After —— 不像纯额度，先按指纹/形状问题排查。"
        try:
            wait = float(raw)
        except ValueError:
            return "SUSPECT", f"429 且 Retry-After 不是秒数（{raw}）—— 按指纹问题排查。"
        now = datetime.now(timezone.utc)
        target = now + timedelta(seconds=wait)
        midnight = next_utc_midnight(now)
        drift = abs((target - midnight).total_seconds())
        if drift <= 180:
            return "QUOTA", (
                f"额度耗尽。Retry-After={wait:.0f}s 指向 UTC {midnight:%Y-%m-%d %H:%M}"
                f"（北京时间 {(midnight + timedelta(hours=8)):%m-%d %H:%M}），到期自动恢复，不用重试。"
            )
        return "SUSPECT", (
            f"429 但 Retry-After 指向 UTC {target:%Y-%m-%d %H:%M}，离下一个 UTC 零点还差 "
            f"{drift/3600:.1f} 小时 —— 这不是「每日额度重置」的形状，按指纹或上游限流排查。"
        )

    if status == "ERR":
        return "LOCAL", f"连不上本地服务：{body}"
    return "UNKNOWN", f"HTTP {status}：{body[:160]}"


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return {}


def save_state(data: dict) -> None:
    try:
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--probe", action="store_true", help="send one minimal chat request (spends quota)")
    args = ap.parse_args()

    cfg = load_config()
    lanes = cfg.get("lanes", {})
    oc_port = int(lanes.get("oc2api", {}).get("port", 18090))
    oc_key = lanes.get("oc2api", {}).get("apiKey", "")
    shim_port = int(lanes.get("cliServer", {}).get("port", 18080))
    gw_port = int(cfg.get("port", 8787))
    oc = f"http://127.0.0.1:{oc_port}"

    print(f"oc2api :{oc_port}   shim :{shim_port}   gateway :{gw_port}\n")

    # ---- free checks (no chat, no quota) -------------------------------------
    status, body, _ = get(f"{oc}/health")
    oc_ok = status == 200 and '"ok"' in (body or "")
    print(f"  oc2api /health      {'ok' if oc_ok else 'FAIL ' + str(status)}")

    status, _, _ = get(f"{oc}/v1/models", oc_key)
    print(f"  oc2api /models      {status}")

    status, _, _ = get(f"http://127.0.0.1:{shim_port}/healthz")
    print(f"  shim /healthz       {status}")

    status, _, _ = get(f"http://127.0.0.1:{gw_port}/v1/models")
    print(f"  gateway /models     {status}")

    if not oc_ok:
        print("\n判断：oc2api 进程本身没起来 —— 这不是额度问题，是本地问题。")
        print("     查网关日志里 [Gateway] oc2api 那几行（二进制缺失 / 端口占用 / API_KEY 为空）。")
        return 1

    if not args.probe:
        print("\n以上都不花额度。要区分「额度」和「指纹」必须发一次推理请求：")
        print("  python scripts/check-free-lane.py --probe   （1 次，max_tokens=1）")
        state = load_state()
        if state.get("last_429_at"):
            print(f"  上次观测到 429：{state['last_429_at']}  ({state.get('last_kind', '?')})")
        return 0

    # ---- the one paid probe ---------------------------------------------------
    payload = json.dumps(
        {
            "model": "glm-5.3-flash-free",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 1,
            "stream": False,
        }
    ).encode()
    req = urllib.request.Request(
        f"{oc}/v1/chat/completions",
        data=payload,
        headers={"content-type": "application/json", "authorization": f"Bearer {oc_key}"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, body, headers = r.status, r.read(600).decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        status, body, headers = e.code, e.read(600).decode("utf-8", "replace"), dict(e.headers)
    except Exception as e:  # noqa: BLE001
        status, body, headers = "ERR", repr(e)[:200], {}

    kind, advice = classify(status, body, headers)
    print(f"\n  probe: {status} in {time.time() - started:.1f}s  ->  {kind}")
    print(f"  {advice}")

    state = load_state()
    if kind in ("QUOTA", "SUSPECT", "FINGERPRINT"):
        now = datetime.now(timezone.utc)
        previous = state.get("last_429_at")
        state["last_429_at"] = f"{now:%Y-%m-%d %H:%M}Z"
        state["last_kind"] = kind
        save_state(state)
        if previous:
            try:
                prev_day = previous[:10]
                if prev_day != f"{now:%Y-%m-%d}" and kind == "QUOTA":
                    print(
                        "  注意：上一次也记到 429，且已经跨过了一个 UTC 日。"
                        "如果今天重置后仍然立刻 429，且 Retry-After 又指向下一个零点，"
                        "那更像指纹/上游判定变了，而不是额度。"
                    )
            except Exception:  # noqa: BLE001
                pass
    elif kind == "OK":
        save_state({})
    return 0


if __name__ == "__main__":
    sys.exit(main())
