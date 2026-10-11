#!/usr/bin/env python3
"""Verify HTTP without printing credentials, HTML, or response tokens.

The gate covers every path but exactly /paypal/webhook: PayPal's signed deliveries reach the
API unauthenticated, and the API refuses them on their own signature check.
"""
from pathlib import Path
import json
import subprocess
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "loopback"
domain = "80-225-220-230.sslip.io"
password = (Path.home() / ".config/acquit/vm-basic-auth").read_text().strip()
ssh = [
    "ssh", "-i", str(Path.home() / ".ssh/id_ed25519_acquit_vm"),
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10", "ubuntu@80.225.220.230",
]
if mode == "loopback":
    base, extra = "http://127.0.0.1:8080", []
elif mode == "tls-loopback":
    base, extra = f"https://{domain}", ["--resolve", f"{domain}:443:127.0.0.1"]
elif mode == "public":
    base, extra = f"https://{domain}", []
else:
    raise SystemExit("Use loopback, tls-loopback, or public")

def request(path, authenticated=False, method="GET"):
    args = ["curl", "--silent", "--show-error", "--noproxy", "*",
            "--path-as-is",
            "--connect-timeout", "10", "--max-time", "20",
            "--request", method, "--write-out", "\\n%{http_code}", *extra]
    config = f'user = "acquit:{password}"\n' if authenticated else ""
    if authenticated:
        args += ["--config", "-"]
    args += [base + path]
    if mode != "public":
        import shlex
        args = [*ssh, shlex.join(args)]
    result = subprocess.run(args, input=config, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(f"{mode} curl failed, exit {result.returncode}; no credential output")
    body, code = result.stdout.rsplit("\n", 1)
    return int(code), body

for path in ["/", "/jobs/smoke", "/api/users", "/paypal/webhook/x", "/paypal/webhooks", "/paypal/webhook/../api/session"]:
    code, _ = request(path)
    assert code == 401, f"Unauthenticated {path} returned {code}"
    print(f"{mode} unauthenticated {path}: 401")
# The one exemption: a POST reaches the API unauthenticated, and the API's own signature check
# refuses an unsigned body. Anything but Caddy's 401 is the API answering.
code, _ = request("/paypal/webhook", method="POST")
assert code != 401, f"Unauthenticated POST /paypal/webhook returned {code}"
print(f"{mode} unauthenticated POST /paypal/webhook: {code} (API refusal, not the gate)")
for path in ["/", "/jobs/smoke"]:
    code, body = request(path, True)
    assert code == 200 and "<!doctype html>" in body.lower(), f"HTML failed: {code}"
    print(f"{mode} authenticated {path}: 200 HTML")
code, body = request("/api/users", True)
assert code == 200 and isinstance(json.loads(body)["users"], list)
print(f"{mode} authenticated /api/users: 200 JSON")
code, body = request("/api/session", True)
assert code == 200 and json.loads(body)["user"] is None
print(f"{mode} authenticated /api/session: 200 JSON, no app session")
code, body = request("/api/dev/clock", True, "POST")
assert code == 403 and json.loads(body)["error"] == "DEV_DISABLED"
print(f"{mode} authenticated dev route: 403 DEV_DISABLED")
