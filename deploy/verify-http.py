#!/usr/bin/env python3
"""Verify HTTP without printing credentials, HTML, or response tokens.

The basic-auth gate came down at Close with the operator's explicit OK (decisions.tsv, category
operator-gate-ok). Every public path answers without auth. PayPal's /paypal/webhook still reaches
the API unauthenticated, where the API's own signature check refuses an unsigned delivery; the dev
routes stay refused; and the API's privileged reads still refuse a sessionless caller.
"""
from pathlib import Path
import json
import subprocess
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "loopback"
domain = "80-225-220-230.sslip.io"
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

def request(path, method="GET"):
    args = ["curl", "--silent", "--show-error", "--noproxy", "*",
            "--path-as-is",
            "--connect-timeout", "10", "--max-time", "20",
            "--request", method, "--write-out", "\\n%{http_code}", *extra]
    args += [base + path]
    if mode != "public":
        import shlex
        args = [*ssh, shlex.join(args)]
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(f"{mode} curl failed, exit {result.returncode}")
    body, code = result.stdout.rsplit("\n", 1)
    return int(code), body

for path in ["/", "/jobs/smoke"]:
    code, body = request(path)
    assert code == 200 and "<!doctype html>" in body.lower(), f"Public HTML failed: {code}"
    print(f"{mode} unauthenticated {path}: 200 HTML")
code, body = request("/api/session")
assert code == 200 and json.loads(body)["user"] is None and json.loads(body)["mode"] == "public", \
    f"Session read failed: {code}"
print(f'{mode} unauthenticated /api/session: 200 JSON, mode "public", no app session')
# The API still owns its own authz: a privileged read refuses a sessionless caller by itself.
code, body = request("/api/users")
assert code == 401 and json.loads(body)["error"] == "UNAUTHENTICATED", f"Privileged read: {code}"
print(f"{mode} unauthenticated /api/users: 401 UNAUTHENTICATED (the API's own refusal)")
# The webhook refusals are unchanged: an unsigned delivery reaches the API and its signature
# check refuses it. Anything but the API's own refusal would be wrong.
code, body = request("/paypal/webhook", "POST")
assert code == 400 and json.loads(body)["received"] is False, f"Unsigned webhook: {code}"
print(f"{mode} unauthenticated POST /paypal/webhook: 400 unsigned refusal (the API's signature check)")
for path, method in [("/paypal/webhook/x", "GET"), ("/paypal/webhooks", "POST")]:
    code, body = request(path, method)
    assert code == 404 and json.loads(body)["error"] == "NOT_FOUND", f"Lookalike {path}: {code}"
    print(f"{mode} unauthenticated {method} {path}: 404 NOT_FOUND")
# Caddy normalizes the traversal before matching, so it lands on the public session read.
code, body = request("/paypal/webhook/../api/session")
assert code == 200 and json.loads(body)["mode"] == "public", f"Traversal probe: {code}"
print(f"{mode} unauthenticated traversal probe: 200 on /api/session (no gate left to bypass)")
# The dev route answers what the deployment runs: P1 ships ACQUIT_DEV=1, where the route is enabled
# and an unauthenticated call still needs an app session; public mode refuses it by name.
probe = subprocess.run([*ssh, "sudo grep -x 'ACQUIT_DEV=1' /etc/acquit/runtime.env || true"],
                       text=True, capture_output=True)
if probe.returncode:
    raise SystemExit("could not read the deployed mode")
if probe.stdout.strip() == "ACQUIT_DEV=1":
    code, body = request("/api/dev/clock", "POST")
    assert code == 401 and json.loads(body)["error"] == "UNAUTHENTICATED", f"Dev mode clock route: {code}"
    print(f"{mode} unauthenticated dev route: 401 UNAUTHENTICATED (ACQUIT_DEV=1; the route is on and still wants an app session)")
else:
    code, body = request("/api/dev/clock", "POST")
    assert code == 403 and json.loads(body)["error"] == "DEV_DISABLED", f"Dev route: {code}"
    print(f"{mode} unauthenticated dev route: 403 DEV_DISABLED")
