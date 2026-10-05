import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore Node executes the helper's native ESM.
import { credentialFill, redactor } from "../../../.factory/skills/verify-acquit/scripts/safe-browser.mjs";

test("credential fills travel only through batch stdin, never eval or command argv", () => {
	const command = credentialFill('input[type="password"]', 'synthetic-"password');
	assert.deepEqual(command.args, ["batch", "--bail"]);
	assert.equal(command.args.some((arg: string) => arg.includes("password")), false);
	assert.deepEqual(JSON.parse(command.input), [["fill", 'input[type="password"]', 'synthetic-"password']]);
});
test("action evidence redacts checkout query strings and escaped tokens", () => {
	const redact = redactor(['synthetic-"secret']);
	const line = redact({ command: ["open", "https://www.sandbox.paypal.com/checkoutnow?token=synthetic-order", 'synthetic-"secret'], ok: true });
	assert.equal(line.includes("synthetic"), false);
	assert.deepEqual(JSON.parse(line).command, ["open", "https://www.sandbox.paypal.com/checkoutnow?[redacted]", "[redacted]"]);
});
