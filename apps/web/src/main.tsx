const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// A signed-in visitor's "/" is their dashboard, so only a signed-out one gets the landing.
async function signedIn(): Promise<boolean> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return false;
    const body = (await res.json()) as { user?: unknown };
    return Boolean(body.user);
  } catch {
    return false;
  }
}

// The landing page has its own CSS and motion, so it loads as its own entry. The app's styles load only with the app.
if (location.pathname === "/" && !(await signedIn())) {
  const { mountLanding } = await import("./landing");
  await mountLanding(root);
} else {
  const [{ StrictMode }, { createRoot }, { App }, { Router }, { ThemeProvider }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./App"),
    import("./router"),
    import("./theme-context"),
    import("./styles.css"),
  ]);
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <Router>
          <App />
        </Router>
      </ThemeProvider>
    </StrictMode>,
  );
}
