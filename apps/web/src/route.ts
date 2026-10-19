export type Route =
  | { name: "home" }
  | { name: "demo" }
  | { name: "newJob" }
  | { name: "job"; id: string }
  | { name: "receipt"; id: string }
  | { name: "operator" }
  | { name: "cli" }
  | { name: "studio" }
  | { name: "notFound" };

export function match(path: string): Route {
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/demo" || path === "/demo/") return { name: "demo" };
  if (path === "/jobs/new") return { name: "newJob" };
  if (path === "/operator") return { name: "operator" };
  if (path === "/cli") return { name: "cli" };
  if (path === "/studio") return { name: "studio" };
  const job = /^\/jobs\/([^/]+)\/?$/.exec(path);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) };
  const receipt = /^\/receipts\/([^/]+)\/?$/.exec(path);
  if (receipt?.[1]) return { name: "receipt", id: decodeURIComponent(receipt[1]) };
  return { name: "notFound" };
}

export function signedOutPage(route: Route): "landing" | "signIn" | "notFound" {
  switch (route.name) {
    case "home":
      return "landing";
    case "notFound":
      return "notFound";
    case "receipt":
    case "demo":
    case "newJob":
    case "job":
    case "operator":
    case "cli":
    case "studio":
      return "signIn";
  }
}

// The call to action waits while the session loads (undefined), so it never flashes for a signed-in visitor.
export function showsDemoCta(route: Route, signedIn: boolean | undefined): boolean {
  return signedIn === false && route.name !== "demo";
}
