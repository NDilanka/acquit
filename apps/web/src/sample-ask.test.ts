// The sample book's Ask as the web holds it: the sample page asks over the sample scope alone, its tool names mirror the
// server's, its copy names no platform tool, and its panel shows only at the width the chat panel leaves room for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ASK_ROUTE, labelledSampleTurn, OPERATOR_ASK_INSTRUCTIONS, SAMPLE_ANSWER_LABEL, SAMPLE_ASK_INSTRUCTIONS, SAMPLE_ASK_PROMPT_STARTERS, SAMPLE_ASK_TOOL_NAMES, askToolLabel } from "./ask-ledger.ts";

// The platform's and operator's tool names. The sample book's copy must name none of them.
const PLATFORM_TOOL = /\b(platform_totals|list_jobs|get_job|get_order|list_disputes|get_dispute|get_refund|list_transactions|trace_figure|my_jobs|my_job|my_payouts|my_totals)\b/;

test("the Studio's SAMPLE_ASK_TOOL_NAMES is the server's, read from its source", () => {
  const source = readFileSync(new URL("../../api/src/sample-ask.ts", import.meta.url), "utf8");
  const declared = /export const SAMPLE_ASK_TOOL_NAMES = (\[[\s\S]*?\]) as const;/.exec(source);
  assert.ok(declared, "the server declares SAMPLE_ASK_TOOL_NAMES as a literal array");
  assert.deepEqual(JSON.parse(declared[1]!), [...SAMPLE_ASK_TOOL_NAMES]);
});

test("the page's sample label is the server's SAMPLE_LABEL, read from its source", () => {
  const source = readFileSync(new URL("../../api/src/sample-ask.ts", import.meta.url), "utf8");
  const declared = /export const SAMPLE_LABEL = "([^"]*)";/.exec(source);
  assert.ok(declared, "the server declares SAMPLE_LABEL as a literal string");
  assert.equal(SAMPLE_ANSWER_LABEL, declared[1]);
});

test("every sample answer the page shows carries the label, and a turn with no answer text is left as it is", () => {
  assert.equal(labelledSampleTurn({ ok: true, message: "Nothing is held.", calls: [], model: "m", sessionId: null, factoryCredits: null }).message,
    `Nothing is held.\n\n${SAMPLE_ANSWER_LABEL}`, "an unlabelled answer gets the label");
  const labelled = `Held is 320.\n\n${SAMPLE_ANSWER_LABEL}`;
  assert.equal(labelledSampleTurn({ ok: true, message: labelled, calls: [], model: "m", sessionId: null, factoryCredits: null }).message, labelled,
    "a label the answer already carries is not doubled");
  assert.equal(labelledSampleTurn({ ok: true, message: null, calls: [], model: "m", sessionId: null, factoryCredits: null }).message, null,
    "a turn with no answer text has nothing to label");
});

test("a label that sits only inside a code fence does not count, so the page appends the visible label", () => {
  const fenced = "Held is $320.\n\n```" + SAMPLE_ANSWER_LABEL + "\nNot provenance\n```";
  assert.equal(labelledSampleTurn({ ok: true, message: fenced, calls: [], model: "m", sessionId: null, factoryCredits: null }).message,
    `${fenced}\n\n${SAMPLE_ANSWER_LABEL}`, "a fenced label is not the visible label");
  const finalParagraph = `Held is $320.\n\n${SAMPLE_ANSWER_LABEL}`;
  assert.equal(labelledSampleTurn({ ok: true, message: finalParagraph, calls: [], model: "m", sessionId: null, factoryCredits: null }).message, finalParagraph,
    "a label as the final paragraph is kept");
});

test("the sample and operator copy asks for plain words in place of status codes", () => {
  assert.match(SAMPLE_ASK_INSTRUCTIONS, /Never print a status code such as IN_PROGRESS/, "the sample copy forbids status codes");
  assert.match(SAMPLE_ASK_INSTRUCTIONS, /plain words your tools return/, "the sample copy points at the tools' plain words");
  assert.match(OPERATOR_ASK_INSTRUCTIONS, /Never print a status code such as IN_PROGRESS/, "the operator copy forbids status codes");
});

test("a sample turn posts to the sample route alone, and the answer the page shows carries the label", async () => {
  const urls: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, message: "Nothing is held.", calls: [], model: "m", sessionId: null, factoryCredits: null }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const turn = await ASK_ROUTE.SAMPLE.turn({ messages: [{ id: "m1", role: "user", content: "What is held?" }] }, { fetch: fetchStub });
  assert.equal(turn.message, `Nothing is held.\n\n${SAMPLE_ANSWER_LABEL}`);
  assert.deepEqual(urls, ["/api/sample/ask/turn"], "the sample scope's turn rides the sample route only");
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
