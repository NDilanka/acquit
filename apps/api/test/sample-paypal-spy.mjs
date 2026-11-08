// Preloaded into the API server under test with `node --import`. Each outbound fetch is appended to the file named by
// SAMPLE_FETCH_LOG. A PayPal call is refused here, so a sample read that reached PayPal would fail the request it made
// and also leave its URL in the log for the test to find.

import { appendFileSync } from "node:fs";

const log = process.env.SAMPLE_FETCH_LOG;
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (log) appendFileSync(log, `${url}\n`);
	if (/paypal/i.test(url)) throw new Error("sample spy: PayPal is refused in this test");
	return realFetch(input, init);
};
