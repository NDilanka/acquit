#!/usr/bin/env python3
"""Stage the gate's bcrypt hash for configure.sh, never printing password or hash.

The password lives on this host in ~/.config/acquit/vm-basic-auth (mode 0600). Caddy's hasher
runs on the VM over ssh with the password on stdin; the hash lands in a 0600 file the deploy
driver copies to the VM's /tmp/acquit-deploy/auth-hash. No rendered Caddyfile is kept here.
"""
from pathlib import Path
import os
import subprocess
import sys

stage = Path("/tmp/acquit-deploy-host")
stage.mkdir(mode=0o700, exist_ok=True)
password_file = Path.home() / ".config/acquit/vm-basic-auth"
if not password_file.exists():
    raise SystemExit("No basic-auth password at ~/.config/acquit/vm-basic-auth; provision it first.")
os.chmod(password_file, 0o600)
password = password_file.read_text().strip()
assert password and all(char.isalnum() or char in "-_" for char in password)
command = [
    "ssh", "-i", str(Path.home() / ".ssh/id_ed25519_acquit_vm"),
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "ubuntu@80.225.220.230", "sudo caddy hash-password",
]
result = subprocess.run(command, input=password + "\n", text=True, capture_output=True)
assert result.returncode == 0, "Caddy password hashing failed; output suppressed"
hashed = result.stdout.strip()
assert hashed.startswith("$2") and "\n" not in hashed, "Unexpected hash format"
os.chmod(stage, 0o700)
hash_file = stage / "auth-hash"
fd = os.open(hash_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.write(hashed + "\n")
print(f"Hash staged at {hash_file} (mode 0600); copy it to the VM's /tmp/acquit-deploy/auth-hash.")
if len(sys.argv) > 1 and sys.argv[1] == "--webhook-id":
    print("Stage the sandbox webhook id separately: /tmp/acquit-deploy-host/paypal-webhook-id.")
