// The K1 lever: does any tracked file carry a case's expected value next to its currency?
//
//   node scripts/check-hidden-private.mjs <manifest> [repo-root]
//
// The manifest is read through the same strict parser the verifier uses, every tracked file in the
// repository is walked, and one count per case plus the total is printed. A value, a currency, or a
// matched line is never printed. The search is formatting-independent: whitespace is removed from
// each file and a case's currency and answer may sit anywhere within a short window, so a copy
// spread over several lines is found too. Exit 0 only when nothing matched: running it on the
// committed example must find hits, and running it on a deployment's private file must find none.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHiddenCases } from "../packages/verifier/hidden.ts";

const [manifest, repoRoot] = process.argv.slice(2);
if (!manifest) {
	console.error("usage: node scripts/check-hidden-private.mjs <manifest> [repo-root]");
	process.exit(2);
}
const root = repoRoot ?? fileURLToPath(new URL("..", import.meta.url));
/** How far apart, in characters, a currency and an answer may sit once whitespace is removed. */
const WINDOW = 200;
const cases = parseHiddenCases(readFileSync(manifest, "utf8"), manifest);
const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	.split("\0").filter(file => file !== "");
let total = 0;
for (const test of cases) {
	// The currency is the three-letter argument the case calls with; the answer is its expected value.
	const currencies = test.args.filter(arg => typeof arg === "string" && /^[A-Z]{3}$/.test(arg));
	const answer = (typeof test.expected === "string" ? test.expected : JSON.stringify(test.expected)).replace(/\s+/g, "");
	let hits = 0;
	for (const file of files) {
		let text;
		try { text = readFileSync(`${root}/${file}`, "utf8"); } catch { continue; }
		if (text.includes("\0")) continue;
		const compact = text.replace(/\s+/g, "");
		let from = 0;
		while (from < compact.length) {
			const at = compact.indexOf(answer, from);
			if (at < 0) break;
			const window = compact.slice(Math.max(0, at - WINDOW), at + answer.length + WINDOW);
			if (currencies.some(currency => window.includes(currency))) { hits++; break; }
			from = at + 1;
		}
	}
	total += hits;
	console.log(`${test.id} hits=${hits}`);
}
console.log(`cases=${cases.length} files=${files.length} total=${total}`);
process.exit(total === 0 ? 0 : 1);
