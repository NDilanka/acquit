import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore Node executes the helper's native ESM.
import { credentialFill, redactor, refuseDashboard, englishCheckoutUrl, paypalControlSelectors, paypalPageProbe, classifyCheckout } from "../../../.factory/skills/verify-acquit/scripts/safe-browser.mjs";

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
	await refuseDashboard([61234], async () => false);
	await assert.rejects(refuseDashboard([NaN], async () => false), /Invalid dashboard port/);
	// A port that answers only off 127.0.0.1, such as ::1, cannot pass the probe.
	await assert.rejects(refuseDashboard([61234], async (_port: number, host?: string) => host !== "127.0.0.1"), /did not answer on 127.0.0.1/);
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
