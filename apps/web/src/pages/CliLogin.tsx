import { useState } from "react";
import { api, ApiError } from "../api";
import { approveFailure, codeHint, type Copy, type Failure, isCodeFormat, NOT_VALID, signInPrompt } from "../cli";
import { useRouter } from "../router";
import { useSession } from "../session";

type State = { kind: "ready" } | { kind: "busy" } | { kind: "done" } | { kind: "dead"; failure: Failure };

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
      const failure = e instanceof ApiError ? approveFailure(e.status, e.code) : null;
      if (failure) {
        setState({ kind: "dead", failure });
        return;
      }
      setError(e instanceof ApiError ? e.message : `Network error: ${String(e)}. Retry is safe.`);
      setState({ kind: "ready" });
    }
  };

  const refusal = code !== "" && !isCodeFormat(code) ? NOT_VALID : state.kind === "dead" ? state.failure : null;

  return (
    <div className="signin card">
      <div className="eyebrow">Acquit CLI</div>
      {!code ? (
        <>
          <h1>No sign-in code</h1>
          <p className="muted">
            This link has no sign-in code. Run <span className="mono">acquit login</span> again.
          </p>
        </>
      ) : refusal ? (
        <>
          <h1>{refusal.title}</h1>
          <p className="muted">
            <CopyLine copy={refusal.body} />
          </p>
        </>
      ) : state.kind === "done" ? (
        <>
          <h1>CLI approved</h1>
          <p>Signed in. You can return to the terminal.</p>
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

/** Renders CLI copy, drawing each code part as inline code. */
function CopyLine({ copy }: { copy: Copy }) {
  return (
    <>
      {copy.map((part, i) =>
        typeof part === "string" ? part : <span key={i} className="mono">{part.code}</span>,
      )}
    </>
  );
}
