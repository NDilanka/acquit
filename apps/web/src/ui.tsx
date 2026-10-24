import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { describeError } from "./errors";
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

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog for a confirmation, a form, or a side panel. It traps focus, closes on Escape or a click on the
 * scrim, names itself by its title, and gives focus back to the control that opened it. A drawer slides in from
 * the right, and becomes a bottom sheet on a phone.
 */
export function Modal({
  title,
  onClose,
  variant = "dialog",
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  variant?: "dialog" | "drawer";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => opener?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`dialog-scrim ${variant}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className={`dialog ${variant}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn ghost sm dialog-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** A confirmation: one sentence, a cancel, and the one action. `danger` marks an action that cannot be undone. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Back",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn${danger ? " danger-solid" : ""}`} disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="dialog-text">{body}</p>
    </Modal>
  );
}

/** A loading card: grey bars where the content will be, read by a screen reader as one "Loading" line. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card pad skeleton-card" aria-hidden="true">
      <span className="skeleton skeleton-title" />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton skeleton-line" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function SkeletonList({ count = 3, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="skeleton-list" role="status">
      <span className="sr-only">Loading</span>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}

/** A failed read or action: the plain sentence, and a Details line only when the page has no sentence for the code. */
export function ErrorNote({ error }: { error: unknown }) {
  const { message, details } = describeError(error);
  return (
    <div className="alert" role="alert">
      <p className="alert-msg">{message}</p>
      {details && <CopyDetails value={details} />}
    </div>
  );
}

function CopyDetails({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <p className="details-line">
      <span>Details</span>
      <button type="button" className="details-code mono" title="Copy the details" onClick={copy}>
        {copied ? "Copied" : value}
      </button>
    </p>
  );
}
