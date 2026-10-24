import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** How long a completed action stays on screen. */
export const TOAST_MS = 5000;

type Shown = { readonly id: number; readonly message: string };
type Show = (message: string) => void;

const ToastContext = createContext<Show | null>(null);

/**
 * One toast region for the app. It is a polite live region that is always mounted, so a screen reader hears
 * each message. A new toast replaces the one on screen, and each one leaves after TOAST_MS.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback<Show>((message) => {
    window.clearTimeout(timer.current);
    setShown({ id: Date.now(), message });
    timer.current = window.setTimeout(() => setShown(null), TOAST_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {shown && (
          <p key={shown.id} className="toast">
            {shown.message}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  );
}

/** Returns the function that shows a toast. Call it once an action has completed. */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast outside ToastProvider");
  return show;
}
