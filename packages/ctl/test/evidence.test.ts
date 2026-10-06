import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { runInNewContext } from "node:vm";
import { portOpen } from "../src/process.ts";
// @ts-ignore Node executes the helper's native ESM.
import { credentialFill, redactor, refuseDashboard, englishCheckoutUrl, paypalControlSelectors, paypalPageProbe, classifyCheckout } from "../../../.factory/skills/verify-acquit/scripts/safe-browser.mjs";

test("credential fills travel only through batch stdin, never eval or command argv", () => {
	const command = credentialFill('input[type="password"]', 'synthetic-"password');
	assert.deepEqual(command.args, ["batch", "--bail"]);
	assert.equal(command.args.some((arg: string) => arg.includes("password")), false);
	const batch = JSON.parse(command.input);
	assert.deepEqual(batch[1], ["fill", 'input[type="password"]', 'synthetic-"password']);
	assert.equal(runInNewContext(batch[0][1], { location: { origin: "https://www.sandbox.paypal.com" } }), true);
	for (const origin of ["https://evil.test", "http://www.sandbox.paypal.com", "https://www.sandbox.paypal.com:444", "https://www.sandbox.paypal.com.evil.test"]) {
		assert.throws(() => runInNewContext(batch[0][1], { location: { origin } }), /refused outside/);
	}
});
test("action evidence redacts checkout query strings and escaped tokens", () => {
	const redact = redactor(['synthetic-"secret']);
	const line = redact({ command: ["open", "https://www.sandbox.paypal.com/checkoutnow?token=synthetic-order", 'synthetic-"secret'], ok: true });
	assert.equal(line.includes("synthetic"), false);
	assert.deepEqual(JSON.parse(line).command, ["open", "https://www.sandbox.paypal.com/checkoutnow?[redacted]", "[redacted]"]);
});
test("redaction handles nulls, overlapping secrets, form encoding and HTML entities", () => {
	const secret = `a b&<"'`;
	const redact = redactor(["a b", secret]);
	assert.equal(redact(null), "");
	assert.equal(redact(undefined), "");
	for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
		new URLSearchParams({ value: secret }).toString().slice(6), "a b&amp;&lt;&quot;&#39;",
		"a b&amp;&lt;&quot;&apos;", "a b&amp;&lt;&quot;&#x27;", "a b&#38;&#60;&#34;&#39;",
		"a b&#x26;&#x3c;&#x22;&#x27;", "a b&#x26;&#x3C;&#x22;&#x27;",
		[...secret].map(c => `&#${c.codePointAt(0)};`).join(""),
		[...secret].map(c => `&#x${c.codePointAt(0)!.toString(16)};`).join(""),
		[...secret].map(c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join(""),
		secret.replace(/[<>&]/g, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`)]) {
		assert.equal(redact(form), "[redacted]", form);
	}
	assert.equal(redactor(["short", "short-long"])("short-long"), "[redacted]");
	const email = redactor(["Buyer@Sandbox.example"]);
	assert.equal(email("buyer@sandbox.example"), "[redacted]", "email redaction is case-insensitive");
	assert.equal(email(encodeURIComponent("Buyer@Sandbox.example").toLowerCase()), "[redacted]", "percent-encoding is matched lowercase");
	assert.equal(redactor(["a/b"]).call(null, JSON.stringify("a/b").slice(1, -1).replace(/\\/g, "\\\\")), "[redacted]", "double JSON escaping");
});
test("approval and return URL redaction includes hosts, empty paths, fragments and nested encoding", () => {
	const redact = redactor();
	for (const url of ["https://sandbox.paypal.com?token=synthetic&PayerID=synthetic",
		"https://www.sandbox.paypal.com#token=synthetic", "https://sandbox.paypal.com/?token=synthetic#payer=synthetic",
		"https://www.sandbox.paypal.com/checkoutnow?token=synthetic#synthetic",
		"http://localhost:5263/paypal/return?jobId=job_test&token=synthetic&PayerID=synthetic",
		"/paypal/return?token=synthetic&PayerID=synthetic#synthetic"]) {
		assert(!redact(url).includes("synthetic"), url);
		assert(!redact({ url }).includes("synthetic"), url);
		if (url.startsWith("http")) {
			for (const encoded of [encodeURIComponent(url), encodeURIComponent(encodeURIComponent(url))]) {
				const cleaned = redact(`https://example.test/?redirect=${encoded}`);
				assert(!decodeURIComponent(decodeURIComponent(cleaned)).includes("synthetic"), encoded);
				assert(!redact({ url: encoded }).includes("synthetic"), encoded);
			}
		}
	}
	assert.equal(redact("https://sandbox.paypal.com.evil.test/?token=public"), "https://sandbox.paypal.com.evil.test/?token=public");
	for (const host of ["api.sandbox.paypal.com", "www.api-m.sandbox.paypal.com"]) {
		assert(!redact(`https://${host}/v2/checkout?token=synthetic`).includes("synthetic"), host);
		assert(!redact(`${host}/checkoutnow?token=synthetic`).includes("synthetic"), `schemeless ${host}`);
	}
	assert(!redact(String.raw`https:\/\/www.sandbox.paypal.com\/checkoutnow?token=synthetic`).includes("synthetic"), "JSON-escaped slashes");
	assert(!redact("https:\\u002F\\u002Fwww.sandbox.paypal.com\\u002Fcheckoutnow?token=synthetic").includes("synthetic"), "unicode-escaped slashes");
	assert.equal(redact("href='https://www.sandbox.paypal.com/checkoutnow?token=synthetic'"), "href='https://www.sandbox.paypal.com/checkoutnow?[redacted]'");
	assert(!redact(encodeURIComponent(encodeURIComponent("https://www.sandbox.paypal.com/checkoutnow?token=synthetic"))).includes("synthetic"), "double percent-encoding");
});
test("approval refuses default and custom dashboard listeners", async () => {
	for (const active of [4848, 61234]) {
		await assert.rejects(refuseDashboard([61234], async (port: number) => port === active), /dashboard port is listening/);
	}
	await refuseDashboard([], async () => false);
	await assert.rejects(refuseDashboard([NaN], async () => false), /Invalid dashboard port/);
	const server = createServer(socket => socket.destroy());
	try {
		await new Promise<void>(resolve => server.listen(0, "::1", resolve));
		const port = (server.address() as { port: number }).port;
		assert.equal(await portOpen(port), false, "The real default probe cannot see an IPv6-only dashboard.");
		assert.equal(await portOpen(port, "::1"), true);
		await assert.rejects(refuseDashboard([port], portOpen), /dashboard port is listening/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("normalization never rebuilds a secret or changes unrelated encoded evidence", () => {
	const redact = redactor(["Zq/Xy<9&Kp", "s3cretPass", "buyer.test@example.com"]);
	for (const form of [
		"Zq%2fXy%3c9%26Kp", "Zq%252FXy%253C9%2526Kp",
		String.raw`Zq/Xy\u003C9&Kp`, String.raw`Zq\u002fXy<9&Kp`,
		"%5A%71%2F%58%79%3C%39%26%4B%70", "%73%33cretPass",
		"BUYER.TEST@EXAMPLE.COM", "BuYeR.TeSt@ExAmPlE.CoM",
	]) assert.equal(redact(form), "[redacted]");
	for (const ordinary of ["100%25 done", String.raw`unrelated \u003Ctag\u003E`, "ordinary%252ftext", "x&amp;y", "a+b"]) assert.equal(redact(ordinary), ordinary);
	assert.equal(redact("100%25 done; Zq%252FXy%253C9%2526Kp; unchanged%2f"), "100%25 done; [redacted]; unchanged%2f");
});
test("redaction decodes JSON control escapes, including nested encoding, without rewriting unrelated controls", () => {
	for (const control of ["\n", "\t", "\r", "\b", "\f"]) {
		const secret = `synthetic${control}control`;
		const redact = redactor([secret]);
		const escaped = JSON.stringify(secret).slice(1, -1);
		for (const form of [escaped, encodeURIComponent(escaped), JSON.stringify(escaped).slice(1, -1)]) assert.equal(redact(form), "[redacted]");
		assert.deepEqual(JSON.parse(redact({ field: secret, ordinary: "a\nb\tc" })), { field: "[redacted]", ordinary: "a\nb\tc" });
	}
});
test("mixed escape families cannot destroy literal plus, percent or entity characters in secrets", () => {
	const html = (value: string) => value.replace(/[&<>"']/g, char =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
	for (const secret of ['Pa"ss+word9', 'Pa\\ss+word9', 'Pa"ss%41word9', 'Pa\\ss&amp;w9']) {
		const redact = redactor([secret]);
		const json = JSON.stringify(secret).slice(1, -1);
		for (const form of [secret, json, JSON.stringify(json).slice(1, -1), encodeURIComponent(secret),
			encodeURIComponent(json), encodeURIComponent(json).replace(/%[0-9A-F]{2}/g, code => code.toLowerCase()),
			new URLSearchParams({ value: secret }).toString().slice(6), html(secret), html(json)]) {
			assert.equal(redact(form), "[redacted]");
			assert.equal(redact(`ordinary%252f\\n x&amp;y a+b | ${form} | %ff`),
				"ordinary%252f\\n x&amp;y a+b | [redacted] | %ff", "Unrelated bytes must be preserved.");
		}
		assert.deepEqual(JSON.parse(redact({ field: secret })), { field: "[redacted]" });
	}
});
test("invalid percent UTF-8 neighbors cannot hide encoded secrets and retain exact unrelated bytes", () => {
	for (const secret of ["synthetic", "é/🚀", "synthetic\ncontrol"]) {
		const redact = redactor([secret]);
		const encoded = [...Buffer.from(secret)].map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
		for (const invalid of ["%ff", "%80", "%c0%af", "%e2%82", "%ed%a0%80", "%f4%90%80%80"]) {
			assert.equal(redact(`${invalid}${encoded}${invalid}`), `${invalid}[redacted]${invalid}`);
			const nested = encodeURIComponent(`${invalid}${encoded}${invalid}`);
			assert.equal(redact(nested), `${encodeURIComponent(invalid)}[redacted]${encodeURIComponent(invalid)}`);
		}
	}
	assert.equal(redactor(["secret"])("%ff%41%42%43%80"), "%ff%41%42%43%80");
});
test("checkout forces English while preserving the order and prefers structural PayPal controls", () => {
	for (const host of ["sandbox.paypal.com", "www.sandbox.paypal.com"]) {
		const url = new URL(englishCheckoutUrl(`https://${host}/checkoutnow?token=synthetic&locale.x=si_LK`));
		assert.equal(url.searchParams.get("locale.x"), "en_US");
		assert.equal(url.searchParams.get("token"), "synthetic");
	}
	assert.throws(() => englishCheckoutUrl("https://paypal.com/checkoutnow"), /outside PayPal sandbox/);
	assert.throws(() => englishCheckoutUrl("http://sandbox.paypal.com"), /outside PayPal sandbox/);
	assert.deepEqual(paypalControlSelectors.slice(0, 3), ["#btnLogin", "#btnNext", "#payment-submit-btn"]);
	assert(paypalControlSelectors.includes('button[type="submit"]'));
	assert(paypalControlSelectors.includes('button:not([type])'));
});
test("localized PayPal controls exclude covered and hidden buttons, without returning field values", () => {
	const make = (id: string, width = 100) => ({ id, disabled: false, innerText: "ඊළඟ", value: "synthetic-private",
		getBoundingClientRect: () => ({ x: 0, y: 0, width, height: 30 }), contains: () => false });
	const covered = make("btnLogin");
	const next = make("btnNext");
	const hidden = make("payment-submit-btn", 0);
	const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
	const styleBefore = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
	const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
	try {
		Object.defineProperty(globalThis, "document", { configurable: true, value: {
			elementFromPoint: () => next,
			querySelectorAll: (selector: string) => selector === "#btnLogin" ? [covered] : selector === "#btnNext" ? [next]
				: selector === "#payment-submit-btn" ? [hidden] : selector === 'button,input[type="submit"]' ? [covered, next, hidden] : [],
		} });
		Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ visibility: "visible", display: "block" }) });
		const probe = paypalPageProbe(paypalControlSelectors);
		assert.equal(probe.control, '[id="btnNext"]');
		assert.deepEqual(probe.buttons, ["ඊළඟ"]);
		assert(!JSON.stringify(probe).includes("synthetic-private"));
		// The Hermes header profile menu is also type=submit. The purchase submit
		// is last in DOM order, not the first generic submit in the header.
		const profile = make("button-profile");
		const purchase = make("purchase");
		profile.getBoundingClientRect = () => ({ x: 200, y: 0, width: 100, height: 30 });
		Object.defineProperty(globalThis, "document", { configurable: true, value: {
			elementFromPoint: (x: number) => x > 200 ? profile : purchase,
			querySelectorAll: (selector: string) => selector === 'button[type="submit"]' || selector === 'button,input[type="submit"]' ? [profile, purchase] : [],
		} });
		assert.equal(paypalPageProbe(paypalControlSelectors).control, '[id="purchase"]');
		assert.equal(classifyCheckout({ origin: "https://www.sandbox.paypal.com", overlays: [], email: false, password: false, control: null }, "http://app.test"), "spinner");
		// Default HTMLButtonElement.type is submit even when no type attribute
		// exists. PayPal Hermes uses this implicit submit for its purchase button.
		Object.defineProperty(globalThis, "document", { configurable: true, value: {
			elementFromPoint: (x: number) => x > 200 ? profile : purchase,
			querySelectorAll: (selector: string) => selector === 'button:not([type])' || selector === 'button,input[type="submit"]' ? [profile, purchase] : [],
		} });
		assert.equal(paypalPageProbe(paypalControlSelectors).control, '[id="purchase"]');
		Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://app.test" } });
		Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => [] } });
		assert.equal(paypalPageProbe(paypalControlSelectors).origin, "http://app.test");
		assert.equal(classifyCheckout({ origin: "http://app.test", overlays: [], email: false, password: false, control: null }, "http://app.test"), "returned");
	} finally {
		if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore);
		else Reflect.deleteProperty(globalThis, "document");
		if (styleBefore) Object.defineProperty(globalThis, "getComputedStyle", styleBefore);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
		if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore);
		else Reflect.deleteProperty(globalThis, "location");
	}
});
