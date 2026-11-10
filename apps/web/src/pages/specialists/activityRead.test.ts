import assert from "node:assert/strict";
import { test } from "node:test";
import { activityReader } from "./activityRead.ts";

test("a missing route is read once for the page lifetime, and a reload can try again", async () => {
  let calls=0;
  const read=async () => { calls++; return null; };
  const session=activityReader(read);
  await Promise.all([session(50,"a"),session(50,"a")]);
  await session(20,"a"); await session(50,"b");
  assert.equal(calls,1);
  await activityReader(read)(50,"a");
  assert.equal(calls,2);
});
test("a supported route stays refreshable and failures are not cached as absence", async () => {
  let calls=0;
  const session=activityReader(async () => { if (++calls===1) throw new Error("Unavailable"); return calls; });
  await assert.rejects(session(),/Unavailable/);
  assert.equal(await session(),2);
  assert.equal(await session(),3);
});
test("in-flight reads never cross principal or limit boundaries", async () => {
  let calls=0;
  const session=activityReader(async () => ++calls);
  const [a,b,c]=await Promise.all([session(50,"a"),session(50,"b"),session(20,"a")]);
  assert.deepEqual([a,b,c],[1,2,3]);
});
