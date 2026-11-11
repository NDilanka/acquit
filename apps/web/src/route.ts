export type Route =
  | { name: "home" }
  | { name: "demo" }
  | { name: "start" }
  | { name: "welcomeBack" }
  | { name: "newJob" }
  | { name: "job"; id: string }
  | { name: "receipt"; id: string }
  | { name: "verifiers" }
  | { name: "print" }
  | { name: "inspect" }
  | { name: "howWorkIsChecked" }
  | { name: "tour" }
  | { name: "operator" }
  | { name: "operatorBids" }
  | { name: "operatorWork" }
  | { name: "operatorEarnings" }
  | { name: "cli" }
  | { name: "studio" }
  | { name: "studioSample" }
  | { name: "specialists" }
  | { name: "specialistExam"; agentId?: string }
  | { name: "specialistOrders"; agentId?: string }
  | { name: "specialistActivity"; agentId?: string }
  | { name: "specialistEarnings" }
  | { name: "specialistLeaderboard" }
  | { name: "agentRecord"; agentId: string }
  | { name: "notFound" };

type AgentPage = "specialistExam" | "specialistOrders" | "specialistActivity";

export function isOwnerRoute(path: string): boolean {
  return /^\/specialists(?:\/|$)/.test(path) || /^\/(?:earnings|leaderboard|how-work-is-checked|inspect)\/?$/.test(path) || /^\/agents\/[^/]+\/record\/?$/.test(path);
}

/** Old bookmarks replace their address, preserving the selected agent and query. */
export function ownerRouteUrl(url: string): string {
  return url.replace(/^\/specialists\/night(?=\/|[?#]|$)/, "/specialists/activity")
    .replace(/^\/specialists\/(?:morning|earnings)\/?(?=[?#]|$)/, "/earnings")
    .replace(/^\/specialists\/(?:floor|leaderboard)\/?(?=[?#]|$)/, "/leaderboard")
    .replace(/^\/(?:verifiers|print)\/?(?=[?#]|$)/, "/how-work-is-checked");
}

export function signUpPath(path: string, role: string): string {
  return isOwnerRoute(path) || role === "OPERATOR" ? "/specialists" : "/";
}

/** A specialist page may name its agent in the path, as in `/specialists/exam/<id>`; a bare path leaves the choice to the page. */
function agentPage(name: AgentPage, segment: string | undefined): Route {
  return segment ? { name, agentId: decodeURIComponent(segment) } : { name };
}

export function match(path: string): Route {
  path = ownerRouteUrl(path);
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/demo" || path === "/demo/") return { name: "demo" };
  if (path === "/start" || path === "/start/") return { name: "start" };
  if (path === "/welcome-back" || path === "/welcome-back/") return { name: "welcomeBack" };
  if (path === "/jobs/new") return { name: "newJob" };
  if (path === "/operator" || path === "/operator/") return { name: "operator" };
  if (path === "/operator/bids") return { name: "operatorBids" };
  if (path === "/operator/work") return { name: "operatorWork" };
  if (path === "/operator/earnings") return { name: "operatorEarnings" };
  if (path === "/cli") return { name: "cli" };
  if (path === "/studio") return { name: "studio" };
  if (path === "/studio/sample" || path === "/studio/sample/") return { name: "studioSample" };
  if (path === "/verifiers" || path === "/verifiers/") return { name: "verifiers" };
  if (path === "/print" || path === "/print/") return { name: "print" };
  if (path === "/inspect" || path === "/inspect/") return { name: "inspect" };
  if (path === "/tour" || path === "/tour/") return { name: "tour" };
  if (/^\/how-work-is-checked\/?$/.test(path)) return { name: "howWorkIsChecked" };
  if (/^\/specialists\/?$/.test(path)) return { name: "specialists" };
  if (/^\/earnings\/?$/.test(path)) return { name: "specialistEarnings" };
  if (/^\/leaderboard\/?$/.test(path)) return { name: "specialistLeaderboard" };
  const record = /^\/agents\/([^/]+)\/record\/?$/.exec(path);
  if (record?.[1]) return { name: "agentRecord", agentId: decodeURIComponent(record[1]) };
  const exam = /^\/specialists\/exam(?:\/([^/]+))?\/?$/.exec(path);
  if (exam) return agentPage("specialistExam", exam[1]);
  const orders = /^\/specialists\/orders(?:\/([^/]+))?\/?$/.exec(path);
  if (orders) return agentPage("specialistOrders", orders[1]);
  const activity = /^\/specialists\/activity(?:\/([^/]+))?\/?$/.exec(path);
  if (activity) return agentPage("specialistActivity", activity[1]);
  const job = /^\/jobs\/([^/]+)\/?$/.exec(path);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) };
  const receipt = /^\/receipts\/([^/]+)\/?$/.exec(path);
  if (receipt?.[1]) return { name: "receipt", id: decodeURIComponent(receipt[1]) };
  return { name: "notFound" };
}

/** What a signed-out browser sees on a route. `/demo` is the old address of `/start`, so it moves there, and so do the scenarios. */
export function signedOutPage(route: Route): "landing" | "signIn" | "notFound" | "toStart" | "welcomeBack" | "public" {
  switch (route.name) {
    case "home":
      return "landing";
    case "notFound":
      return "notFound";
    case "demo":
    case "tour":
      return "toStart";
    case "welcomeBack":
      return "welcomeBack";
    case "agentRecord":
    case "specialistLeaderboard":
    case "howWorkIsChecked":
    case "inspect":
    case "receipt":
      return "public";
    case "verifiers":
    case "print":
    case "start":
    case "newJob":
    case "job":
    case "operator":
    case "operatorBids":
    case "operatorWork":
    case "operatorEarnings":
    case "cli":
    case "studio":
    case "studioSample":
    case "specialists":
    case "specialistExam":
    case "specialistOrders":
    case "specialistActivity":
    case "specialistEarnings":
      return "signIn";
  }
}

// The call to action waits while the session loads (undefined), so it never flashes for a signed-in user. The pages
// that carry their own Try Acquit button do not get a second one.
export function showsTryCta(route: Route, signedIn: boolean | undefined): boolean {
  return signedIn === false && route.name !== "demo" && route.name !== "start" && route.name !== "welcomeBack";
}
