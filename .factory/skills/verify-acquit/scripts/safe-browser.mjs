// Batch values are visible to attached stream clients in agent-browser 0.37.1.
// Approval must have no stream clients and must refuse a listening dashboard.
export function credentialFill(selector, value) {
	return { args: ["batch", "--bail"], input: JSON.stringify([["fill", selector, value]]) };
}
export async function refuseDashboard(ports, isOpen) {
	for (const port of new Set([4848, ...ports])) {
		if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port; approval refused.");
		if (await isOpen(port)) throw new Error("Approval refused: a dashboard port is listening. Close the dashboard and detach every stream client before approval.");
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
export function paypalControlReady(selector, returnOrigin) {
	if (typeof location !== "undefined" && location.origin === returnOrigin) return true;
	const element = document.querySelector(selector);
	if (!element || element.disabled) return false;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(element).opacity === "0") return false;
	const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
	return top === element || element.contains(top);
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
		// Native click still enforces coverage after scrollintoview.
		const element = candidates.find(genericSubmit ? element => !element.disabled && visible(element) : clickable);
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
function stripUrls(text) {
	// Strip entire approval/return query and fragment, not just known token keys.
	text = text.replace(/(https?:\/\/(?:www\.)?sandbox\.paypal\.com(?=\/|[?#"\s<>]|$)[^?#"\s<>]*)(?:[?#][^"\s<>]*)/gi, "$1?[redacted]");
	text = text.replace(/(\/paypal\/return)(?:[?#][^"\s<>]*)/gi, "$1?[redacted]");
	// Nested percent-encoded URLs can occur in redirect parameters and JSON.
	for (const level of [2, 1]) {
		const marker = level === 2 ? "%253A%252F%252F" : "%3A%2F%2F";
		const pattern = new RegExp(`https?${marker}[^"\\s<>]*`, "gi");
		text = text.replace(pattern, encoded => {
			try {
				let decoded = encoded;
				for (let i = 0; i < level; i++) decoded = decodeURIComponent(decoded);
				const clean = stripUrls(decoded);
				if (clean === decoded) return encoded;
				let result = clean;
				for (let i = 0; i < level; i++) result = encodeURIComponent(result);
				return result;
			} catch { return encoded; }
		});
	}
	return text;
}
export function redactor(secrets = []) {
	const forms = [...new Set(secrets.filter(secret => typeof secret === "string" && secret).flatMap(secret => {
		const html = secret.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
		const numeric = base => [...secret].map(char => `&#${base === 16 ? "x" : ""}${char.codePointAt(0).toString(base)};`).join("");
		return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
			new URLSearchParams({ value: secret }).toString().slice(6), html, html.replaceAll("&#39;", "&apos;"),
			html.replaceAll("&#39;", "&#x27;"), numeric(10), numeric(16),
			secret.replace(/[&<>"']/g, char => `&#${char.codePointAt(0)};`),
			secret.replace(/[&<>"']/g, char => `&#x${char.codePointAt(0).toString(16)};`),
			secret.replace(/[&<>"']/g, char => `&#x${char.codePointAt(0).toString(16).toUpperCase()};`)];
	}))].sort((a, b) => b.length - a.length);
	return value => {
		let text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";
		for (const form of forms) text = text.replaceAll(form, "[redacted]");
		return stripUrls(text);
	};
}
