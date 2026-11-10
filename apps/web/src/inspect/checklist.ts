import type { InspectFinding, InspectVerdict } from "./contract.ts";

export type PublicRow = { readonly rule: string; readonly ok: boolean; readonly message: string; readonly finding: InspectFinding };

/**
 * What the checklist may show. Public findings keep their rule and message. A hidden finding keeps only whether it
 * passed: its rule name and message stay out of this shape, so no view built on it can print them.
 */
export type Checklist = {
  readonly publicRows: readonly PublicRow[];
  readonly sealed: readonly boolean[];
  readonly pass: boolean;
};

function sentence(message: string): string {
  const text = message.trim();
  if (!text) return text;
  return text[0]!.toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");
}

export function checklistOf(verdict: InspectVerdict): Checklist {
  return {
    publicRows: verdict.findings
      .filter((f) => !f.hidden)
      .map((f) => ({ rule: f.rule, ok: f.ok, message: sentence(f.message), finding: f })),
    sealed: verdict.findings.filter((f) => f.hidden).map((f) => f.ok),
    pass: verdict.pass,
  };
}

/** True when every public rule passes and a sealed one fails: the cheat that only a hidden check catches. */
export function caughtOnlyBySealed(list: Checklist): boolean {
  return list.publicRows.every((r) => r.ok) && list.sealed.some((ok) => !ok);
}

const UNITS: readonly (readonly [RegExp, string])[] = [
  [/Mm$/, "mm"],
  [/Seconds$/, "s"],
];

/** A `measured` key as a label, with its unit split off: `cutLengthMm` reads "Cut length", "mm". */
export function measuredLabel(key: string): { readonly label: string; readonly unit: string | null } {
  let base = key;
  let unit: string | null = null;
  for (const [pattern, u] of UNITS)
    if (pattern.test(base) && base.replace(pattern, "") !== "") {
      base = base.replace(pattern, "");
      unit = u;
      break;
    }
  const words = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), unit };
}
