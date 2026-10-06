// Batch values are visible to attached stream clients in agent-browser 0.37.1.
// Approval must have no stream clients and must refuse a listening dashboard.
export function credentialFill(selector, value) {
	// In the same bail batch, immediately before EACH fill, including the
	// password after an email fill. Never trust an earlier page observation.
	return { args: ["batch", "--bail"], input: JSON.stringify([
		["eval", `(${assertSandboxOrigin.toString()})()`], ["fill", selector, value],
	]) };
}
export function assertSandboxOrigin() {
	if (location.origin !== "https://www.sandbox.paypal.com") throw new Error("Credential fill refused outside the sandbox PayPal origin.");
	return true;
}
export async function refuseDashboard(ports, isOpen) {
	// Discovery itself proves a listener; probing IPv4 cannot disprove an
	// IPv6-only (or otherwise non-loopback) discovered dashboard.
	for (const port of new Set([4848, ...ports])) {
		if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port; approval refused.");
		if (ports.includes(port) || await isOpen(port, "127.0.0.1") || await isOpen(port, "::1")) throw new Error("Approval refused: a dashboard port is listening. Close the dashboard and detach every stream client before approval.");
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
export function redactor(secrets = []) {
	const patterns = [...new Set(secrets.filter(secret => typeof secret === "string" && secret))].map(secret =>
		new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /^[^@\s]+@[^@\s]+$/.test(secret) ? "gi" : "g"));
	const urls = [
		new RegExp(String.raw`https?:\/\/${sandboxHost}[^?#\s"'<>]*([?#][^"'\s<>]*)`, "gi"),
		new RegExp(String.raw`(?:^|[\s"'=])${sandboxHost}(?:\/[^?#\s"'<>]*)?([?#][^"'\s<>]*)`, "gi"),
		/\/paypal\/return([?#][^"'\s<>]*)/gi,
	];
	return value => {
		const original = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";
		let scratch = original;
		let map = Array.from({ length: original.length }, (_, start) => ({ start, end: start + 1 }));
		const hits = [];
		const hit = (start, end, replacement) => hits.push({ start: map[start].start, end: map[end - 1].end, replacement });
		// Decode only scratch text. Every decoded code unit keeps the ORIGINAL
		// byte-range provenance; output is always sliced from original evidence.
		for (;;) {
			for (const pattern of patterns) for (const match of scratch.matchAll(pattern)) hit(match.index, match.index + match[0].length, "[redacted]");
			for (const pattern of urls) for (const match of scratch.matchAll(pattern)) {
				const query = match[1];
				hit(match.index + match[0].length - query.length, match.index + match[0].length, "?[redacted]");
			}
			const escapes = /\\u([0-9a-f]{4})|\\(["\\/])|(?:%[0-9a-f]{2})+|&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);|\+/gi;
			let next = "", nextMap = [], cursor = 0;
			for (const match of scratch.matchAll(escapes)) {
				let decoded = match[0];
				if (match[1]) decoded = String.fromCharCode(Number.parseInt(match[1], 16));
				else if (match[2]) decoded = match[2];
				else if (decoded.startsWith("%")) { try { decoded = decodeURIComponent(decoded); } catch {} }
				else if (decoded === "+") decoded = " ";
				else {
					const entity = decoded.slice(1, -1).toLowerCase();
					if (entity.startsWith("#")) {
						const point = Number.parseInt(entity.slice(entity.startsWith("#x") ? 2 : 1), entity.startsWith("#x") ? 16 : 10);
						if (point <= 0x10ffff) decoded = String.fromCodePoint(point);
					} else decoded = ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] ?? decoded;
				}
				next += scratch.slice(cursor, match.index);
				nextMap.push(...map.slice(cursor, match.index));
				next += decoded;
				if (decoded === match[0]) nextMap.push(...map.slice(match.index, match.index + match[0].length));
				else for (let i = 0; i < decoded.length; i++) nextMap.push({ start: map[match.index].start, end: map[match.index + match[0].length - 1].end });
				cursor = match.index + match[0].length;
			}
			next += scratch.slice(cursor);
			nextMap.push(...map.slice(cursor));
			if (next === scratch) break;
			scratch = next; map = nextMap;
		}
		hits.sort((a, b) => a.start - b.start || b.end - a.end);
		const merged = [];
		for (const range of hits) {
			const last = merged.at(-1);
			if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
			else merged.push({ ...range });
		}
		let output = "", cursor = 0;
		for (const range of merged) { output += original.slice(cursor, range.start) + range.replacement; cursor = range.end; }
		return output + original.slice(cursor);
	};
}
