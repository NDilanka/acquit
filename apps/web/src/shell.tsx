import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { isNavActive, navFor, signedOutNav, type NavItem, type Role } from "./nav";
import { Link, useRouter } from "./router";
import { match, showsDemoCta } from "./route";
import type { Session } from "./session";
import { useTheme } from "./theme-context";
import type { ThemeChoice } from "./theme";

const HELP_URL = "https://github.com/NDilanka/acquit#readme";

const ROLE_CAPTION: Record<Role, string> = { CLIENT: "Client", OPERATOR: "Operator", PLATFORM: "Platform" };

const THEME_CHOICES: readonly { readonly choice: ThemeChoice; readonly label: string }[] = [
  { choice: "dark", label: "Dark" },
  { choice: "light", label: "Light" },
  { choice: "system", label: "System" },
];

/** The sidebar, the top bar, and the page panel. Every page renders inside it except the signed-out landing. */
export function Shell({
  session,
  heading,
  onSignOut,
  children,
}: {
  session: Session | null | undefined;
  heading: { readonly eyebrow: string; readonly title: string };
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { location } = useRouter();
  const path = location.path;
  const [menuOpen, setMenuOpen] = useState(false);
  const signedIn = session === undefined ? undefined : session !== null;
  const role: Role | null = session ? session.user.role : null;
  const items: readonly NavItem[] = session ? navFor(session.user.role) : signedIn === false ? signedOutNav() : [];

  // Moving to another page closes the mobile sheet; Escape closes it too.
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="app">
      <header className="mbar">
        <Link to="/" className="side-brand">
          <span className="side-mark">A</span>
          <span>Acquit</span>
        </Link>
        <button type="button" className="mbar-menu" aria-label="Open the menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>
      </header>
      <div className="frame">
        <aside className={`side${menuOpen ? " open" : ""}`} aria-label="Sidebar">
          <div className="side-top">
            <Link to="/" className="side-brand">
              <span className="side-mark">A</span>
              <span>Acquit</span>
            </Link>
            <button type="button" className="side-close" aria-label="Close the menu" onClick={() => setMenuOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          {signedIn !== undefined && <p className="side-label mono">{signedIn ? "Your workspace" : "Public pages"}</p>}
          <nav className="side-nav" aria-label="Pages">
            {items.map((item) => (
              <Link key={item.to} to={item.to} className={`side-item${isNavActive(item, path, role) ? " on" : ""}`}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className="side-foot">
            {showsDemoCta(match(path), signedIn) && (
              <Link to="/demo" className="btn side-cta">
                Start the demo
              </Link>
            )}
            {session ? (
              <AccountCard session={session} onSignOut={onSignOut} />
            ) : signedIn === false ? (
              <ThemeSwitch />
            ) : null}
          </div>
        </aside>
        <div className="stage">
          <header className="topbar">
            <div className="topbar-title">
              <p className="eyebrow mono">{heading.eyebrow}</p>
              <p className="topbar-h">{heading.title}</p>
            </div>
            <div className="topbar-right">
              <span className="topbar-date">{today}</span>
              <span className="sandbox" title="PayPal sandbox. No real money moves.">Sandbox</span>
            </div>
          </header>
          {children}
        </div>
      </div>
      {menuOpen && <div className="side-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}

/** Dark, Light, System. The choice is saved, and System follows the operating system. */
export function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {THEME_CHOICES.map((option) => {
        const on = choice === option.choice;
        return (
          <button
            key={option.choice}
            type="button"
            role="radio"
            aria-checked={on}
            className={on ? "on" : ""}
            onClick={() => setChoice(option.choice)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The bottom card of the sidebar. It opens a menu with the theme switch, Help, and Sign out. */
function AccountCard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const user = session.user;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!card.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="acct" ref={card}>
      {open && (
        <div className="acct-menu">
          <div className="acct-theme">
            <span className="acct-label">Theme</span>
            <ThemeSwitch />
          </div>
          <a className="acct-item" href={HELP_URL} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            <Icon name="help" size={16} />
            Help
          </a>
          <button
            type="button"
            className="acct-item"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="logout" size={16} />
            {session.visitor ? "Leave demo" : "Sign out"}
          </button>
        </div>
      )}
      <button type="button" className="acct-card" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="acct-avatar" aria-hidden="true">
          {user.handle.slice(0, 2).toUpperCase()}
        </span>
        <span className="acct-text">
          <b>{user.handle}</b>
          <small>{ROLE_CAPTION[user.role]}</small>
        </span>
        <Icon name="chevrons" size={14} />
      </button>
    </div>
  );
}
