# Concept: Outcome-as-a-Service marketplace for AI agent operators

## Thesis
SaaS sold tools. Outcome-as-a-Service sells results. You pay when the result is verified, not per seat or per token.

## Product
Clients post jobs. Operators deliver them with specialized AI agents running on the operator's own machine and own AI subscription or API key. Payment sits in PayPal escrow and releases only when a verifier passes.

- The platform never touches operator credentials. Operators are freelancers using their own tools; clients pay for work, not AI usage. (Reselling subscription quota was rejected: Anthropic and OpenAI terms forbid it, and Anthropic and Google banned accounts for proxying quota in 2026.)
- Operator-side runner: a CLI that claims a job, runs Claude Code / Codex in a container, opens a PR, reads CI. Operator reviews and submits each PR (human in the loop).
- Client-side scoping: fork or scoped token, never full repo access.

## Demo vertical
Code. Job = GitHub issue + budget. Verifier = CI green + client approval.

## Job modes (one Job type with a mode field)
- Bounty: client sets price, first passing PR wins.
- Bid: operators pitch with verified track record; client picks; escrow locks to that operator.

## Verifier registry (expansion path, strongest proof first)
Code (CI) → 3D printing (slicer manifold + dimensions, photo + sign-off) → 3D rendering (frames, resolution, logs + sign-off) → motion graphics / video (duration, format + sign-off) → content writing (plagiarism, rubric + sign-off). Vision: hardware operators (GPU farms, printers) earn from idle machines by doing real jobs.

## Moat
Verified receipts: every escrow release is a proof-backed record ("41 fixes, 39 passed CI"), not a subjective review.

## Pricing
15% total: client pays 5% "verified escrow" fee on top; operator pays 10% of earnings.

## Bid credits
Each bid costs 10 Acquit credits. Every operator gets a free weekly allowance of 30 credits, plus 10 per week for each verified receipt, up to 100 per week. Acquit returns the credits if the client cancels the job or does not respond to bids within the review window. Extra credits cost $0.15 each.

Credits are closed-loop. They cannot be cashed out or transferred, and they buy bids on Acquit only. Payouts stay in PayPal escrow, so credits and money never mix. A job exists only after the client funds escrow, so fake jobs cannot drain operator credits.

Credits exist because AI agents make pitches free to generate, so free bids would flood clients. Plain Upwork Connects, paid from the first bid, price out new operators.

## Cold start
Founder runs labeled "House" agents on platform-owned API keys (allowed under Anthropic commercial terms A.1), acting as the quality bar.

## Value prop order
1. Pay only on verified result. 2. Specialized agent setups beat generic. 3. No time needed.

## Payments (PayPal sandbox)
Multiparty delayed disbursement for escrow, platform_fees for the cut, Payouts for operators, Agent Toolkit for refunds. Targets "Best Use of Agentic Commerce".

## Bend2
Escrow ledger written in Bend2 (released 2026-09-17, no HTTPS/DB, no Windows) as a pure library called from a TypeScript server, with proven laws: conservation (payout + fee = paid), no double release, refund XOR payout. TypeScript fallback with property tests. Max one week.

## Hackathon
PayPal AI Hackathon (Devpost), deadline 2026-11-12. Solo founder, full-time, ~5 weeks. Judged on technical implementation, design, impact, innovation, presentation. Needs working demo, public repo, <3 min video.

## First customers
Agencies and non-technical founders with private repos first (decided after the stress test). Open-source maintainers and indie devs later. Known adjacent: Algora (OSS bounties for humans, unverified current state), UpAgents (pay-per-task agent capacity), CreditSwap (local agent selling API capacity), GPT Store.

## Decisions after the three-model stress test (2026-10-05)
- Verifier: platform-controlled CI workflow, test suite frozen at job open, hidden holdout tests, auto-flag diffs touching test/CI paths. Demo centerpiece: agent tampers with a test, verifier rejects, escrow stays held while the operator reworks (3 attempts), then an honest run pays out. Refunds happen only on deadline expiry or exhausted attempts.
- Escrow: job deadlines well under PayPal's 28-day auto-disbursement, refund on timeout. Apply for PayPal partner status now. Label the demo as sandbox.
- Hackathon scope: Bid mode only. Bounty mode deferred (wasted operator compute, PR spam).
- Operators bring API keys billed to themselves (safe default). Subscription use is unresolved under Anthropic terms.
- Bend2 kept with a hard gate: working proof by end of week 2, shown rejecting a double payout on camera in under 20s. Otherwise ship the TypeScript ledger and present Bend2 as roadmap.
- Fee stays 15% split (client 5% + operator 10%) despite Algora's 9%.
- Bids cost Acquit credits (10 per bid) from a free weekly allowance that grows with verified receipts. Free bids would let agents flood clients, and paid-only bids would price out new operators.
- First customers: agencies and non-technical founders with private repos. Get three committed buyers before building much.
- Write an acceptance contract: definition of done, rework limits, review deadline, dispute path.
- Webhook idempotency: duplicate PayPal webhooks produce exactly one payout.
- Check thejobcafe.com (possible direct competitor, unverified).
- Name: Acquit. Tagline "Cleared, then paid."

## Known risks
Sandboxing untrusted repos on operator machines; operator provider rate limits under heavy use; PayPal partner approval for live delayed disbursement; KYC/fraud on payouts.
