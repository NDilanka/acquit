# deploy/

The hosted deployment's configuration, tracked as templates. No secret is ever stored here: the
`PAYPAL_WEBHOOK_ID` value and every key are read from each host's own files at configure time.

| File | What it is |
|---|---|
| `Caddyfile.template` | The TLS and reverse-proxy config. PayPal's `/paypal/webhook` path reaches the API unauthenticated, and the API verifies every delivery's signature against `PAYPAL_WEBHOOK_ID` before it applies anything. The basic-auth gate came down at Close with the operator's explicit OK (decisions.tsv, category `operator-gate-ok`). |
| `runtime.env` | The API's and verifier's systemd environment. `ACQUIT_DEV=1` while the deployment stays in dev mode. |
| `acquit-api.service`, `acquit-verifier.service`, `caddy-restart.conf` | The systemd units and Caddy's restart drop-in. |
| `install.sh` | One-time VM provisioner: packages, Node, Docker, Caddy, images, directories. |
| `configure.sh` | Installs the Caddyfile from the template, the units and env, and activates everything. Reads `paypal-webhook-id` from `/tmp/acquit-deploy/` (staged 0600 by the deploy driver) and the verifier secrets are generated on the VM. There is no auth-hash input since the gate came down. |
| `verify-http.py` | Post-deploy probe: public paths answer 200 without auth, exactly `/paypal/webhook` reaches the API (its signature check refuses an unsigned body), the dev routes stay refused, and the API's privileged reads still refuse a sessionless caller. |
| `verifier-smoke.mjs` | ARM64 Docker subject smoke for the VM. |
| `rules.v4`, `rules.v6` | The VM's iptables dump: 80, 443, 22 open; Oracle's final REJECT kept. |

Deploy procedure: see the mission's `library/vm.md`. The served Caddyfile exists only on the VM at
`/etc/caddy/Caddyfile`, never in a tracked tree.
