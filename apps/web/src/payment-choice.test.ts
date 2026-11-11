import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FundingMode } from "./api-types";
import { api, ApiError } from "./api.ts";
import { PAYMENT_BOUND, PAYMENT_OPTIONS, PaymentChoice, paymentAcceptLabel, paymentChoiceFailure, paymentChoiceState } from "./payment-choice.ts";
import { pollInterval } from "./poll.ts";

const job = { status: "OPEN", phase: "BIDDING", client: "visitor-client" } as const;
const viewer = { user: { role: "CLIENT", handle: "visitor-client" }, account: { client: "visitor-client" } } as const;
const props = { job, viewer, value: "card" as FundingMode, busy: false, locked: false, onChange: (_mode: FundingMode) => {} };
const page = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");

test("only the visitor's own open bidding job offers payment choices", () => {
  assert.equal(paymentChoiceState(job, viewer), "ready");
  for (const other of [
    { ...viewer, account: null },
    { ...viewer, account: { client: "another-client" } },
    { ...viewer, user: { role: "OPERATOR" as const, handle: "visitor-client" } },
    { ...viewer, user: { role: "PLATFORM" as const, handle: "visitor-client" } },
  ]) {
    assert.equal(paymentChoiceState(job, other), "hidden");
    assert.equal(renderToStaticMarkup(PaymentChoice({ ...props, viewer: other })), "");
  }
  assert.equal(paymentChoiceState({ ...job, client: "another-client" }, viewer), "hidden");
  assert.equal(paymentChoiceState({ ...job, client: null }, viewer), "hidden");
});

