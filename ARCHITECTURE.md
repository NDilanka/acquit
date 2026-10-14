# Architecture

Acquit is an outcome marketplace. A client posts a job against a GitHub issue, operators bid, the client funds escrow through PayPal, and the accepted operator's agent delivers a commit. A Docker verifier judges the delivery against the job's frozen contract plus private hidden cases: VERIFIED releases the payout minus the platform fee, and a rejected or timed-out job refunds or reopens.

## Code map

| Path | What it holds |
| --- | --- |
| `apps/api` | The HTTP API: sessions, jobs, bids, funding, webhooks, demo visitors, receipts, and the budgeted model turns. |
| `apps/web` | The React app: the judge entry tour, job pages with checkout and the ledger, the AG Grid tables, the AG Studio dashboards, and the scoping review. |
| `packages/core` | The domain: commands, the ledger, PayPal, per-job manifests, scoping, the model provider switch, the store and outbox. |
| `packages/verifier` | The verifier service: the judge, the Docker subject, and the fixture registry. |
| `packages/runner` | The sandbox image a delivering agent runs inside, with its egress allowlist. |
| `packages/house` | The House: the platform's own operator, delivering with a real model through the same Submit edge. |
| `packages/mcp` | The stdio MCP server over the operator token: jobs, bids, submits, receipts, and payout reads. |
| `packages/acquit-cli` | The operator CLI, including the submit path an agent uses and the confirm-submit handshake. |
| `packages/ctl` | The lane control CLI: start, stop, seed, sweep, and the model-lock recovery. |

## Invariants the code keeps

Money changes only inside `packages/core/src/effects.ts`, which verifies a webhook's PayPal signature before it re-reads and applies anything. `packages/core/src/ledger.ts` keeps payout + fee = paid and webhooks idempotent; `docs/architecture/rationale.md` carries the three ledger laws.

Hidden cases live in a per-deployment private store outside every git repository: on this laptop under ~/.config/acquit/private/, on the VM under /var/lib/acquit/private/ or the /var/lib/acquit/*.json files its registry names. A job's manifest carries only their digest, and the verifier mounts neither the store nor the registry into a subject. The private-store tests read the path from `ACQUIT_PRIVATE_CASES` (default the laptop store) and skip when the store is absent.

Every app model call reads `ACQUIT_MODEL_PROVIDER`: `droid` by default (model glm-5.3-flash), with `openrouter` selectable for the submission.

## Build log

The build's process lives outside the tracked tree: `scratch/` is the prototypes, probes, and lane scripts, and `data/trail/` is the decision log and resume notes. Both are gitignored on purpose; they are the build log, not product code.
