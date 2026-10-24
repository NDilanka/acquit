/** The app's colour theme. Light is the default; System follows the operating system. */
export type ThemeChoice = "dark" | "light" | "system";
export type Theme = "dark" | "light";

/** The landing page keeps its own key (acquit:mode), so the two never share a value. */
export const THEME_KEY = "acquit.theme";

/** A stored value that is not Dark or System is Light, the default. */
export function parseChoice(stored: string | null): ThemeChoice {
  return stored === "dark" || stored === "system" ? stored : "light";
}

/** The theme on screen: Dark or Light as chosen, or the operating system's preference for System. */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  const choice = parseChoice(stored);
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}
