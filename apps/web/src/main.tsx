const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The landing page has its own CSS and motion, so it loads as its own entry. The app's styles load only with the app.
if (location.pathname === "/") {
  const { mountLanding } = await import("./landing");
  await mountLanding(root);
} else {
  const [{ StrictMode }, { createRoot }, { App }, { Router }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./App"),
    import("./router"),
    import("./styles.css"),
  ]);
  createRoot(root).render(
    <StrictMode>
      <Router>
        <App />
      </Router>
    </StrictMode>,
  );
}
