import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataEngine, type AgDataSourcesDefinition, type AgStudioQuery } from "ag-studio";

// The page hands Studio a fresh sources definition on each change; Studio passes it to engine.update({ sources }).
// These tests pin what that update does on the engine itself: it replaces the rows of each source it names,
// leaves an omitted source as it was, and refuses an id the engine does not hold.

const count = (sourceId: string, fieldId: string, as: string) =>
  ({ field: { key: `${sourceId}.${fieldId}:count`, sourceId, fieldId: `${sourceId}.${fieldId}`, aggregation: "count" }, as });
const sum = (sourceId: string, fieldId: string, as: string) =>
  ({ field: { key: `${sourceId}.${fieldId}:sum`, sourceId, fieldId: `${sourceId}.${fieldId}`, aggregation: "sum" }, as });

function definition(jobs: readonly object[]): AgDataSourcesDefinition {
  return {
    sources: [
      {
        id: "jobs",
        name: "Jobs",
        data: jobs,
        fields: [{ id: "jobId", format: "textFormat" }, { id: "held", format: "currencyFormat" }],
      },
      {
        id: "bids",
        name: "Bids",
        data: [{ bidId: "B1", price: 5 }],
        fields: [{ id: "bidId", format: "textFormat" }, { id: "price", format: "currencyFormat" }],
      },
    ],
  } as unknown as AgDataSourcesDefinition;
}

const TWO_JOBS = [{ jobId: "J1", held: 100 }, { jobId: "J2", held: 50 }];

async function read(engine: ReturnType<typeof createDataEngine>, measure: object): Promise<Record<string, unknown>> {
  const [result] = await engine.execute({ query: { measures: [measure] } as unknown as AgStudioQuery, options: { strict: false } });
  if (result?.dataShape !== "rows") throw new Error("expected rows");
  return result.rows[0] ?? {};
}

test("an update replaces the rows of the source it names, so two jobs become one with its own held figure", async () => {
  const engine = createDataEngine(definition(TWO_JOBS));
  assert.ok(engine.finalize && engine.dispose && engine.update, "the engine exposes its lifecycle and update hooks");
  engine.finalize();
  try {
    assert.deepEqual(await read(engine, count("jobs", "jobId", "n")), { n: 2 });
    assert.deepEqual(await read(engine, sum("jobs", "held", "held")), { held: 150 });

    engine.update({ sources: [{ id: "jobs", name: "Jobs", data: [{ jobId: "J3", held: 999 }] }] });

    assert.deepEqual(await read(engine, count("jobs", "jobId", "n")), { n: 1 });
    assert.deepEqual(await read(engine, sum("jobs", "held", "held")), { held: 999 });
  } finally {
    engine.dispose();
  }
});

test("a source the update omits keeps its rows", async () => {
  const engine = createDataEngine(definition(TWO_JOBS));
  assert.ok(engine.finalize && engine.dispose && engine.update, "the engine exposes its lifecycle and update hooks");
  engine.finalize();
  try {
    engine.update({ sources: [{ id: "jobs", name: "Jobs", data: [{ jobId: "J3", held: 999 }] }] });
    assert.deepEqual(await read(engine, sum("bids", "price", "price")), { price: 5 });
  } finally {
    engine.dispose();
  }
});

test("an update naming an id the engine does not hold changes no source and raises one validation issue", async () => {
  const engine = createDataEngine(definition(TWO_JOBS));
  assert.ok(engine.finalize && engine.dispose && engine.update && engine.addEventListener, "the engine exposes its lifecycle, update, and validation hooks");
  const issues: unknown[] = [];
  engine.addEventListener("validation", (event) => issues.push((event as unknown as { issues: unknown }).issues));
  engine.finalize();
  try {
    engine.update({ sources: [{ id: "nope", name: "Nope", data: [{ x: 1 }] }] });
    assert.deepEqual(await read(engine, sum("jobs", "held", "held")), { held: 150 });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0], [{ key: "validationInvalidReactiveUpdate", variableValues: { sourceId: "nope" } }]);
  } finally {
    engine.dispose();
  }
});
