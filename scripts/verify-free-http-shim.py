import json, os, socket, subprocess, sys, time, urllib.request, urllib.error

ROOT = r"E:\Agent\opencode-api-plugin"
PORT = 18099
NODE = r"C:\Program Files\nodejs\node.exe"

env = dict(os.environ)
env["NODE_USE_ENV_PROXY"] = "1"
env["HTTPS_PROXY"] = "http://127.0.0.1:7897"
env["OPENCODE_CLI_TRANSPORT"] = "http"

proc = subprocess.Popen(
    [NODE, os.path.join(ROOT, "src", "cli-server.ts"),
     "--port", str(PORT),
     "--model", "opencode/big-pickle",
     "--models", "big-pickle,deepseek-v4.1-flash-free,glm-5.3-flash-free"],
    cwd=ROOT, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, encoding="utf-8", errors="replace",
)

def wait_health(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/healthz", timeout=2) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(0.5)
    return None

try:
    health = wait_health()
    print("healthz:", json.dumps(health, ensure_ascii=False) if health else "TIMEOUT")

    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=10) as r:
        body = json.loads(r.read().decode())
    ids = [m["id"] for m in body.get("data", [])]
    print("models:", ids)

    def chat(model, stream):
        payload = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "stream": stream,
        }).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/v1/chat/completions", data=payload,
            headers={"content-type": "application/json"}, method="POST")
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(400).decode("utf-8", "replace"), r.headers.get("retry-after"), time.time() - started
        except urllib.error.HTTPError as e:
            return e.code, e.read(400).decode("utf-8", "replace"), e.headers.get("retry-after"), time.time() - started
        except Exception as e:
            return "ERR", repr(e)[:200], None, time.time() - started

    for model in ("glm-5.3-flash-free", "big-pickle"):
        for stream in (False, True):
            status, text, retry, dt = chat(model, stream)
            print(f"\n{model} stream={stream}: HTTP {status} in {dt:.1f}s retry-after={retry}")
            print("  " + text.strip().replace("\n", " ")[:300])
finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=10)[0]
    except Exception:
        proc.kill()
        out = ""
    print("\n--- server log ---")
    print(out.strip()[:1500])
