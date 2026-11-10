import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { pageHeading } from "./nav";
import { match, ownerRouteUrl } from "./route";

type Location = { path: string; search: URLSearchParams };

const RouterContext = createContext<{ location: Location; navigate: (to: string, replace?: boolean) => void; guard: { current: (() => boolean) | null } } | null>(
  null,
);

function read(): Location {
  const current = window.location.pathname + window.location.search + window.location.hash;
  const canonical = ownerRouteUrl(current);
  if (canonical !== current) window.history.replaceState(window.history.state, "", canonical);
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(read);
  const guard = useRef<(() => boolean) | null>(null);
  const historyIndex = useRef(0);
  const restoring = useRef(false);
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, acquitIndex: 0 }, "");
    const onPop = () => {
      const index = window.history.state?.acquitIndex;
      if (restoring.current) { restoring.current = false; return; }
      if (guard.current && !guard.current()) {
        if (typeof index === "number" && index !== historyIndex.current) {
          restoring.current = true;
          window.history.go(historyIndex.current - index);
        }
        return;
      }
      if (typeof index === "number") historyIndex.current = index;
      setLocation(read());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    document.title = `${pageHeading(match(location.path), null).title} · Acquit`;
    let focused = false;
    let frame = 0;
    const announce = () => {
      const heading = document.querySelector<HTMLElement>("h1");
      if (!heading) return;
      document.title = `${heading.textContent?.trim() || "Acquit"} · Acquit`;
      if (!focused) {
        focused = true;
        frame = requestAnimationFrame(() => {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        });
      }
    };
    const observer = new MutationObserver(announce);
    observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true, characterData: true });
    announce();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [location.path]);
  const navigate = (to: string, replace = false) => {
    if (guard.current && !guard.current()) return;
    to = ownerRouteUrl(to);
    if (replace) window.history.replaceState({ acquitIndex: historyIndex.current }, "", to);
    else window.history.pushState({ acquitIndex: ++historyIndex.current }, "", to);
    setLocation(read());
    window.scrollTo(0, 0);
  };
  return <RouterContext.Provider value={{ location, navigate, guard }}>{children}</RouterContext.Provider>;
}

/** Both SPA navigation (including Back) and closing/reloading protect an edited draft. */
export function useNavigationGuard(dirty: boolean, message: string) {
  const { guard } = useRouter();
  useEffect(() => {
    if (!dirty) return;
    const confirm = () => window.confirm(message);
    guard.current = confirm;
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { if (guard.current === confirm) guard.current = null; window.removeEventListener("beforeunload", beforeUnload); };
  }, [dirty, message, guard]);
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter outside Router");
  return ctx;
}

export function Link({ to, className, tour, children, "aria-current": current }: { to: string; className?: string; tour?: string; children: ReactNode; "aria-current"?: "page" }) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} data-tour={tour} aria-current={current} onClick={onClick}>
      {children}
    </a>
  );
}