test("test card is selected by the saved server default, with plain sandbox copy", () => {
  const html = renderToStaticMarkup(PaymentChoice(props));
  assert.match(html, /<legend>PayPal sandbox<\/legend>/);
  assert.match(html, /<input(?=[^>]*value="card")(?=[^>]*checked="")/);
  assert.doesNotMatch(html, /<input(?=[^>]*value="checkout")(?=[^>]*checked="")/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.match(html, /No PayPal account needed\. Pays instantly\./);
  assert.equal(PAYMENT_OPTIONS[1]!.label, "PayPal sandbox account");
  assert.equal(PAYMENT_OPTIONS[1]!.detail, "You will be sent to PayPal's sandbox to log in and approve, then returned here.");
  assert.doesNotMatch(JSON.stringify(PAYMENT_OPTIONS), /\bauthoriz/i);
});

test("bound jobs retain a disabled choice rather than offering a second payment", () => {
  for (const bound of [{ ...job, phase: "FUNDING" as const }, { ...job, status: "PAID" as const, phase: "PAID" as const }]) {
    assert.equal(paymentChoiceState(bound, viewer), "bound");
    const html = renderToStaticMarkup(PaymentChoice({ ...props, job: bound }));
    assert.match(html, /<fieldset[^>]*disabled=""/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
    assert.equal((html.match(/<input[^>]*disabled=""/g) ?? []).length, 2);
  }
});

test("saving, accepting, and server refusal disable the native radio fieldset", () => {
  for (const disabled of [{ busy: true }, { locked: true }]) {
    const html = renderToStaticMarkup(PaymentChoice({ ...props, ...disabled }));
    assert.match(html, /<fieldset[^>]*disabled=""/);
    assert.equal((html.match(/<input[^>]*disabled=""/g) ?? []).length, 2);
  }
  assert.doesNotMatch(renderToStaticMarkup(PaymentChoice(props)), /<fieldset[^>]*disabled/);
});

for (const mode of ["checkout", "card"] as const) {
  test(`choosing ${mode} posts the exact job route and body, then changes the selected choice and primary label`, async () => {
    let saved: FundingMode = mode === "card" ? "checkout" : "card";
    const before = saved;
    let pending: Promise<void> | undefined;
    const calls: { path: string; method?: string; body: unknown; credentials?: RequestCredentials }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      calls.push({ path: String(input), method: init?.method, body: JSON.parse(String(init?.body)), credentials: init?.credentials });
      return new Response(JSON.stringify({ mode }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const fieldset: ReactElement<{ className: string; disabled: boolean; children?: ReactNode }> = PaymentChoice({ ...props, value: saved, onChange: next => {
      pending = api.chooseJobFunding("job 1", next, { fetch: fetchStub }).then(response => { saved = response.mode; });
    } })!;
    const labels = Children.toArray(fieldset.props.children).filter(child => isValidElement<{ children: ReactNode }>(child) && child.type === "label") as ReactElement<{ children: ReactNode }>[];
    const radios = labels.flatMap(label => Children.toArray(label.props.children))
      .filter(child => isValidElement(child) && child.type === "input") as ReactElement<{ value: FundingMode; onChange: () => void }>[];
    radios.find(radio => radio.props.value === mode)!.props.onChange();
    assert.equal(saved, before, "the old acknowledged mode stays selected until the POST succeeds");
    assert.ok(pending);
    await pending;
    assert.deepEqual(calls, [{ path: "/api/jobs/job%201/funding", method: "POST", body: { mode }, credentials: "same-origin" }]);
    assert.equal(saved, mode);
    const html = renderToStaticMarkup(PaymentChoice({ ...props, value: saved }));
    assert.match(html, new RegExp(`<input(?=[^>]*value="${mode}")(?=[^>]*checked="")`));
    assert.equal(paymentAcceptLabel(saved), mode === "card" ? "Accept and pay with the test card" : "Accept and pay with PayPal");
  });
}

for (const denied of [
  { status: 403, code: "NOT_VISITOR_JOB", message: "Only the client who opened this job can change how it is paid." },
  { status: 409, code: "FUNDING_BOUND", message: PAYMENT_BOUND },
]) {
  test(`${denied.status} ${denied.code} has plain copy and locks the choice`, async () => {
    const fetchStub: typeof fetch = async () => new Response(JSON.stringify({ error: denied.code }), { status: denied.status });
    await assert.rejects(api.chooseJobFunding("job-1", "checkout", { fetch: fetchStub }), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, denied.status);
      assert.equal(error.code, denied.code);
      const failure = paymentChoiceFailure(error);
      assert.deepEqual(failure, { message: denied.message, locked: true });
      assert.match(renderToStaticMarkup(PaymentChoice({ ...props, locked: failure.locked })), /<fieldset[^>]*disabled=""/);
      return true;
    });
  });
}

test("a transport or job-version failure can retry without exposing internal error details", () => {
  for (const error of [new Error("private network detail"), new ApiError(409, "JOB_CHANGED", "internal detail")]) {
    assert.deepEqual(paymentChoiceFailure(error), { message: "We couldn't save your payment choice. Try again.", locked: false });
  }
});

test("the accept dialog uses the shared focus-trapping Modal and wraps its mobile primary label", () => {
  const start = page.indexOf("{confirm && (");
  const end = page.indexOf("</Modal>", start);
  assert.ok(start >= 0 && end > start);
  const dialog = page.slice(start, end);
  assert.match(dialog, /<Modal\b/);
  assert.match(dialog, /onClose=\{closeAccept\}/);
  assert.match(dialog, /<PaymentChoice\b/);
  assert.match(dialog, /disabled=\{paymentDisabled\}/);
  assert.match(dialog, /paymentAcceptLabel\(source\)/);
  assert.doesNotMatch(dialog, /className="scrim"/);
  const css = readFileSync(new URL("./payment-choice.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-columns: 20px minmax\(0, 1fr\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /\.payment-accept \{ max-width: 100%; white-space: normal;/);
});

test("accept cannot overtake a save or use an unsaved/failed choice, and stale polls cannot replace its acknowledgement", () => {
  assert.match(page, /const source: FundingMode = job\.funding \?\? fundingMode/);
  assert.match(page, /const paymentDisabled = paymentBusy \|\| accept\.busy \|\| paymentBound \|\| paymentError !== null/);
  assert.match(page, /if \(paymentPending\.current \|\| paymentDisabled \|\| !isClient \|\| !bidding\) return;[\s\S]*?accept\.send/);
  assert.match(page, /await api\.chooseJobFunding\(job\.id, mode\);[\s\S]*?funding: saved\.mode/);
  assert.match(page, /const revision = paymentRevision\.current;[\s\S]*?await api\.job\(id\);[\s\S]*?if \(revision !== paymentRevision\.current\) return null;[\s\S]*?setJob\(r\.job\)/);
  assert.equal((page.match(/paymentRevision\.current\+\+/g) ?? []).length, 3);
  assert.match(page, /setJob\(\{ \.\.\.outcome\.result\.job, funding: source \}\)/);
  assert.match(page, /Retry payment choice/);
});

test("PayPal approval redirect, return retry, and AWAITING_APPROVAL resume paths stay connected", () => {
  assert.match(page, /if \(checkout && job\?\.approveUrl\) window\.location\.assign\(job\.approveUrl\)/);
  assert.match(page, /job\.status === "OPEN" && \(checkout \|\| \(funding && isClient\)\)/);
  assert.match(page, /phase === "AWAITING_APPROVAL" && job\.approveUrl/);
  assert.match(page, /href=\{job\.approveUrl\}[\s\S]*?Resume PayPal checkout/);
  assert.match(page, /location\.search\.get\("funding"\) === "retry"/);
  assert.match(page, /\/paypal\/return\?jobId=\$\{encodeURIComponent\(job\.id\)\}/);
  assert.equal(pollInterval({ status: "OPEN", phase: "FUNDING", merge: null }, { awaitingOrder: true }), 1000);
  assert.equal(pollInterval({ status: "OPEN", phase: "FUNDING", merge: null }, { awaitingOrder: false }), 4000);
});
