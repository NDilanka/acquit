import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

(() => {
  const section = document.getElementById("registry");
  if (!section) return;

  Acq.ready.then(() => {
    const { reduce, fine } = Acq;
    const rows = [...section.querySelectorAll(".rg-row")];
    const table = section.querySelector(".rg-table");
    const follow = section.querySelector(".rg-follow");
    const rot = follow.querySelector(".rg-follow__rot");
    const card = follow.querySelector(".rg-follow__card");
    const stage = follow.querySelector(".rg-follow__stage");
    const tag = follow.querySelector(".rg-follow__tag");
    const pad = (n, w = 2) => String(n).padStart(w, "0");

    const WIPE_IN = 0.55;
    const WIPE_OUT = 0.45;
    const WDTH_TIME = 0.6;

    const CUBE = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

    const INIT = {
      render(el) {
        const edges = el.querySelector(".rg-cube__edges");
        const verts = el.querySelector(".rg-cube__verts");
        const frame = el.querySelector(".rg-frame");
        let lastFrame = -1;
        return (t) => {
          const f = Math.floor(t * 24) % 240;
          if (f !== lastFrame) {
            lastFrame = f;
            frame.textContent = `FRAME ${pad(f, 4)} / 0240`;
          }
          const a = (t / 10) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const ct = Math.cos(0.45), st = Math.sin(0.45);
          const pts = CUBE.map(([x, y, z]) => {
            const x1 = x * ca + z * sa;
            const z1 = -x * sa + z * ca;
            const y1 = y * ct - z1 * st;
            const z2 = y * st + z1 * ct;
            const k = 3.2 / (3.2 + z2);
            return [140 + x1 * 40 * k, 100 + y1 * 40 * k];
          });
          let d = "";
          let v = "";
          for (const [a0, b0] of EDGES) {
            d += `M${pts[a0][0].toFixed(2)} ${pts[a0][1].toFixed(2)}L${pts[b0][0].toFixed(2)} ${pts[b0][1].toFixed(2)}`;
          }
          for (const [x, y] of pts) v += `M${x.toFixed(2)} ${y.toFixed(2)}h0.01`;
          edges.setAttribute("d", d);
          verts.setAttribute("d", v);
        };
      },
      motion(el) {
        const tc = el.querySelector(".rg-tc");
        const BASE = 12 * 24 + 8;
        let last = "";
        return (t) => {
          const F = BASE + Math.floor(t * 24);
          const txt = `${pad(Math.floor(F / 86400))}:${pad(Math.floor(F / 1440) % 60)}:${pad(Math.floor(F / 24) % 60)}:${pad(F % 24)}`;
          if (txt !== last) {
            last = txt;
            tc.textContent = txt;
          }
          el.style.setProperty("--p", ((t % 8) / 8).toFixed(4));
        };
      },
      writing(el) {
        const boxes = [...el.querySelectorAll(".rg-box")];
        let last = -1;
        return (t) => {
          const cycle = Math.floor(t / 0.9) % 6;
          const n = cycle < 4 ? cycle + 1 : cycle === 4 ? 4 : 0;
          if (n === last) return;
          last = n;
          boxes.forEach((b, i) => b.classList.toggle("is-on", i < n));
        };
      },
      translation(el) {
        const en = [...el.querySelectorAll(".rg-col:first-child .rg-line")];
        const es = [...el.querySelectorAll(".rg-col:last-child .rg-line")];
        let last = -1;
        return (t) => {
          const i = Math.floor(t / 0.9) % en.length;
          if (i === last) return;
          if (last >= 0) {
            en[last].classList.remove("is-hl");
            es[last].classList.remove("is-hl");
          }
          en[i].classList.add("is-hl");
          es[i].classList.add("is-hl");
          last = i;
        };
      },
    };

    const panesOf = (type) => section.querySelector(`template[data-rg-pane="${type}"]`);
    const makePane = (type) => {
      const el = panesOf(type).content.firstElementChild.cloneNode(true);
      el.__video = el.querySelector("video");
      if (el.__video) el.__video.muted = true;
      el.__tick = INIT[type] ? INIT[type](el) : null;
      if (el.__tick) el.__tick(0);
      return el;
    };

    const ticks = new Set();
    const engage = (el, on) => {
      if (on && !reduce) {
        if (el.__tick) ticks.add(el.__tick);
        if (el.__video) el.__video.play().catch(() => {});
      } else {
        if (el.__tick) ticks.delete(el.__tick);
        if (el.__video) el.__video.pause();
      }
    };

    // Ink layer: a paper-filled copy of each row's content, stacked exactly on top.
    // The wipe clips only this copy. s runs -1 (hidden, left edge) -> 0 (full) -> 1 (hidden, right edge).
    const clipFor = (s) => (s <= 0
      ? `inset(0% ${(-s * 100).toFixed(3)}% 0% 0%)`
      : `inset(0% 0% 0% ${(s * 100).toFixed(3)}%)`);

    const states = new Map();
    rows.forEach((row) => {
      const base = row.querySelector(".rg-cells");
      const ink = base.cloneNode(true);
      ink.classList.add("rg-cells--ink");
      ink.setAttribute("aria-hidden", "true");
      ink.querySelector(".rg-mini")?.remove();
      row.append(ink);
      const st = {
        row,
        idx: [base.querySelector(".rg-idx"), ink.querySelector(".rg-idx")],
        wipe: { s: -1 },
        wdth: { w: 68 },
      };
      st.paintWipe = () => { ink.style.clipPath = clipFor(st.wipe.s); };
      st.paintWdth = () => { row.style.setProperty("--rg-w", st.wdth.w.toFixed(2)); };
      st.paintWipe();
      st.paintWdth();
      states.set(row, st);
    });

    // One tween per target. overwrite: true means a fast pointer never strands a layer mid-way.
    const tween = (target, vars, duration, ease, onUpdate) => {
      if (reduce) {
        gsap.killTweensOf(target);
        Object.assign(target, vars);
        onUpdate();
        return;
      }
      gsap.to(target, { ...vars, duration, ease, overwrite: true, onUpdate });
    };
    const wipeIn = (st) => {
      if (st.wipe.s >= 1) st.wipe.s = -1;
      tween(st.wipe, { s: 0 }, WIPE_IN, "power4.inOut", st.paintWipe);
    };
    const wipeOut = (st) => tween(st.wipe, { s: 1 }, WIPE_OUT, "power4.inOut", st.paintWipe);
    const wdthTo = (st, w) => tween(st.wdth, { w }, WDTH_TIME, "power3.out", st.paintWdth);

    const scrambleIdx = (st) => {
      if (reduce) return;
      st.idx.forEach((el) => Acq.scramble(el, { text: st.row.dataset.idx, duration: 0.5, swap: 0.04 }));
    };

    const panes = new Map();
    let current = null;
    let shown = false;
    let zTop = 1;
    const target = { x: 0, y: 0 };
    const pos = { x: 0, y: 0 };
    let prevX = 0, vS = 0, rotCur = 0;
    let clock = 0;
    const on = new Set();

    const paneFor = (type) => {
      let el = panes.get(type);
      if (!el) {
        el = makePane(type);
        panes.set(type, el);
        stage.append(el);
      }
      return el;
    };

    // Hide every pane except the one that is now on top. Runs after the new pane's fade completes.
    const clearPanes = (keep) => {
      panes.forEach((el) => {
        if (el !== keep && el.classList.contains("is-cur")) {
          el.classList.remove("is-cur");
          engage(el, false);
        }
      });
    };

    const showPane = (row) => {
      const el = paneFor(row.dataset.pane);
      tag.textContent = `FIG ${row.dataset.idx} · ${row.dataset.name}`;
      if (el === current) return;
      current = el;
      el.style.zIndex = String(++zTop);
      el.classList.add("is-cur");
      engage(el, shown);
      gsap.fromTo(el, { opacity: 0 }, {
        opacity: 1,
        duration: reduce ? 0 : 0.35,
        ease: "power2.out",
        overwrite: true,
        onComplete: () => { if (current === el) clearPanes(el); },
      });
    };

    const showFollow = () => {
      if (shown) return;
      shown = true;
      pos.x = target.x;
      pos.y = target.y;
      prevX = target.x;
      vS = 0;
      rotCur = 0;
      gsap.killTweensOf(card);
      if (reduce) {
        gsap.set(card, { clipPath: "inset(0% 0% 0% 0%)", scale: 1 });
      } else {
        gsap.fromTo(card, { clipPath: "inset(50% 0% 50% 0%)", scale: 0.9 }, { clipPath: "inset(0% 0% 0% 0%)", scale: 1, duration: 0.45, ease: "expo.out" });
      }
      if (current) engage(current, true);
    };

    const hideFollow = () => {
      if (!shown) return;
      shown = false;
      clearPanes(null);
      if (current) engage(current, false);
      current = null;
      gsap.killTweensOf(card);
      if (reduce) gsap.set(card, { clipPath: "inset(50% 0% 50% 0%)", scale: 1 });
      else gsap.to(card, { clipPath: "inset(50% 0% 50% 0%)", scale: 0.94, duration: 0.32, ease: "expo.in" });
    };

    const enter = (row) => {
      if (on.has(row)) return;
      [...on].forEach((other) => exit(other));
      const st = states.get(row);
      on.add(row);
      wipeIn(st);
      wdthTo(st, 100);
      scrambleIdx(st);
      showPane(row);
    };

    const exit = (row) => {
      if (!on.delete(row)) return;
      const st = states.get(row);
      wipeOut(st);
      wdthTo(st, 68);
    };

    const toRect = (row) => {
      const r = row.getBoundingClientRect();
      target.x = r.left + r.width * 0.55;
      target.y = r.top + r.height / 2;
    };

    if (fine) {
      rows.forEach((row) => {
        row.addEventListener("pointerenter", (e) => {
          if (e.pointerType !== "mouse") return;
          target.x = e.clientX;
          target.y = e.clientY;
          enter(row);
          showFollow();
        });
        row.addEventListener("pointerleave", (e) => {
          if (e.pointerType !== "mouse") return;
          exit(row);
        });
        row.addEventListener("focus", () => {
          toRect(row);
          enter(row);
          showFollow();
        });
        row.addEventListener("blur", () => {
          exit(row);
          hideFollow();
        });
      });
      table.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse" || on.size === 0) return;
        target.x = e.clientX;
        target.y = e.clientY;
      });
      table.addEventListener("pointerleave", (e) => {
        if (e.pointerType !== "mouse") return;
        [...on].forEach((row) => exit(row));
        hideFollow();
      });
    }

    rows.forEach((row) => {
      const host = row.querySelector(".rg-mini");
      const el = makePane(row.dataset.pane);
      el.classList.add("is-cur");
      host.append(el);
      new IntersectionObserver(([entry]) => engage(el, entry.isIntersecting), { threshold: 0.25 }).observe(host);
    });

    gsap.ticker.add((_, dtMs) => {
      const dt = Math.min(dtMs, 50) / 1000;
      clock += dt;
      if (shown) {
        const vx = (target.x - prevX) / Math.max(dt, 1e-3);
        prevX = target.x;
        vS += (vx - vS) * (1 - Math.exp(-dt * 10));
        const want = Math.max(-8, Math.min(8, vS * 0.03));
        rotCur += (want - rotCur) * (1 - Math.exp(-dt * 8));
        const k = 1 - Math.exp(-dt * 12);
        pos.x += (target.x - pos.x) * k;
        pos.y += (target.y - pos.y) * k;
        const x = Math.min(Math.max(pos.x + 28, 8), window.innerWidth - 288);
        const y = Math.min(Math.max(pos.y - 100, 8), window.innerHeight - 208);
        follow.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
        rot.style.transform = `rotate(${(reduce ? 0 : rotCur).toFixed(3)}deg)`;
      }
      if (ticks.size) ticks.forEach((tick) => tick(clock));
    });

    if (!reduce) {
      rows.forEach((row) => {
        const base = row.querySelector(":scope > .rg-cells");
        gsap.from(base.querySelectorAll(":scope > .rg-idx, :scope > .rg-name, :scope > .rg-checks, :scope > .rg-status"), {
          y: 26,
          opacity: 0,
          duration: 1,
          ease: "expo.out",
          stagger: 0.06,
          scrollTrigger: { trigger: row, start: "top 88%", once: true },
        });
      });
    }
  });
})();
