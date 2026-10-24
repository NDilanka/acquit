import type { Route } from "./route";

export type Role = "CLIENT" | "OPERATOR" | "PLATFORM";
export type NavIcon = "jobs" | "plus" | "search" | "dashboard" | "shield" | "printer" | "terminal" | "bids" | "work" | "earnings";
/** A Tools item sits under its own label in the sidebar. */
export type NavItem = { readonly to: string; readonly label: string; readonly icon: NavIcon; readonly group?: "Tools" };

const ROLE_PAGES: Record<Role, readonly NavItem[]> = {
  CLIENT: [
    { to: "/", label: "My jobs", icon: "jobs" },
    { to: "/jobs/new", label: "Post a job", icon: "plus" },
  ],
  // Tutorials joins this list in O5, once its page exists.
  OPERATOR: [
    { to: "/operator", label: "Find work", icon: "search" },
    { to: "/operator/bids", label: "My bids", icon: "bids" },
    { to: "/operator/work", label: "My work", icon: "work" },
    { to: "/operator/earnings", label: "Earnings", icon: "earnings" },
    { to: "/studio", label: "Dashboards", icon: "dashboard" },
  ],
  PLATFORM: [{ to: "/studio", label: "Dashboards", icon: "dashboard" }],
};

/** Every role also gets these three pages, under the Tools label. */
const PUBLIC_PAGES: readonly NavItem[] = [
  { to: "/verifiers", label: "Verifiers", icon: "shield", group: "Tools" },
  { to: "/print", label: "Print demo", icon: "printer", group: "Tools" },
  { to: "/cli", label: "CLI sign-in", icon: "terminal", group: "Tools" },
];

export function navFor(role: Role): readonly NavItem[] {
  return [...ROLE_PAGES[role], ...PUBLIC_PAGES];
}

/** Signed out, the sidebar lists only the two public pages; the Start the demo button sits under them. */
export function signedOutNav(): readonly NavItem[] {
  return PUBLIC_PAGES.slice(0, 2);
}

/** "/" is a role's first page, so that page stays lit there; a job page keeps My jobs lit for a client. */
export function isNavActive(item: NavItem, path: string, role: Role | null): boolean {
  if (path === item.to) return true;
  if (path === "/" && role !== null && ROLE_PAGES[role][0]?.to === item.to) return true;
  return item.to === "/" && path.startsWith("/jobs/") && path !== "/jobs/new";
}

const ROLE_EYEBROW: Record<Role, string> = { CLIENT: "Client", OPERATOR: "Operator", PLATFORM: "Platform" };

/** The top bar's mono eyebrow and title for a route. Pages keep their own headings below it. */
export function pageHeading(route: Route, role: Role | null): { eyebrow: string; title: string } {
  const eyebrow = role === null ? "Public" : ROLE_EYEBROW[role];
  switch (route.name) {
    case "home":
      return { eyebrow, title: role === "CLIENT" ? "My jobs" : role === "OPERATOR" ? "Find work" : "Dashboards" };
    case "demo":
      return { eyebrow: "Judge mode", title: "Try the demo" };
    case "newJob":
      return { eyebrow, title: "Post a job" };
    case "job":
      return { eyebrow, title: "Job" };
    case "receipt":
      return { eyebrow: "Receipt", title: "Public receipt" };
    case "verifiers":
      return { eyebrow: "Public", title: "Verifiers" };
    case "print":
      return { eyebrow: "Public", title: "Print demo" };
    case "operator":
      return { eyebrow, title: "Find work" };
    case "operatorBids":
      return { eyebrow, title: "My bids" };
    case "operatorWork":
      return { eyebrow, title: "My work" };
    case "operatorEarnings":
      return { eyebrow, title: "Earnings" };
    case "cli":
      return { eyebrow: "Acquit CLI", title: "CLI sign-in" };
    case "studio":
      return { eyebrow, title: "Dashboards" };
    case "notFound":
      return { eyebrow: "Acquit", title: "Page not found" };
  }
}
