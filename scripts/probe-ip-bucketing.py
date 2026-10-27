#!/usr/bin/env python3
"""Separate the free-tier shape gates from the quota axis for OpenCode Zen.

Why: AGENTS.md claims the free-tier quota is independent of the egress IP and
resets at UTC midnight. The community (ebouther/opencode-unlimited-proxy)
claims the 429 bucket is keyed on the source address and widens with more
egress. Both can be true statements about different call paths. This probe
varies exactly one thing at a time and prints a table instead of an opinion.

What it sends:
  A  direct egress, official client shape   -> tests the shape gates
  B  through --proxy, identical shape       -> tests whether the bucket is per-IP
  C  direct egress, broken shape            -> tests that this host is not just refused

It never spends more than a handful of free-tier requests, changes no code, and
touches no running service. Credentials are optional: with no --key the script
uses `Bearer public` (the anonymous free-tier credential).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import string
import sys
import time
import urllib.error
import urllib.request
from http import HTTPStatus

UPSTREAM = "https://opencode.ai/zen/v1/chat/completions"
UA = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"
BASE62 = string.ascii_letters + string.digits
# The real client's tool set; only `read` is load-bearing upstream.
CLIENT_TOOLS = ("bash", "glob", "grep", "read")


def canonical_id(prefix: str, counter: int = 1) -> str:
    """OpenCode CLI Identifier.descending(): ~(unix_ms << 12 | counter) -> 6 bytes -> 12 hex.

    Upstream decodes the first 12 hex characters back to a timestamp, so a
    random 12-hex id is refused even though it matches the surface regex.
    """
    ms = int(time.time() * 1000)
    payload = ~((ms << 12) | counter) & ((1 << 48) - 1)
    head = payload.to_bytes(6, "big").hex()
    assert head.endswith("ffe"), f"canonical layout broken: {head}"
    return f"{prefix}_{head}{''.join(random.choice(BASE62) for _ in range(14))}"


def toolset(names=CLIENT_TOOLS) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": n,
                "description": "t",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for n in names
    ]


def classify(status: int, body: str) -> tuple[str, str]:
    """Map a refusal to the axis it belongs to. The message is the only signal."""
    text = (body or "").strip()
    try:
        parsed = json.loads(text)
        err = parsed.get("error", {}) or {}
        message = str(err.get("message", "") or parsed.get("message", ""))
        kind_hint = str(err.get("type", ""))
    except ValueError:
        message, kind_hint = text, ""
    lowered = f"{kind_hint} {message} {text[:400]}".lower()
    if "not available in your country" in lowered:
        return "geo", "region block - no request shape fixes this"
    if "missingsessionid" in lowered:
        return "session-required", "go lane requires a real x-opencode-session id (not the free-tier gate)"
    if "model access is disabled" in lowered:
        return "access", "this key has no entitlement for this model - not a quota or gate issue"
    if "within opencode" in lowered:
        return "shape", "request-shape gate - this is the gate the community documents"
    if "freeusagelimiterror" in lowered or "free usage" in lowered or "usage limit" in lowered:
        return "quota", "quota axis - the request ran and the budget was spent"
    if "upgrade required" in lowered:
        return "version", "stale client fingerprint"
    if "authentication" in lowered or "unauthorized" in lowered:
        return "auth", "credential problem"
    if status == 200:
        return "ok", ""
    return "unknown", "unrecognised refusal"


def retry_after(headers) -> str:
    for name in ("retry-after", "x-ratelimit-reset", "x-ratelimit-remaining"):
        value = headers.get(name)
        if value is not None:
            extra = ""
            if name == "retry-after":
                try:
                    # Retry-After is relative seconds; the reset instant is what
                    # tells us whether the bucket is a shared UTC-day clock.
                    reset_at = time.time() + float(value)
                    extra = " -> UTC " + time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(reset_at))
                except ValueError:
                    pass
                return f"{name}: {value}{extra}"
            return f"{name}: {value}"
    return ""


class Probe:
    def __init__(self, label, axis, *, key, proxy, session, tools, stream, model):
        self.label, self.axis = label, axis
        self.key, self.proxy = key, proxy
        self.session, self.tools, self.stream, self.model = session, tools, stream, model

    def fire(self, timeout: int):
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "stream": self.stream,
            "max_tokens": 60,
        }
        if self.tools is not None:
            body["tools"] = toolset(self.tools)
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "x-opencode-client": "cli",
            "x-opencode-project": "global",
            "x-opencode-session": self.session,
            "x-opencode-request": canonical_id("msg"),
            "Accept": "text/event-stream",
        }
        if self.proxy:
            handlers = [
                urllib.request.ProxyHandler({"http": self.proxy, "https": self.proxy})
            ]
        else:
            handlers = []
        opener = urllib.request.build_opener(*handlers)
        req = urllib.request.Request(
            UPSTREAM, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        started = time.time()
        try:
            with opener.open(req, timeout=timeout) as resp:
                return resp.status,resp.read(200).decode("utf-8", "replace"),retry_after(resp.headers),time.time() - started
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(400).decode("utf-8", "replace"), retry_after(exc.headers), time.time() - started
        except Exception as exc:  # noqa: BLE001 - report, never explode
            return "ERR", repr(exc)[:200], "", time.time() - started


def build_probes(args) -> list[Probe]:
    common = dict(key=args.key, model=args.model)
    probes = [
        Probe("A direct / official shape", "shape gates",
              proxy=None, session=canonical_id("ses"), tools=CLIENT_TOOLS, stream=True, **common),
        Probe("C direct / broken shape (control)", "shape gates",
              proxy=None, session=canonical_id("ses"), tools=None, stream=True, **common),
    ]
    if args.proxy:
        # Same request as A, only the source address differs. Same key on purpose:
        # if the bucket is per-IP, B succeeds while A is refused.
        probes.append(
            Probe(f"B proxy {args.proxy} / official shape", "quota axis",
                  proxy=args.proxy, session=canonical_id("ses"), tools=CLIENT_TOOLS,
                  stream=True, **common)
        )
    return probes


def load_key(explicit: str | None) -> tuple[str, str]:
    """Return (key, where_it_came_from).

    An explicit --key wins. Otherwise read the credential the official CLI itself
    uses (~/.local/share/opencode/auth.json), which is also what bin/config.json
    zen_keys holds on this machine. `public` is the anonymous free-tier credential
    and is only used when nothing is found -- it is the one that hits RegionError.
    """
    if explicit:
        return explicit, "--key"
    candidates = []
    if os.environ.get("OPENCODE_AUTH_FILE"):
        candidates.append(os.environ["OPENCODE_AUTH_FILE"])
    candidates.append(os.path.join(os.path.expanduser("~"), ".local", "share", "opencode", "auth.json"))
    if os.environ.get("APPDATA"):
        candidates.append(os.path.join(os.environ["APPDATA"], "opencode", "auth.json"))
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        for provider in ("opencode", "opencode-go"):
            entry = data.get(provider) or {}
            if entry.get("key"):
                return str(entry["key"]).strip(), path
    return "public", "fallback (anonymous)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--proxy", help="second egress, e.g. http://95.40.244.5:7897")
    ap.add_argument("--key", default=None, help="Zen key; default: read from the CLI auth.json")
    ap.add_argument("--anonymous", action="store_true", help="force Bearer public instead")
    ap.add_argument("--model", default="beam-free", help="free-tier model id")
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args()
    if args.anonymous:
        args.key, key_source = "public", "--anonymous"
    else:
        args.key, key_source = load_key(args.key)

    print(f"upstream  {UPSTREAM}")
    print(f"model     {args.model}")
    label = "public (anonymous)" if args.key == "public" else f"oc_sk_...{args.key[-4:]}"
    print(f"credential {label}  from {key_source}")
    print(f"egress    A/C direct; B {'proxy ' + args.proxy if args.proxy else '(none given)'}")
    print()

    rows = []
    for probe in build_probes(args):
        status, raw, retry, elapsed = probe.fire(args.timeout)
        kind, advice = classify(status, raw)
        rows.append((probe, status, kind, retry, elapsed, raw.strip()[:120], advice))
        print(f"[{probe.label}]")
        print(f"  HTTP {status}  ({elapsed:.1f}s)  axis={kind or 'ok'}")
        if retry:
            print(f"  {retry}")
        if advice:
            print(f"  {advice}")
        if raw.strip():
            print(f"  {raw.strip()[:150]}")
        print()

    # Verdict. Only stated when the two probes answer different questions cleanly.
    by_label = {r[0].label[:1]: r for r in rows}
    a = by_label.get("A")
    c = by_label.get("C")
    b = by_label.get("B")
    print("=" * 60)
    if a and a[2] == "geo":
        print("Nothing was measurable: every egress was refused with RegionError.")
        print("  The key does not change that -- RegionError is an egress-country block,")
        print("  not a credential check. Record it as 'unverified', not as 'IP irrelevant'.")
    elif a and c and a[1] == 200 and c[1] == 403:
        print("shape gates: this egress can be admitted (A=200, C=403).")
    elif a and a[2] in ("quota",):
        print("shape gates: not tested - this egress is already out of quota.")
    elif a and c and a[1] == 403 and c[1] == 403:
        print("shape gates: unresolved - A was refused too. Read A's message above;")
        print("  'within OpenCode' means a header/tool/stream problem, not quota.")
    if b and a:
        a_kind, b_kind = a[2], b[2]
        if a_kind == "quota" and b_kind == "ok":
            print("quota axis: PER-IP. Same request, same key: direct=429, proxy=200.")
            print("  AGENTS.md 'egress IP is irrelevant' must be corrected.")
        elif a_kind == "quota" and b_kind == "quota":
            shared = a[3] and a[3] == b[3]
            print("quota axis: both egresses are out. Comparing Retry-After:")
            print(f"  A: {a[3] or '(none)'}")
            print(f"  B: {b[3] or '(none)'}")
            if shared:
                print("  identical -> shared clock (UTC-day reset), not per-IP.")
            else:
                print("  different -> per-IP buckets; AGENTS.md must be corrected.")
        elif a_kind == "ok" and b_kind == "ok":
            print("quota axis: both egresses have budget left; re-run once one is drained.")
        else:
            print(f"quota axis: inconclusive (A={a_kind or 'ok'}, B={b_kind or 'ok'}).")
    elif not b:
        print("quota axis: skipped - no --proxy given.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
