import assert from "node:assert/strict";
import { test } from "node:test";

test("app-slot caps use measured reserve independently of browser cost", async () => {
	const { memoryCap } = await import(new URL("../../../.factory/skills/verify-acquit/scripts/lanes.mjs", import.meta.url).href);
	assert.equal(memoryCap(904, 250, 256), 2);
	assert.equal(memoryCap(256, 250, 256), 0);
	assert.equal(memoryCap(505, 250, 256), 0);
	assert.equal(memoryCap(506, 250, 256), 1);
	assert.equal(memoryCap(2000, 250, 256), 6);
	assert.throws(() => memoryCap(2000, 0));
	assert.throws(() => memoryCap(NaN, 500));
	assert.throws(() => memoryCap(2000, 500, -1));
	const { planWave } = await import(new URL("../../../.factory/skills/verify-acquit/scripts/lanes.mjs", import.meta.url).href);
	const memory = { perLaneMB: 250, appMarginalMB: 240, browserMarginalMB: 600, measuredReserveMB: 256 };
	assert.equal(planWave(3, 2000, memory).cap, 3, "lane 10 needs three apps, no browser");
	assert.equal(planWave(3, 2000, memory, { browsers: true }).cap, 2);
	const refused = planWave(10, 2000, memory, { maxLanes: 0 });
	assert.equal(refused.cap, 0);
	assert.match(refused.reason, /2000 MB.*506 MB.*ACQUIT_MAX_LANES=0/);
});
