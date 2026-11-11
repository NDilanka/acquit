import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { match } from "./route.ts";

const page = (name: string) => readFileSync(new URL(`./pages/specialists/${name}.tsx`, import.meta.url), "utf8");

test("Activity docks follow live, fallback and replay content in source order", () => {
  const source = page("Activity");
  const live = source.slice(source.indexOf("function LiveActivity"), source.indexOf("function LegacyActivity"));
  const legacy = source.slice(source.indexOf("function LegacyActivity"), source.indexOf("function ReplayActivity"));
  const replay = source.slice(source.indexOf("function ReplayActivity"));
  assert.ok(live.indexOf('className="owner-actions"') > live.indexOf("<ActivityFeed"));
  assert.ok(legacy.indexOf('className="owner-actions"') > legacy.indexOf('className="work-replay-link"'));
  assert.ok(replay.indexOf('className="owner-actions"') > replay.indexOf('className="work-side"'));
});

test("Earnings mounts its single dock after the report and proof controls", () => {
  const source = page("AgentEarnings");
  assert.equal(source.match(/\{actions\}/g)?.length, 1);
  assert.ok(source.indexOf("{actions}") > source.indexOf("<CopyWorkValue value={payout.reference}"));
});

test("Leaderboard docks after rows and their explanation", () => {
  const source = page("Leaderboard").split("\nfunction Board(")[0]!;
  assert.ok(source.indexOf('className="owner-actions"') > source.indexOf('className="board-meaning"'));
});

test("Record docks after both address and meaning controls, including signed-out records", () => {
  const source = page("AgentRecord");
  const denied = source.slice(source.indexOf("if (read.error instanceof"), source.indexOf("if (read.error)"));
  assert.ok(denied.indexOf('className="owner-actions"') > denied.indexOf("<CopyRecordPath"));
  assert.ok(source.lastIndexOf('className="owner-actions"') > source.indexOf('className="record-meaning"'));
});

test("Orders keeps its limits disclosure inline and confirms a saved safe-to-close state", () => {
  const source = page("StandingOrders");
  const sentence = source.slice(source.indexOf('<p className="orders-sentence">'),source.indexOf('<div className="orders-help orders-limits"'));
  assert.match(sentence,/aria-expanded=\{limitsOpen\}/);
  assert.match(sentence,/onClick=\{\(\) => setLimitsOpen\(open => !open\)\}>Change limits<\/button>/);
  assert.match(source,/hidden=\{!limitsOpen\}/);
  assert.match(source,/<p>Saved\. You can close this tab now\.<\/p>/);
  assert.match(source,/PayPal's actual processing fee/);
  assert.doesNotMatch(source,/10%|0\.9|0\.1|netCents/);
});

test("Record puts actual exam checks below the verdict and earnings below the grade, without a work percentage bar", () => {
  const source = page("AgentRecord");
  const left = source.slice(source.indexOf('className="public-exam"'),source.indexOf('className="public-score"'));
  const right = source.slice(source.indexOf('className="public-score"'),source.indexOf('className="public-record-facts"'));
  assert.match(left,/<CheckCells counts=\{counts\.visible\}/);
  assert.match(left,/<CheckCells counts=\{counts\.hidden\}/);
  assert.ok(right.indexOf("Earned") > right.indexOf('className="record-grade"'));
  assert.doesNotMatch(source,/ResultsBar/);
  assert.match(source,/agent\.record\.jobsTaken/);
});

test("owner exploration links follow page content and its actions in natural keyboard order", () => {
  const shell = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");
  const owner = shell.slice(shell.indexOf("function OwnerShell"), shell.indexOf("const HELP_URL"));
  const footerAt = owner.indexOf('<footer className="owner-footer">');
  assert.ok(footerAt > owner.indexOf("</header>"));
  assert.ok(owner.indexOf(": children}") >= 0);
  assert.ok(footerAt > owner.indexOf(": children}"), "page proof controls and docks precede exploration");
  const footer = owner.slice(footerAt);
  assert.match(footer, /<nav aria-label="Explore Acquit">/);
  const links = [...footer.matchAll(/<Link to="([^"]+)">([^<]+)<\/Link>/g)].map(([, to, label]) => ({ to, label }));
  assert.deepEqual(links, [
    { to: "/how-work-is-checked", label: "How work is checked" },
    { to: "/inspect", label: "Try to cheat the checker" },
    { to: "/studio/sample", label: "Ask the ledger" },
    { to: "/tour", label: "Take the tour" },
  ]);
  for (const link of links) assert.notEqual(match(link.to!).name, "notFound", link.to);
  assert.doesNotMatch(owner, /tabIndex=\{?[1-9]/, "no positive tab order overrides");
});

test("owner exploration wraps in normal flow with touch targets and room above the mobile dock", () => {
  const css = readFileSync(new URL("./pages/specialists/owner.css", import.meta.url), "utf8");
  assert.match(css, /\.owner-footer nav \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.owner-footer a \{[^}]*min-height: var\(--control-lg\)/);
  assert.match(css, /\.owner-footer \{ padding-bottom: 160px; \}/);
  const footerRules = css.match(/\.owner-footer(?: nav| a)? \{[^}]*\}/g) ?? [];
  assert.doesNotMatch(footerRules.join("\n"), /\b(?:position|order)\s*:/, "no fixed or reordered footer");
});
