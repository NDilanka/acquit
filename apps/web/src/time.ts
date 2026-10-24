const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function count(n: number, unit: "min" | "h" | "day" | "days"): string {
  return unit === "min" || unit === "h" ? `${n} ${unit}` : `${n} ${n === 1 ? "day" : "days"}`;
}

/** An absolute date for anything a week or more away: "Oct 30", with the year only when it is not this year. */
function calendarDay(at: number, now: number): string {
  const sameYear = new Date(at).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "2 h ago", "in 3 days", or "Oct 30". The exact UTC time belongs in a title attribute, beside it. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const diff = at - now;
  const span = Math.abs(diff);
  if (span < MINUTE) return "just now";
  let text: string;
  if (span < HOUR) text = count(Math.floor(span / MINUTE), "min");
  else if (span < DAY) text = count(Math.floor(span / HOUR), "h");
  else if (span < 7 * DAY) text = count(Math.floor(span / DAY), "days");
  else return calendarDay(at, now);
  return diff > 0 ? `in ${text}` : `${text} ago`;
}
