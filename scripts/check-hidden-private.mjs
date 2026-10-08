// The K1 lever: does any tracked file carry a case's expected value next to its currency?
//
//   node scripts/check-hidden-private.mjs <manifest>
//
// The manifest is read through the same strict parser the verifier uses, every tracked file is
// walked, and one count per case plus the total is printed. A value, a currency, or a matched line
// is never printed. Exit 0 only when nothing matched: running it on the committed example must find
// hits, and running it on a deployment's private file must find none.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHiddenCases } from "../packages/verifier/hidden.ts";

const [manifest] = process.argv.slice(2);
if (!manifest) {
	console.error("usage: node scripts/check-hidden-private.mjs <manifest>");
	process.exit(2);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const cases = parseHiddenCases(readFileSync(manifest, "utf8"), manifest);
const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	.split("\0").filter(file => file !== "");
let total = 0;
for (const test of cases) {
	// The currency is the three-letter argument the case calls with; the answer is its expected value.
	const currencies = test.args.filter(arg => typeof arg === "string" && /^[A-Z]{3}$/.test(arg));
	const answer = typeof test.expected === "string" ? test.expected : JSON.stringify(test.expected);
	let hits = 0;
	for (const file of files) {
		let text;
		try { text = readFileSync(`${root}/${file}`, "utf8"); } catch { continue; }
		if (text.includes("\0")) continue;
		for (const line of text.split("\n")) {
			if (currencies.some(currency => line.includes(currency)) && line.includes(answer)) hits++;
		}
	}
	total += hits;
	console.log(`${test.id} hits=${hits}`);
}
console.log(`cases=${cases.length} files=${files.length} total=${total}`);
process.exit(total === 0 ? 0 : 1);
