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
  | { name: "operator" }
  | { name: "operatorBids" }
  | { name: "operatorWork" }
  | { name: "operatorEarnings" }
  | { name: "cli" }
  | { name: "studio" }
  | { name: "notFound" };

export function match(path: string): Route {
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
  if (path === "/verifiers" || path === "/verifiers/") return { name: "verifiers" };
  if (path === "/print" || path === "/print/") return { name: "print" };
  const job = /^\/jobs\/([^/]+)\/?$/.exec(path);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) };
  const receipt = /^\/receipts\/([^/]+)\/?$/.exec(path);
  if (receipt?.[1]) return { name: "receipt", id: decodeURIComponent(receipt[1]) };
  return { name: "notFound" };
}

/** What a signed-out browser sees on a route. `/demo` is the old address of `/start`, so it moves there. */
export function signedOutPage(route: Route): "landing" | "signIn" | "notFound" | "toStart" | "welcomeBack" {
  switch (route.name) {
    case "home":
      return "landing";
    case "notFound":
      return "notFound";
    case "demo":
      return "toStart";
    case "welcomeBack":
      return "welcomeBack";
    case "receipt":
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
      return "signIn";
  }
}

// The call to action waits while the session loads (undefined), so it never flashes for a signed-in user. The pages
// that carry their own Try Acquit button do not get a second one.
export function showsTryCta(route: Route, signedIn: boolean | undefined): boolean {
  return signedIn === false && route.name !== "demo" && route.name !== "start" && route.name !== "welcomeBack";
}
