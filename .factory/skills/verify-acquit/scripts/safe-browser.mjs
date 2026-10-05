// Batch values are visible to attached stream clients in agent-browser 0.37.1.
// Approval must have no stream clients and must refuse a listening dashboard.
export function credentialFill(selector, value) {
	return { args: ["batch", "--bail"], input: JSON.stringify([["fill", selector, value]]) };
}
export async function refuseDashboard(ports, isOpen) {
	// A listening port is not enough. The dashboard answers a connect on
	// 127.0.0.1; a port discovered only by its listener (including one bound on
	// ::1) is refused unless that probe succeeds, which it cannot for ::1.
	for (const port of new Set([4848, ...ports])) {
		if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port; approval refused.");
		if (await isOpen(port) && !(await isOpen(port, "127.0.0.1"))) throw new Error("Approval refused: a dashboard port is listening but did not answer on 127.0.0.1. Close the dashboard and detach every stream client before approval.");
		if (await isOpen(port, "127.0.0.1")) throw new Error("Approval refused: a dashboard port is listening. Close the dashboard and detach every stream client before approval.");
	}
}
export const paypalControlSelectors = [
	"#btnLogin", "#btnNext", "#payment-submit-btn", "#confirmButtonTop", "#confirmButtonBottom",
	'[data-testid="submit-button"]', '[data-testid="pay-now-button"]', 'button[type="submit"]', 'button:not([type])', 'input[type="submit"]',
];
export function englishCheckoutUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname)) {
		throw new Error("Refuse checkout locale override outside PayPal sandbox.");
	}
	url.searchParams.set("locale.x", "en_US");
	return url.toString();
}
export function classifyCheckout(probe, returnOrigin) {
	if (probe.origin === returnOrigin) return "returned";
	if (probe.overlays.length) return "overlay";
	if (probe.email && probe.password) return "login";
	if (probe.email) return "email";
	if (probe.password) return "password";
	if (probe.control) return "review";
	return "spinner";
}
// Self-contained so it can run in the page without sending any input values back.
export function paypalPageProbe(selectors) {
	const visible = element => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		// PayPal keeps the previous step's controls in the DOM at 0x0. A positive
		// rect is the only signal that a step is actually showing.
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	};
	const clickable = element => {
		if (element.disabled || !visible(element)) return false;
		const rect = element.getBoundingClientRect();
		// Identify offscreen purchase controls so the driver can scroll them.
		if (typeof innerHeight === "number" && (rect.y >= innerHeight || rect.y + rect.height <= 0)) return true;
		const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
		return top === element || element.contains(top);
	};
	let control;
	for (const selector of selectors) {
		const candidates = Array.from(document.querySelectorAll(selector));
		// Hermes renders header/profile buttons as type=submit too. Its purchase
		// submit is the last submit control; never choose the header/profile menu.
		const genericSubmit = selector === 'button[type="submit"]' || selector === 'button:not([type])' || selector === 'input[type="submit"]';
		if (genericSubmit) candidates.reverse();
		// The sticky Hermes purchase footer may fail a pre-scroll hit test.
		// Native click still enforces coverage after scrollintoview. A zero rect
		// is the previous step kept in the DOM, never a control to click.
		const element = candidates.find(element => visible(element) && (genericSubmit ? !element.disabled : clickable(element)));
		if (!element) continue;
		if (element.id) control = `[id=${JSON.stringify(element.id)}]`;
		else {
			const path = [];
			for (let node = element; node && node.tagName !== "HTML"; node = node.parentElement) {
				path.unshift(`${node.tagName.toLowerCase()}:nth-child(${Array.from(node.parentElement.children).indexOf(node) + 1})`);
			}
			control = path.join(" > ");
		}
		break;
	}
	return {
		origin: typeof location === "undefined" ? null : location.origin,
		email: Array.from(document.querySelectorAll('input[type="email"],input[name="login_email"]')).some(visible),
		password: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
		control,
		buttons: Array.from(document.querySelectorAll('button,input[type="submit"]')).filter(clickable).map(element => element.innerText || element.value),
		overlays: Array.from(document.querySelectorAll('button,[role="button"],[role="dialog"] button')).filter(visible).flatMap(element => {
			const label = (element.innerText || element.getAttribute("aria-label") || "").trim();
			return /^(accept|agree|allow all|allow|got it|ok|reject|decline)$/i.test(label) ? [label] : [];
		}).slice(0, 3),
	};
}
const sandboxHost = String.raw`(?:[a-z0-9-]+\.)*sandbox\.paypal\.com(?![a-z0-9.-])`;
function stripUrls(text) {
	// Strip the query and fragment of every sandbox PayPal URL: any subdomain,
	// schemeless, JSON-escaped slashes, and slash escapes. The match stops before
	// a closing quote, so href='...' keeps its quote. Then decode to a fixed
	// point and strip again, so nested percent-encoding cannot hide a token.
	const clean = value => value
		.replace(new RegExp(String.raw`(https?:(?:\\?\/){2}${sandboxHost}[^?\s"'<>]*)(?:[?#][^"'\s<>]*)`, "gi"), "$1?[redacted]")
		.replace(new RegExp(String.raw`((?:^|[\s"'=])${sandboxHost}\/[^?\s"'<>]*)(?:[?#][^"'\s<>]*)`, "gi"), "$1?[redacted]")
		.replace(/(\/paypal\/return)(?:[?#][^"'\s<>]*)/gi, "$1?[redacted]");
	let current = text;
	for (let i = 0; i < 4; i++) {
		const stripped = clean(current);
		const decoded = stripped
			.replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
			.replace(/%[0-9a-f]{2}/gi, encoded => { try { return decodeURIComponent(encoded); } catch { return encoded; } });
		if (decoded === current) return stripped;
		current = decoded;
	}
	return clean(current);
}
export function redactor(secrets = []) {
	const forms = [...new Set(secrets.filter(secret => typeof secret === "string" && secret).flatMap(secret => {
		const html = secret.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
		const numeric = base => [...secret].map(char => `&#${base === 16 ? "x" : ""}${char.codePointAt(0).toString(base)};`).join("");
		const escaped = JSON.stringify(secret).slice(1, -1);
		const email = /^[^@\s]+@[^@\s]+$/.test(secret) ? [secret.toLowerCase()] : [];
		return [secret, ...email, escaped, escaped.replace(/\\/g, "\\\\"), encodeURIComponent(secret), encodeURIComponent(secret).toLowerCase(),
			encodeURI(secret), new URLSearchParams({ value: secret }).toString().slice(6), html, html.replaceAll("&#39;", "&apos;"),
			html.replaceAll("&#39;", "&#x27;"), numeric(10), numeric(16),
			secret.replace(/[&<>"']/g, char => `&#${char.codePointAt(0)};`),
			secret.replace(/[&<>"']/g, char => `&#x${char.codePointAt(0).toString(16)};`),
			secret.replace(/[&<>"']/g, char => `&#x${char.codePointAt(0).toString(16).toUpperCase()};`),
			[...secret].map(char => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`).join(""),
			[...secret].map(char => `\\u${char.codePointAt(0).toString(16).padStart(4, "0").toUpperCase()}`).join(""),
			secret.replace(/[<>&]/g, char => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`)];
	}))].sort((a, b) => b.length - a.length);
	return value => {
		let text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";
		for (const form of forms) text = text.replaceAll(form, "[redacted]");
		return stripUrls(text);
	};
}
