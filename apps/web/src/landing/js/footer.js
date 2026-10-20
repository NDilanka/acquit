import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

(() => {
  const footer = document.querySelector(".footer");
  if (!footer) return;

  Acq.ready.then(() => {
    const { reduce, fine } = Acq;
    const slot = footer.querySelector(".logo-slot-xl");
    const word = footer.querySelector(".ft-word");
    const letters = [...word.querySelectorAll(".ft-letter")];
    const rises = [...word.querySelectorAll(".ft-rise")];
    const N = letters.length;
    // Proximity widens a glyph along scaleX, up to 1 + GROW at the pointer.
    const GROW = 0.35;

    let slotW = 0;
    let left = 0;
    let nat = [];
    let vbX = 0, vbY = 0, vbH = 0;
    const cur = new Array(N).fill(0);
    let pointerX = null;
    let live = false;

    // Lays glyphs out left to right in SVG user units; wider glyphs push their right neighbours along.
    const model = () => {
      const xs = new Array(N);
      const ws = new Array(N);
      let shift = 0;
      let right = 0;
      for (let k = 0; k < N; k++) {
        const f = 1 + GROW * cur[k];
        ws[k] = nat[k].w * f;
        xs[k] = nat[k].x - vbX + shift;
        shift += (f - 1) * nat[k].w;
        right = Math.max(right, xs[k] + ws[k]);
      }
      const centers = xs.map((x, k) => x + ws[k] / 2);
      return { centers, total: right, px: slotW / right };
    };

    // Each glyph scales about its own centre, then moves to its laid-out centre.
    const paint = (m) => {
      for (let k = 0; k < N; k++) {
        const f = 1 + GROW * cur[k];
        const { x, w } = nat[k];
        const e = vbX + m.centers[k] - f * (x + w / 2);
        letters[k].setAttribute("transform", `matrix(${f.toFixed(4)} 0 0 1 ${e.toFixed(3)} 0)`);
      }
      word.setAttribute("viewBox", `${vbX} ${vbY} ${m.total.toFixed(3)} ${vbH}`);
    };

    const measure = () => {
      const box = slot.getBoundingClientRect();
      slotW = box.width;
      left = box.left;
      letters.forEach((el) => el.removeAttribute("transform"));
      const boxes = letters.map((el) => el.getBBox());
      nat = boxes.map((b) => ({ x: b.x, w: b.width }));
      vbX = Math.min(...boxes.map((b) => b.x));
      vbY = Math.min(...boxes.map((b) => b.y));
      vbH = Math.max(...boxes.map((b) => b.y + b.height)) - vbY;
      cur.fill(0);
      paint(model());
    };

    let rz = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(rz);
      rz = requestAnimationFrame(measure);
    });
    measure();

    if (!reduce) {
      gsap.from(rises, {
        y: () => vbH * 1.04,
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.06,
        scrollTrigger: { trigger: slot, start: "top 85%", once: true },
      });
    }

    if (fine && !reduce) {
      slot.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        pointerX = e.clientX;
        live = true;
      });
      slot.addEventListener("pointerleave", (e) => {
        if (e.pointerType !== "mouse") return;
        pointerX = null;
        live = true;
      });

      gsap.ticker.add((_, dtMs) => {
        if (!live) return;
        const dt = Math.min(dtMs, 50) / 1000;
        const k = 1 - Math.exp(-dt * 9);
        const m0 = model();
        let settled = pointerX === null;
        for (let i = 0; i < N; i++) {
          let goal = 0;
          if (pointerX !== null) {
            const d = Math.abs(pointerX - (left + m0.px * m0.centers[i]));
            const t = Math.min(d / 320, 1);
            goal = 1 - t * t * (3 - 2 * t);
          }
          cur[i] += (goal - cur[i]) * k;
          if (Math.abs(cur[i]) > 0.001) settled = false;
        }
        if (settled) {
          cur.fill(0);
          live = false;
        }
        paint(model());
      });
    }
  });
})();
