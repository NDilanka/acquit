import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dockerSubject } from "/opt/acquit/packages/verifier/subject.ts";

const tree = mkdtempSync("/tmp/acquit-deploy-smoke-");
try {
  chmodSync(tree, 0o755);
  writeFileSync(join(tree, "hello.mjs"),
    "export function add(a, b) { return a + b; }\n", { mode: 0o444 });
  const outcome = await dockerSubject().run(tree, [
    { id: "smoke-add", target: { module: "hello.mjs", export: "add" }, args: [20, 22] },
  ], 30_000);
  assert.equal(outcome.variant, "DOCKER");
  assert.equal(outcome.ready, true);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.faults, []);
  const reply = outcome.stdout.split("\n").filter(Boolean).map(JSON.parse)
    .find(frame => frame.kind === "reply");
  assert.equal(reply.value, 42);
  console.log("ARM64 verifier Docker subject: ready, add(20,22)=42, exit 0, no faults.");
} finally {
  // Only the generated /tmp fixture is removed.
  rmSync(tree, { recursive: true, force: true });
}
