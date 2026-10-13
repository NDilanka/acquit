// The evidence the fund drive saves must never carry an approval query string: the approval URL is
// reduced to its origin and path before it reaches any saved file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { urlWithoutQuery } from "./safe-browser.mjs";

test("an approval URL is reduced to its origin and path before it is saved", () => {
	assert.equal(
		urlWithoutQuery("https://www.sandbox.paypal.com/checkoutnow?locale.x=en_US&example=QUERY"),
		"https://www.sandbox.paypal.com/checkoutnow",
	);
});

test("a URL without a query is unchanged", () => {
	assert.equal(urlWithoutQuery("https://www.sandbox.paypal.com/checkoutnow"), "https://www.sandbox.paypal.com/checkoutnow");
});

test("a value that is not a URL is refused", () => {
	assert.throws(() => urlWithoutQuery("not a url"), TypeError);
});
