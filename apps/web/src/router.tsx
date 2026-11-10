import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { pageHeading } from "./nav";
import { match } from "./route";

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
