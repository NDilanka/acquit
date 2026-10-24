import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { parseChoice, resolveTheme, THEME_KEY, type Theme, type ThemeChoice } from "./theme";

type ThemeState = { readonly choice: ThemeChoice; readonly theme: Theme; readonly setChoice: (choice: ThemeChoice) => void };

const ThemeContext = createContext<ThemeState | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedChoice(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

/** Owns the Dark / Light / System choice and writes the resolved theme to data-theme on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => parseChoice(storedChoice()));
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const theme = resolveTheme(choice, prefersDark);

  // A layout effect runs before the browser paints, so the first frame already has the right colours.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const value = useMemo<ThemeState>(
    () => ({
      choice,
      theme,
      setChoice: (next) => {
        setChoiceState(next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // Private browsing can refuse storage; the choice still holds for this page.
        }
      },
    }),
    [choice, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
