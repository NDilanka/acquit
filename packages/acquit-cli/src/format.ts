// Display helpers the operator commands share. Money is integer cents; each phrase the tutorial prints
// is spelled in exactly one place here.

import { formatUsd } from "../../core/src/ledger.ts";
import type { UsdCents } from "../../core/src/ledger.ts";

/** `400.00 USD`. */
export function usd(cents: number): string {
	return `${formatUsd(cents as UsdCents)} USD`;
}

/** `2026-11-08 10:00`, the tutorial's deadline form. The instant is UTC by contract. */
export function utcMinutes(value: string): string {
	return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** `2 days`, `48 hours`. */
export function eta(hours: number): string {
	if (hours % 24 === 0) {
		const days = hours / 24;
		return days === 1 ? "1 day" : `${days} days`;
	}
	return hours === 1 ? "1 hour" : `${hours} hours`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The UTC weekday `nextGrantAt` names, so the CLI never depends on the machine's locale. */
export function weekday(value: string): string {
	return WEEKDAYS[new Date(value).getUTCDay()] ?? "";
}

/** One table cell padded to its column. A value wider than the column still gets one space. */
export function cell(text: string, width: number): string {
	return text.length >= width ? `${text} ` : text.padEnd(width);
}
