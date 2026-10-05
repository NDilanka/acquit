import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";

type Location = { path: string; search: URLSearchParams };

const RouterContext = createContext<{ location: Location; navigate: (to: string, replace?: boolean) => void } | null>(
  null,
);

function read(): Location {
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string, replace = false) => {
    if (replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLocation(read());
    window.scrollTo(0, 0);
  };
  return <RouterContext.Provider value={{ location, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter outside Router");
  return ctx;
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

export type Route =
  | { name: "home" }
  | { name: "newJob" }
  | { name: "job"; id: string }
  | { name: "operator" }
  | { name: "notFound" };

export function match(path: string): Route {
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/jobs/new") return { name: "newJob" };
  if (path === "/operator") return { name: "operator" };
  const job = /^\/jobs\/([^/]+)\/?$/.exec(path);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) };
  return { name: "notFound" };
}
