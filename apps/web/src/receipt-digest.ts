// The browser's own check of a revealed hidden-case set. It recomputes the SHA-256 the server sealed
// (packages/core/src/hidden-seal.ts, digestOfHiddenCases) with Web Crypto, so the receipt page does not
// take the server's word for the match. The web app never imports core at runtime, so the canonical JSON
// is restated here; receipt-digest.test.ts pins both sides to literal digests the core produced.

export type DigestCase = {
  readonly id: string;
  readonly target: { readonly module: string; readonly export: string };
  readonly args: readonly unknown[];
  readonly expected: unknown;
};

/** Object keys sort in UTF-16 code-unit order, the same order the core's canonical JSON uses on every host. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the salt, a newline, and the canonical JSON of the cases, as lowercase hex. Needs a secure context (https or localhost). */
export async function digestOfHiddenCases(cases: readonly DigestCase[], salt: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("A hidden-case salt is 32 bytes of lowercase hex.");
  const bytes = new TextEncoder().encode(`${salt}\n${canonicalJson(cases)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
