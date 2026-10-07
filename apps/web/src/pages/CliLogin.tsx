import { useState } from "react";
import { api, ApiError } from "../api";
import { approveFailure, codeHint, signInPrompt } from "../cli";
import { useRouter } from "../router";
import { useSession } from "../session";

type State = { kind: "ready" } | { kind: "busy" } | { kind: "done" } | { kind: "dead"; message: string };

export function CliLogin() {
  const { user } = useSession();
  const { location } = useRouter();
  const code = location.search.get("code") ?? "";
  const [state, setState] = useState<State>({ kind: "ready" });
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setState({ kind: "busy" });
    setError(null);
    try {
      await api.approveCli(code);
      setState({ kind: "done" });
    } catch (e) {
      const dead = e instanceof ApiError ? approveFailure(e.status, e.code) : null;
      if (dead) {
        setState({ kind: "dead", message: dead });
        return;
      }
      setError(e instanceof ApiError ? e.message : `Network error: ${String(e)}. Retry is safe.`);
      setState({ kind: "ready" });
    }
  };

  return (
    <div className="signin card">
      <div className="eyebrow">Acquit CLI</div>
      {!code ? (
        <>
          <h1>No sign-in code</h1>
          <p className="muted">This link has no sign-in code. Run `acquit login` again.</p>
        </>
      ) : state.kind === "done" ? (
        <>
          <h1>CLI approved</h1>
          <p>Signed in. You can return to the terminal.</p>
        </>
      ) : state.kind === "dead" ? (
        <>
          <h1>Link no longer valid</h1>
          <p className="muted">{state.message}</p>
        </>
      ) : (
        <>
          <h1>{signInPrompt(user)}</h1>
          <p className="muted">
            Approve only if you just ran <span className="mono">acquit login</span>. Check that the link your terminal
            printed has the same code: <span className="mono">{codeHint(code)}</span>
          </p>
          {error && <div className="alert">{error}</div>}
          <button className="btn green" disabled={state.kind === "busy"} onClick={() => void approve()}>
            {state.kind === "busy" ? "Approving…" : "Approve"}
          </button>
        </>
      )}
    </div>
  );
}
