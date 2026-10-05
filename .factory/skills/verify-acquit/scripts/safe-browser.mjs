// Credential commands use stdin batch, never eval, argv, evidence, or saved state.
export function credentialFill(selector, value) {
	return { args: ["batch", "--bail"], input: JSON.stringify([["fill", selector, value]]) };
}
export function redactor(secrets = []) {
	return value => {
		let text = typeof value === "string" ? value : JSON.stringify(value);
		for (const secret of secrets) {
			if (!secret) continue;
			for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) text = text.replaceAll(form, "[redacted]");
		}
		return text.replace(/(https:\/\/www\.sandbox\.paypal\.com\/[^"\s?]+)\?[^"\s]+/g, "$1?[redacted]");
	};
}
