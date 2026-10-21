// The operator's Ask the ledger as the web holds it: the earnings page asks on its own dashboard with the
// operator's scope, the tool names mirror the server's, and the operator's copy speaks of its own money only.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPERATOR_ASK_INSTRUCTIONS, OPERATOR_ASK_PROMPT_STARTERS, OPERATOR_ASK_TOOL_NAMES, askToolLabel } from "./ask-ledger.ts";

test("the Studio's OPERATOR_ASK_TOOL_NAMES is the server's, read from its source", () => {
  const source = readFileSync(new URL("../../api/src/ask.ts", import.meta.url), "utf8");
  const declared = /export const OPERATOR_ASK_TOOL_NAMES = (\[[\s\S]*?\]) as const;/.exec(source);
  assert.ok(declared, "the server declares OPERATOR_ASK_TOOL_NAMES as a literal array");
  assert.deepEqual(JSON.parse(declared[1]!), [...OPERATOR_ASK_TOOL_NAMES]);
});

test("the earnings page asks on its own dashboard as the operator, and the escrow page asks as the platform", () => {
  const page = readFileSync(new URL("./studio/StudioPage.tsx", import.meta.url), "utf8");
  // A top-level function ends at its column-zero brace; the line ending is CRLF on Windows checkouts.
  const earnings = /function EarningsDashboard\b[\s\S]*?\r?\n\}\r?\n/.exec(page)?.[0] ?? "";
  const escrow = /function EscrowDashboard\b[\s\S]*?\r?\n\}\r?\n/.exec(page)?.[0] ?? "";
  assert.ok(earnings.length > 0 && escrow.length > 0, "both dashboards are declared in the page");
  assert.match(earnings, /useAskLedger\("earnings", "OPERATOR"\)/, "the earnings page builds its ask for the operator's scope");
  assert.match(earnings, /ask=\{ask\}/, "the earnings page hands its ask to the dashboard's panel");
  assert.match(escrow, /useAskLedger\("escrow"\)/, "the escrow page keeps the platform's ask");
});

test("the operator's copy speaks of its own money, and no starter asks about the whole book", () => {
  assert.match(OPERATOR_ASK_INSTRUCTIONS, /operator's own jobs/);
  assert.doesNotMatch(OPERATOR_ASK_INSTRUCTIONS, /platform|all operators|every operator|across/i);
  assert.ok(OPERATOR_ASK_PROMPT_STARTERS.length > 0);
  for (const starter of OPERATOR_ASK_PROMPT_STARTERS) {
    assert.doesNotMatch(starter.prompt, /platform|all operators|every operator|escrow book|PayPal/i, `${starter.label} asks about the operator's own money`);
  }
});

test("the operator's tool rows are worded for the operator's own reads", () => {
  assert.equal(askToolLabel("my_jobs", {}), "Reading your jobs");
  assert.equal(askToolLabel("my_job", { jobId: "job_1" }), "Reading your job job_1");
});
