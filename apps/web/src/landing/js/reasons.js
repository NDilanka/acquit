(() => {
  const section = document.querySelector(".reasons");
  if (!section) return;

  Acq.ready.then(() => {
    if (Acq.reduce) return;
    section.querySelectorAll(".rs-row").forEach((row) => {
      const idx = row.querySelector(".rs-idx");
      row.addEventListener("pointerenter", (e) => {
        if (e.pointerType !== "mouse") return;
        Acq.scramble(idx, { text: idx.dataset.idx, duration: 0.45, swap: 0.04 });
      });
    });
  });
})();
