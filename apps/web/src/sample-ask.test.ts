// The sample book's Ask as the web holds it: the sample page asks over the sample scope alone, its tool names mirror the
// server's, its copy names no platform tool, and its panel shows only at the width the chat panel leaves room for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SAMPLE_ASK_INSTRUCTIONS, SAMPLE_ASK_PROMPT_STARTERS, SAMPLE_ASK_TOOL_NAMES, askToolLabel } from "./ask-ledger.ts";

// The platform's and operator's tool names. The sample book's copy must name none of them.
const PLATFORM_TOOL = /\b(platform_totals|list_jobs|get_job|get_order|list_disputes|get_dispute|get_refund|list_transactions|trace_figure|my_jobs|my_job|my_payouts|my_totals)\b/;

test("the Studio's SAMPLE_ASK_TOOL_NAMES is the server's, read from its source", () => {
  const source = readFileSync(new URL("../../api/src/sample-ask.ts", import.meta.url), "utf8");
  const declared = /export const SAMPLE_ASK_TOOL_NAMES = (\[[\s\S]*?\]) as const;/.exec(source);
  assert.ok(declared, "the server declares SAMPLE_ASK_TOOL_NAMES as a literal array");
  assert.deepEqual(JSON.parse(declared[1]!), [...SAMPLE_ASK_TOOL_NAMES]);
});

test("the sample page asks over the sample scope, and shows its panel only at the wide width", () => {
  const page = readFileSync(new URL("./studio/StudioPage.tsx", import.meta.url), "utf8");
  // A top-level function ends at its column-zero brace; the line ending is CRLF on Windows checkouts.
  const sample = /function SampleDashboard\b[\s\S]*?\r?\n\}\r?\n/.exec(page)?.[0] ?? "";
  assert.ok(sample.length > 0, "the sample dashboard is declared in the page");
  assert.match(sample, /useAskLedger\("sample", "SAMPLE"\)/, "the sample page builds its ask for the sample scope");
  assert.match(sample, /ask=\{wide \? ask : undefined\}/, "the sample page hands its ask to the panel only at the wide width");
  assert.match(page, /const WIDE = "\(min-width: 1200px\)";/, "the panel's width is 1200 pixels and wider");
  // The escrow and earnings pages keep their own asks.
  assert.match(page, /useAskLedger\("escrow"\)/, "the escrow page keeps the platform's ask");
  assert.match(page, /useAskLedger\("earnings", "OPERATOR"\)/, "the earnings page keeps the operator's ask");
});

test("the sample book's copy names no platform tool, and its starters and labels are worded for the sample book", () => {
  assert.doesNotMatch(SAMPLE_ASK_INSTRUCTIONS, PLATFORM_TOOL, "the sample instructions name no platform tool");
  assert.match(SAMPLE_ASK_INSTRUCTIONS, /simulated sample data/i, "the sample instructions call the book simulated sample data");
  assert.ok(SAMPLE_ASK_PROMPT_STARTERS.length >= 2, "the sample page offers two or more starters");
  for (const starter of SAMPLE_ASK_PROMPT_STARTERS) {
    assert.doesNotMatch(starter.prompt, PLATFORM_TOOL, `${starter.label} names no platform tool`);
    assert.doesNotMatch(starter.label, /demo|guest|visitor|judge/i, `${starter.label} carries no forbidden word`);
    assert.match(starter.prompt, /sample/i, `${starter.label} asks about the sample book`);
  }
  for (const name of SAMPLE_ASK_TOOL_NAMES) {
    const label = askToolLabel(name, { jobId: "job_sample01", figure: "held" });
    assert.match(label, /sample/i, `${name} is worded as a sample read`);
    assert.doesNotMatch(label, /demo|guest|visitor|judge/i, `${name} carries no forbidden word`);
  }
});
