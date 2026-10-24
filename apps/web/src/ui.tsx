import { useState, type ReactNode } from "react";
import { shortId } from "./format";
import { statusLabel, type StatusInput } from "./job-status";
import { Icon, type IconName } from "./icons";
import { notFoundLink } from "./not-found";
import { Link } from "./router";

export function StatusPill({ job }: { job: StatusInput }) {
  const { label, tone } = statusLabel(job);
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

/** A job id, commit, or PayPal id as a small chip. The full value rides on hover and copies on click. */
export function IdChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <button type="button" className={`idchip${copied ? " copied" : ""}`} title={value} aria-label={`Copy ${value}`} onClick={copy}>
      {copied ? "Copied" : shortId(value)}
    </button>
  );
}

/** The one not-found layout for a missing page, job, or receipt, and a page another role may not open: a heading, one sentence, and the link for the visitor's role. */
export function NotFound({
  title = "Page not found",
  message = "Nothing lives at this address.",
  signedIn,
}: {
  title?: string;
  message?: string;
  signedIn: boolean;
}) {
  const link = notFoundLink(signedIn);
  return (
    <section className="card pad notfound">
      <h1>{title}</h1>
      <p className="muted">{message}</p>
      <p>
        <Link to={link.to} className="btn sm">
          {link.label}
        </Link>
      </p>
    </section>
  );
}

export function RepoLink({ repository }: { repository: string | null }) {
  return repository ? (
    <a className="mono" href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">
      {repository}
    </a>
  ) : (
    <>the deployment's shared repository</>
  );
}

/** What the demo connected for the visitor: shown once at sign-up and on the client's dashboard. */
export function ConnectedRepo({ repository }: { repository: string | null }) {
  return (
    <p className="connected">
      <b>Connected: issues, pull requests, checks</b>
      <span>
        Repository <RepoLink repository={repository} />
      </span>
    </p>
  );
}

/** The empty state: an icon, one sentence, and at most one action. */
export function EmptyState({
  icon = "jobs",
  action,
  children,
}: {
  icon?: IconName;
  action?: { readonly to: string; readonly label: string };
  children: ReactNode;
}) {
  return (
    <section className="card empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={18} />
      </span>
      <p>{children}</p>
      {action && (
        <Link to={action.to} className="btn secondary sm">
          {action.label}
        </Link>
      )}
    </section>
  );
}

/** A figure with its label: a mono caption over a large number, and an optional note. */
export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <p className="stat-label mono">{label}</p>
      <p className="stat-value">{value}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

/** A segmented toggle, like the Figma Grid / List control. The pressed segment is the raised one. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  round = false,
}: {
  label: string;
  options: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onChange: (value: T) => void;
  round?: boolean;
}) {
  return (
    <div className={`segmented${round ? " round" : ""}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
