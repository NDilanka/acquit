import assert from "node:assert/strict";
import { test } from "node:test";
import { suiteLine } from "./scoping-review.ts";

test("the suite line reads the job's frozen contract, not the fixture catalog", () => {
  // 7 hidden: the count the client's approval froze, while the fixture catalog still says 6.
  assert.equal(
    suiteLine({ frozenAt: "9f2c41e7d0b3a5c6e8f1d2b4a6c8e0f1a3b5c7d9", frozenTests: 48, hiddenTests: 7 }),
    "Suite frozen at 9f2c41e (48 tests, 7 hidden)",
  );
});
