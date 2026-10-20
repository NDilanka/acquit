# deploy/

The hosted deployment's configuration, tracked as templates. No secret is ever stored here: the
`PAYPAL_WEBHOOK_ID` value and every key are read from each host's own files at configure time.

| File | What it is |
|---|---|
| `Caddyfile.template` | The TLS and reverse-proxy config. PayPal's `/paypal/webhook` path reaches the API unauthenticated, and the API verifies every delivery's signature against `PAYPAL_WEBHOOK_ID` before it applies anything. The basic-auth gate came down at Close with the operator's explicit OK (decisions.tsv, category `operator-gate-ok`). |
| `runtime.env` | The API's and verifier's systemd environment, as a template. It still carries the P1-era `ACQUIT_DEV=1`; the hosted VM runs in public mode, and `configure.sh` installs whatever `runtime.env` the deploy staged in `/tmp/acquit-deploy/` (recent deploys staged the VM's live file). |
| `acquit-api.service`, `acquit-verifier.service`, `caddy-restart.conf` | The systemd units and Caddy's restart drop-in. The API unit pins the House state root (`XDG_STATE_HOME=/var/lib/acquit/house-state`) and grants the Docker socket inside the `ProtectHome`/`ProtectSystem` hardening. |
| `install.sh` | One-time VM provisioner: packages, Node, Docker, Caddy, images, directories. |
| `configure.sh` | Installs the Caddyfile from the template, the units and env, and activates everything. Reads `paypal-webhook-id` from `/tmp/acquit-deploy/` (staged 0600 by the deploy driver) and the verifier secrets are generated on the VM. There is no auth-hash input since the gate came down. |
| `verify-http.py` | Post-deploy probe: public paths answer 200 without auth, exactly `/paypal/webhook` reaches the API (its signature check refuses an unsigned body), the dev routes stay refused, and the API's privileged reads still refuse a sessionless caller. |
| `verifier-smoke.mjs` | ARM64 Docker subject smoke for the VM. |
| `rules.v4`, `rules.v6` | The VM's iptables dump: 80, 443, 22 open; Oracle's final REJECT kept. |

## Demo address allowlist

`ACQUIT_DEMO_ALLOW_IPS` in `/etc/acquit/runtime.env` names the client addresses that may start a demo, comma-separated. Unset or
empty opens the demo to everyone, which is how it reverses. The value is never committed: set it on the VM only, then restart
`acquit-api.service`. Caddy's `header_up X-Forwarded-For {remote_host}` supplies the address the API compares.

`configure.sh` installs the staged `runtime.env` over `/etc/acquit/runtime.env`. A staged copy that lacks the line drops the
allowlist and opens the demo, so check the line in `/etc/acquit/runtime.env` after every deploy.

The step-by-step deploy procedure lives in the build's mission notes, outside this repository. The served Caddyfile exists only on the VM at
`/etc/caddy/Caddyfile`, never in a tracked tree.
