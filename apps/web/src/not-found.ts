export type NotFoundLink = { readonly to: string; readonly label: string };

/** A signed-out browser is pointed at Try Acquit; a signed-in one back to their own dashboard. */
export function notFoundLink(signedIn: boolean): NotFoundLink {
  return signedIn ? { to: "/", label: "Back to your dashboard" } : { to: "/start", label: "Try Acquit" };
}
