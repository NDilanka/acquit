export type NotFoundLink = { readonly to: string; readonly label: string };

/** A signed-out visitor is pointed at the demo; a signed-in one back to their own dashboard. */
export function notFoundLink(signedIn: boolean): NotFoundLink {
  return signedIn ? { to: "/", label: "Back to your dashboard" } : { to: "/demo", label: "Start the demo" };
}
