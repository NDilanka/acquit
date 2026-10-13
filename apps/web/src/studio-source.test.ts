import assert from "node:assert/strict";
import { test } from "node:test";
import { STUDIO_EARNINGS_DATA, STUDIO_ESCROW_DATA } from "./studio-source.ts";

type SourceSchema = {
  readonly id: string;
  readonly data: readonly unknown[];
  readonly fields?: readonly { readonly id: string; readonly format: string }[];
};

function acquitSource(data: { readonly sources: readonly SourceSchema[] }): SourceSchema {
  assert.equal(data.sources.length, 1);
  const [source] = data.sources;
  assert.ok(source);
  return source;
}

const FORMATS = new Set([
  "integerFormat",
  "decimalFormat",
  "percentageFormat",
  "currencyFormat",
  "textFormat",
  "dateFormat",
  "dateTimeFormat",
  "booleanFormat",
]);

test("the escrow dashboard's acquit source declares the ledger columns its widgets read", () => {
  const source = acquitSource(STUDIO_ESCROW_DATA as { readonly sources: readonly SourceSchema[] });
  assert.equal(source.id, "acquit");
  assert.deepEqual(source.data, []);
  assert.deepEqual(
    (source.fields ?? []).map((field) => field.id).sort(),
    ["client", "escrow", "jobId", "paidCents", "status", "tenant", "title"],
  );
});

test("the earnings dashboard's acquit source declares the receipt and payout columns its widgets read", () => {
  const source = acquitSource(STUDIO_EARNINGS_DATA as { readonly sources: readonly SourceSchema[] });
  assert.equal(source.id, "acquit");
  assert.deepEqual(source.data, []);
  assert.deepEqual(
    (source.fields ?? []).map((field) => field.id).sort(),
    ["fee", "grossPaid", "id", "jobId", "paid", "payoutItemId", "releasedAt", "result"],
  );
});

test("every declared studio field carries a built-in format so the schema validates", () => {
  for (const data of [STUDIO_ESCROW_DATA, STUDIO_EARNINGS_DATA]) {
    for (const field of acquitSource(data as { readonly sources: readonly SourceSchema[] }).fields ?? []) {
      assert.ok(FORMATS.has(field.format), `field '${field.id}' declares format '${field.format}'`);
    }
  }
});
