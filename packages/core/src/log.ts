/**
 * One provider field as one quoted log value. JSON.stringify escapes the quotes, the backslashes, and
 * the control characters, and it leaves U+2028 and U+2029, the two line separators, raw: both end a line
 * in a terminal, so a field carrying one could forge or split a log entry.
 */
export function logQuoted(value: string): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
