import type { Route } from "./route";
import { isOwnerRoute } from "./route.ts";

export type Role = "CLIENT" | "OPERATOR" | "PLATFORM";
export type NavIcon = "jobs" | "plus" | "search" | "dashboard" | "shield" | "printer" | "play" | "bids" | "work" | "earnings";
/** A Public item sits under its own label in the sidebar. */
export type NavItem = { readonly to: string; readonly label: string; readonly icon: NavIcon; readonly group?: "Public" | "Agents" };

/** The sample book is the same read-only dashboard for every signed-in role, so each role lists it after its own pages. */
const SAMPLE_BOOK: NavItem = { to: "/studio/sample", label: "Sample book", icon: "dashboard" };

const ROLE_PAGES: Record<Role, readonly NavItem[]> = {
  CLIENT: [
    { to: "/", label: "My jobs", icon: "jobs" },
    { to: "/jobs/new", label: "Post a job", icon: "plus" },
    SAMPLE_BOOK,
  ],
  // Tutorials joins this list in O5, once its page exists.
  OPERATOR: [
    { to: "/operator", label: "Find work", icon: "search" },
    { to: "/operator/bids", label: "My bids", icon: "bids" },
    { to: "/operator/work", label: "My work", icon: "work" },
    { to: "/operator/earnings", label: "Earnings", icon: "earnings" },
    { to: "/studio", label: "Dashboards", icon: "dashboard" },
    SAMPLE_BOOK,
  ],
  PLATFORM: [{ to: "/studio", label: "Dashboards", icon: "dashboard" }, SAMPLE_BOOK],
};

/** Every role also gets these two pages, under the Public label. /cli is reached from the link the terminal prints. */
const PUBLIC_PAGES: readonly NavItem[] = [
  { to: "/verifiers", label: "Verifiers", icon: "shield", group: "Public" },
  { to: "/print", label: "Print verifier", icon: "printer", group: "Public" },
];

const SCENARIOS: NavItem = { to: "/tour", label: "Scenarios", icon: "play", group: "Public" };

const AGENT_PAGES: readonly NavItem[] = [
  { to: "/specialists", label: "Your agent", icon: "plus", group: "Agents" },
  { to: "/leaderboard", label: "Leaderboard", icon: "dashboard", group: "Agents" },
];

/** A run starts on the account's own visitor, and a platform session is not one, so the platform does not list Scenarios. */
export function navFor(role: Role): readonly NavItem[] {
  return role === "PLATFORM" ? [...ROLE_PAGES[role], ...PUBLIC_PAGES] : [...ROLE_PAGES[role], ...AGENT_PAGES, ...PUBLIC_PAGES, SCENARIOS];
}

/** Signed out, the sidebar lists the public pages; the Try Acquit button sits under them. */
export function signedOutNav(): readonly NavItem[] {
  return PUBLIC_PAGES;
}

/** "/" is a role's first page, so that page stays lit there; a job page keeps My jobs lit for a client and Find work for an operator. */
export function isNavActive(item: NavItem, path: string, role: Role | null): boolean {
  path = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (path === item.to) return true;
  if (item.to === "/specialists" && isOwnerRoute(path) && path !== "/leaderboard") return true;
  if (path === "/" && role !== null && ROLE_PAGES[role][0]?.to === item.to) return true;
  const jobPage = path.startsWith("/jobs/") && path !== "/jobs/new";
  if (!jobPage) return false;
  return (role === "CLIENT" && item.to === "/") || (role === "OPERATOR" && item.to === "/operator");
}

const ROLE_EYEBROW: Record<Role, string> = { CLIENT: "Client", OPERATOR: "Operator", PLATFORM: "Platform" };

/** The top bar's mono eyebrow and title for a route. Pages keep their own headings below it. */
export function pageHeading(route: Route, role: Role | null): { eyebrow: string; title: string } {
  const eyebrow = role === null ? "Public" : ROLE_EYEBROW[role];
  switch (route.name) {
    case "home":
      return { eyebrow, title: role === "CLIENT" ? "My jobs" : role === "OPERATOR" ? "Find work" : "Dashboards" };
    case "demo":
    case "start":
      return { eyebrow: "Welcome", title: "Try Acquit" };
    case "welcomeBack":
      return { eyebrow: "Welcome", title: "Welcome back" };
    case "newJob":
      return { eyebrow, title: "Post a job" };
    case "job":
      return { eyebrow, title: "Job" };
    case "receipt":
      return { eyebrow: "Receipt", title: "Public receipt" };
    case "verifiers":
      return { eyebrow: "Public", title: "Verifiers" };
    case "print":
      return { eyebrow: "Public", title: "Print verifier" };
    case "tour":
      return { eyebrow, title: "Scenarios" };
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
    case "studioSample":
      return { eyebrow, title: "Sample book" };
    case "specialists":
      return { eyebrow: "Specialists", title: "Plug in" };
    case "specialistExam":
      return { eyebrow: "Specialists", title: "The exam" };
    case "specialistOrders":
      return { eyebrow: "Specialists", title: "Standing orders" };
    case "specialistActivity":
      return { eyebrow: "Specialists", title: "Activity" };
    case "specialistEarnings":
      return { eyebrow: "Specialists", title: "Earnings" };
    case "specialistLeaderboard":
      return { eyebrow: "Specialists", title: "Leaderboard" };
    case "notFound":
      return { eyebrow: "Acquit", title: "Page not found" };
  }
}
