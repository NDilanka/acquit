import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { JobPayPalCheck, JobView } from "./api-types.ts";
import { payPalCheckLine, readJobPayPalCheck, wantsPayPalCheck } from "./job-paypal-check.ts";
import type { Viewer } from "./job-timeline.ts";

const check = (over: Partial<JobPayPalCheck> = {}): JobPayPalCheck => ({
  orderId: "8ABCDEF1234",
  checkedAt: "2026-10-11T08:01:00.000Z",
  outcome: "HELD",
  heldValue: "420.00",
  heldCurrency: "USD",
  ...over,
});

const OWNER: Viewer = { role: "CLIENT", handle: "ada" };
const OTHER_CLIENT: Viewer = { role: "CLIENT", handle: "grace" };
const BIDDER: Viewer = { role: "OPERATOR", handle: "devon" };
const HOUSE: Viewer = { role: "OPERATOR", handle: "house-tsfix" };
const OTHER_OPERATOR: Viewer = { role: "OPERATOR", handle: "noa" };
const PLATFORM: Viewer = { role: "PLATFORM", handle: "studio" };

const held = {
  client: "ada",
  ledger: [{ kind: "HELD", cents: 42000, at: "2026-10-11T08:00:00.000Z" }],
  bids: { operators: [{ handle: "devon" }], house: { handle: "house-tsfix" } },
} as unknown as Pick<JobView, "client" | "bids" | "ledger">;

/** A fetch stand-in that answers one status and body, and records each request it was asked for. */
function answering(status: number, body: unknown, asked: string[]): typeof fetch {
  return (async (path: string, init?: RequestInit) => {
    asked.push(`${init?.method} ${path}`);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("a held payment's line names the stored amount, a short order reference, and the sandbox", () => {
  assert.equal(payPalCheckLine(check()), "PayPal confirms 420.00 USD is held · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(check({ heldValue: "0.10" })), "PayPal confirms 0.10 USD is held · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(check({ heldCurrency: "EUR", heldValue: "37.50" })), "PayPal confirms EUR 37.50 is held · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(check({ heldValue: null, heldCurrency: null })), "PayPal confirms this money is held · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(check({ heldValue: "not a number" })), "PayPal confirms this money is held · order 8AB… · PayPal sandbox");
});

test("a check that does not confirm the money, or could not be read, says so plainly", () => {
  assert.equal(payPalCheckLine(check({ outcome: "NOT_HELD", heldValue: null, heldCurrency: null })), "PayPal does not confirm this money is held · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(check({ outcome: "UNAVAILABLE", heldValue: null, heldCurrency: null })), "PayPal's check is unavailable · order 8AB… · PayPal sandbox");
  assert.equal(payPalCheckLine(null), null);
});

test("the line never shows PayPal's status names or more of the order id", () => {
  for (const outcome of ["HELD", "NOT_HELD", "UNAVAILABLE"] as const) {
    const line = payPalCheckLine(check({ outcome }));
    assert.ok(line);
    assert.doesNotMatch(line, /COMPLETED|APPROVED|CAPTURE|ORDER_|8ABCDEF|1234/);
  }
});

test("the owning client and the operators who bid ask for the check while the money is held", () => {
  assert.equal(wantsPayPalCheck(held, OWNER), true);
  assert.equal(wantsPayPalCheck(held, BIDDER), true);
  assert.equal(wantsPayPalCheck(held, HOUSE), true);
});

test("nobody else asks: other clients, other operators, the platform, and signed-out viewers", () => {
  for (const viewer of [OTHER_CLIENT, OTHER_OPERATOR, PLATFORM, null]) {
    assert.equal(wantsPayPalCheck(held, viewer), false);
  }
});

test("nothing is asked before money is held", () => {
  assert.equal(wantsPayPalCheck({ ...held, ledger: [] }, OWNER), false);
  assert.equal(wantsPayPalCheck({ ...held, ledger: [] }, BIDDER), false);
});

test("the page reads the stored check from the job's route", async () => {
  const asked: string[] = [];
  const found = await readJobPayPalCheck("job_0001", { fetch: answering(200, { check: check() }, asked) });
  assert.deepEqual(found, check());
  assert.deepEqual(asked, ["GET /api/jobs/job_0001/paypal-check"]);
});

test("a pending check, a refused read, and a failed read all leave the page with nothing", async () => {
  const asked: string[] = [];
  assert.equal(await readJobPayPalCheck("job_0001", { fetch: answering(200, { check: null }, asked) }), null);
  assert.equal(await readJobPayPalCheck("job_0001", { fetch: answering(403, { error: "NOT_OWNER" }, asked) }), null);
  assert.equal(await readJobPayPalCheck("job_0001", { fetch: answering(500, { error: "INTERNAL" }, asked) }), null);
  const broken = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.equal(await readJobPayPalCheck("job_0001", { fetch: broken }), null);
  assert.equal(asked.length, 3);
});

test("the job page asks for the check before its early returns, and draws the line into the timeline", () => {
  const source = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");
  const hook = source.indexOf("usePayPalCheck(job,");
  assert.ok(hook > 0 && hook < source.indexOf("if (!job) return"));
  assert.match(source, /timelineEvents\(timeline, paypalLine\)/);
});
