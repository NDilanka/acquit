(() => {
  const root = document.getElementById("audiences");
  if (!root) return;

  Acq.ready.then(() => {
    let hover = "";
    let focus = "";
    const apply = () => {
      root.dataset.focus = hover || focus;
    };

    root.querySelectorAll(".aud-half").forEach((half) => {
      const side = half.dataset.side;
      half.addEventListener("pointerenter", (e) => {
        if (e.pointerType !== "mouse" || !Acq.fine) return;
        hover = side;
        apply();
      });
      half.addEventListener("pointerleave", (e) => {
        if (e.pointerType !== "mouse") return;
        hover = "";
        apply();
      });
      half.addEventListener("focusin", (e) => {
        if (!e.target.matches(":focus-visible")) return;
        focus = side;
        apply();
      });
      half.addEventListener("focusout", () => {
        focus = "";
        apply();
      });
    });
  });
})();
