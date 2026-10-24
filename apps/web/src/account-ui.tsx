import { useEffect, useState } from "react";
import { api } from "./api";
import type { AccountView, SessionUser } from "./api-types";
import { afterSwitch, markLinkSaved, recoveryLink, SAVE_COPY, signOutPrompt, switchedToast } from "./account";
import { useRouter } from "./router";
import type { Session } from "./session";
import { useToast } from "./toast";
import { ConfirmDialog, CopyField, ErrorNote, Modal, Spinner } from "./ui";

type SwitchRole = "CLIENT" | "OPERATOR";

const ROLE_OPTIONS: readonly { readonly value: SwitchRole; readonly label: string }[] = [
  { value: "CLIENT", label: "Client" },
  { value: "OPERATOR", label: "Operator" },
];

/** The Client and Operator switch at the top of the sidebar, for an account that holds both roles. */
export function RoleSwitch({ user, onSwitched }: { user: SessionUser; onSwitched: (session: Session) => void }) {
  const [pending, setPending] = useState<SwitchRole | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { location, navigate } = useRouter();
  const toast = useToast();
  const shown = pending ?? user.role;

  const choose = async (role: SwitchRole) => {
    if (role === user.role || pending !== null) return;
    setPending(role);
    setError(null);
    try {
      const r = await api.switchRole(role);
      const to = afterSwitch(location.path, r.user.role);
      if (to !== location.path) navigate(to);
      onSwitched({ user: r.user, account: r.account });
      toast(switchedToast(r.user.role));
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="role-switch" data-tour="role-switch">
      <div className="segmented full" role="group" aria-label="Work as">
        {ROLE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={shown === option.value}
            disabled={pending !== null}
            onClick={() => void choose(option.value)}
          >
            {pending === option.value && <Spinner />}
            {option.label}
          </button>
        ))}
      </div>
      {error !== null && <ErrorNote error={error} />}
    </div>
  );
}

// A recovery token is answered once and only its digest is stored, so this tab keeps the link it was shown in memory.
// Nothing writes it to storage, where a script on the page could read it long after the tab closes.
let held: { readonly client: string; readonly link: string } | null = null;
let making: { readonly client: string; readonly promise: Promise<string> } | null = null;

function makeLink(client: string): Promise<string> {
  if (making?.client === client) return making.promise;
  const promise = api.makeRecoveryLink().then((r) => {
    const link = recoveryLink(window.location.origin, r.recoveryToken);
    held = { client, link };
    return link;
  });
  making = { client, promise };
  const done = () => {
    if (making?.promise === promise) making = null;
  };
  promise.then(done, done);
  return promise;
}

type SaveState = "making" | "ready" | "earlier" | "error";

/** The account link, its Copy button, and Make a new link. Copying marks the link saved in this browser. */
export function SaveAccountModal({
  account,
  onClose,
  onSavedChange,
}: {
  account: AccountView;
  onClose: () => void;
  onSavedChange: (saved: boolean) => void;
}) {
  const toast = useToast();
  const initial = held?.client === account.client ? held.link : null;
  const [link, setLink] = useState<string | null>(initial);
  const [state, setState] = useState<SaveState>(initial ? "ready" : account.recoveryLinkMade ? "earlier" : "making");
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [renewing, setRenewing] = useState(false);

  useEffect(() => {
    if (state !== "making") return;
    let live = true;
    makeLink(account.client).then(
      (made) => {
        if (!live) return;
        setLink(made);
        setState("ready");
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setState("error");
      },
    );
    return () => {
      live = false;
    };
  }, [state, account.client]);

  const copied = () => {
    markLinkSaved(localStorage, account.client, true);
    onSavedChange(true);
    toast(SAVE_COPY.copied);
  };

  const renew = async () => {
    setRenewing(true);
    setError(null);
    try {
      held = null;
      const made = await makeLink(account.client);
      setLink(made);
      setState("ready");
      markLinkSaved(localStorage, account.client, false);
      onSavedChange(false);
      toast(SAVE_COPY.renewed);
    } catch (e) {
      setError(e);
    } finally {
      setRenewing(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <Modal
        title={SAVE_COPY.title}
        onClose={onClose}
        actions={
          <button type="button" className="btn green" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className="save-account">
          <p className="dialog-text">{SAVE_COPY.body}</p>
          {state === "making" && (
            <p className="muted save-status" role="status">
              <Spinner />
              Making your link…
            </p>
          )}
          {state === "ready" && link && <CopyField label={SAVE_COPY.label} value={link} onCopied={copied} />}
          {state === "earlier" && <p className="muted">{SAVE_COPY.earlier}</p>}
          {error !== null && <ErrorNote error={error} />}
          <div className="alert warn">{SAVE_COPY.warning}</div>
          <div className="save-actions">
            {state === "error" && (
              <button type="button" className="btn secondary sm" onClick={() => setState("making")}>
                Try again
              </button>
            )}
            <button type="button" className="btn secondary sm" disabled={state === "making" || renewing} onClick={() => setConfirming(true)}>
              {SAVE_COPY.renew}
            </button>
          </div>
        </div>
      </Modal>
      {confirming && (
        <ConfirmDialog
          title={SAVE_COPY.confirmTitle}
          body={SAVE_COPY.confirmBody}
          confirmLabel={SAVE_COPY.renew}
          busy={renewing}
          onConfirm={() => void renew()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Sign out, which first asks to save the link when this browser never copied it. */
export function SignOutDialog({
  saved,
  onSignOut,
  onSave,
  onCancel,
}: {
  saved: boolean;
  onSignOut: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const prompt = signOutPrompt(saved);
  if (!prompt.saveFirst) {
    return <ConfirmDialog title={prompt.title} body={prompt.body} confirmLabel={prompt.confirm} cancelLabel={prompt.cancel} onConfirm={onSignOut} onCancel={onCancel} />;
  }
  return (
    <Modal
      title={prompt.title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onSignOut}>
            {prompt.cancel}
          </button>
          <button type="button" className="btn green" onClick={onSave}>
            {prompt.confirm}
          </button>
        </>
      }
    >
      <p className="dialog-text">{prompt.body}</p>
    </Modal>
  );
}
