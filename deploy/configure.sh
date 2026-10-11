#!/usr/bin/env bash
# Renders and installs the deployment's configuration, then activates the units.
# Every secret is read at configure time from a file the deploy driver staged 0600 under
# /tmp/acquit-deploy, or is generated on this host. The tracked templates hold no secret:
#   auth-hash            the gate's bcrypt hash, from the host's `caddy hash-password`
#   paypal-webhook-id    the sandbox webhook's id, from the host's .env
set -euo pipefail
STAGE=/tmp/acquit-deploy

for file in acquit-api.service acquit-verifier.service; do
  sudo install -m 0644 "$STAGE/$file" "/etc/systemd/system/$file"
done
sudo install -d -m 0755 /etc/systemd/system/caddy.service.d
sudo install -m 0644 "$STAGE/caddy-restart.conf" /etc/systemd/system/caddy.service.d/restart.conf
sudo install -m 0600 "$STAGE/runtime.env" /etc/acquit/runtime.env

# The gate's hash exists only in the rendered file, which never returns to a tracked tree.
AUTH_HASH=$(cat "$STAGE/auth-hash")
sed "s|AUTH_HASH|$AUTH_HASH|" "$STAGE/Caddyfile.template" > "$STAGE/Caddyfile.rendered"
chmod 0600 "$STAGE/Caddyfile.rendered"
sudo install -m 0644 "$STAGE/Caddyfile.rendered" /etc/caddy/Caddyfile
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# The sandbox webhook id joins the deployment's .env once. Its value is never printed.
if ! grep -q '^PAYPAL_WEBHOOK_ID=' /opt/acquit/.env; then
  printf 'PAYPAL_WEBHOOK_ID=%s\n' "$(cat "$STAGE/paypal-webhook-id")" >> /opt/acquit/.env
fi
chmod 0600 /opt/acquit/.env

# Shared secrets reach systemd directly. Nothing prints or copies their values locally.
sudo python3 - <<'PY'
from pathlib import Path
import secrets, os
p = Path('/etc/acquit/verifier-secrets.env')
if not p.exists():
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        for name in ['ACQUIT_VERIFIER_RUN_SECRET', 'ACQUIT_VERIFIER_CALLBACK_SECRET']:
            f.write(name + '=' + secrets.token_hex(32) + '\n')
PY

# This is a new deployment, never reset an existing database on a later rerun.
if [ ! -f /var/lib/acquit/acquit.db ]; then
  sudo systemd-run --quiet --wait --pipe --unit=acquit-seed \
    --property=User=ubuntu --property=Group=ubuntu \
    --property=UMask=0077 \
    --property=WorkingDirectory=/opt/acquit \
    --property=EnvironmentFile=/etc/acquit/runtime.env \
    --property=EnvironmentFile=/etc/acquit/verifier-secrets.env \
    /usr/bin/node scripts/seed.ts
fi
sudo chmod 0600 /var/lib/acquit/acquit.db

# Put the allow rules ahead of Oracle's final INPUT REJECT, persist on reboot.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  fi
done
sudo netfilter-persistent save
sudo systemctl daemon-reload
sudo systemctl enable --now acquit-verifier.service acquit-api.service caddy.service
# An update deploy re-reads its configuration: the units restart, Caddy reloads the rendered file.
sudo systemctl restart acquit-verifier.service acquit-api.service
sudo systemctl reload caddy || sudo systemctl restart caddy
printf '%s\n' 'Deployment configured and units active.'
