# deploy/

The hosted deployment's configuration, tracked as templates. No secret is ever stored here: the
Caddy bcrypt hash, the `PAYPAL_WEBHOOK_ID` value, and every key are read from each host's own
files at configure time.

| File | What it is |
|---|---|
| `Caddyfile.template` | The TLS, basic-auth gate, and reverse-proxy config. `AUTH_HASH` is a placeholder; the template is the only place the `/paypal/webhook` exemption is written down. |
| `runtime.env` | The API's and verifier's systemd environment. `ACQUIT_DEV=1` while the deployment stays in dev mode. |
| `acquit-api.service`, `acquit-verifier.service`, `caddy-restart.conf` | The systemd units and Caddy's restart drop-in. |
| `install.sh` | One-time VM provisioner: packages, Node, Docker, Caddy, images, directories. |
| `configure.sh` | Renders the Caddyfile from the template, installs the units and env, and activates everything. Reads `auth-hash` and `paypal-webhook-id` from `/tmp/acquit-deploy/` (staged 0600 by the deploy driver) and the verifier secrets are generated on the VM. |
| `provision-auth.py` | Host side: hashes the gate password from `~/.config/acquit/vm-basic-auth` on the VM and stages it at `/tmp/acquit-deploy-host/auth-hash` (mode 0600). |
| `verify-http.py` | Post-deploy probe: every gated path answers 401 without auth, exactly `/paypal/webhook` reaches the API, and the dev routes stay refused. |
| `verifier-smoke.mjs` | ARM64 Docker subject smoke for the VM. |
| `rules.v4`, `rules.v6` | The VM's iptables dump: 80, 443, 22 open; Oracle's final REJECT kept. |

Deploy procedure: see the mission's `library/vm.md`. The rendered Caddyfile (hash inside) exists
only on the VM at `/etc/caddy/Caddyfile`, never in a tracked tree.
