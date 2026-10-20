import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";

(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;
  const root = document.documentElement;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  gsap.defaults({ ease: "expo.out", duration: 1 });

  const Acq = (window.Acq = { reduce, fine, lenis: null });

  if (!reduce) {
    const lenis = new Lenis({ duration: 1.1, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    Acq.lenis = lenis;
  }

  const domReady = new Promise((r) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r, { once: true }) : r()));
  Acq.ready = domReady.then(() => document.fonts.ready).then(() => undefined);

  let introResolve;
  Acq.intro = new Promise((r) => (introResolve = r));
  Acq.startIntro = () => introResolve();
  Acq.ready.then(() => { if (!document.querySelector("[data-preloader]")) introResolve(); });

  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789§¶#%&*+/<>[]";
  Acq.scramble = (el, { text, duration = 0.7, delay = 0, swap = 0.05, glyphs = GLYPHS } = {}) => {
    const target = text ?? el.dataset.text ?? el.textContent;
    el.dataset.text = target;
    cancelAnimationFrame(el._scr);
    if (reduce) { el.textContent = target; return Promise.resolve(); }
    const n = target.length;
    const start = performance.now() + delay * 1000;
    let lastSwap = -1, pool = [];
    return new Promise((done) => {
      const tick = (now) => {
        const t = (now - start) / 1000;
        if (t < 0) { el._scr = requestAnimationFrame(tick); return; }
        if (lastSwap < 0 || now - lastSwap >= swap * 1000) {
          pool = Array.from({ length: n }, () => glyphs[(Math.random() * glyphs.length) | 0]);
          lastSwap = now;
        }
        let out = "";
        for (let k = 0; k < n; k++) {
          const ch = target[k];
          if (ch === " " || t >= (duration * (k + 0.5)) / n) out += ch;
          else out += ch === ch.toLowerCase() && ch !== ch.toUpperCase() ? pool[k].toLowerCase() : pool[k];
        }
        el.textContent = out;
        if (t < duration) el._scr = requestAnimationFrame(tick);
        else { el.textContent = target; done(); }
      };
      el._scr = requestAnimationFrame(tick);
    });
  };

  const spring = (k = 1800, c = 76) => {
    const s = { x: 0, v: 0, target: 0, step(dt) {
      let left = Math.min(dt, 1 / 20);
      const h = 1 / 240;
      while (left > 0) { const d = Math.min(h, left); const a = -k * (s.x - s.target) - c * s.v; s.v += a * d; s.x += s.v * d; left -= d; }
      return s.x;
    } };
    return s;
  };
  Acq.spring = spring;

  const sound = (Acq.sound = {
    on: localStorage.getItem("acquit:sound") === "on",
    ctx: null,
    toggle() { sound.on = !sound.on; localStorage.setItem("acquit:sound", sound.on ? "on" : "off"); if (sound.on) sound.blip(520, 780, 90, 0.035); document.dispatchEvent(new CustomEvent("acq:sound", { detail: sound.on })); return sound.on; },
    blip(f0 = 640, f1 = 420, ms = 105, gain = 0.038) {
      if (!sound.on) return;
      sound.ctx ??= new AudioContext();
      const ctx = sound.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + ms / 1000);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + ms / 1000 + 0.02);
    },
  });

  // Sections declare ink or paper. The mode decides what those mean: each mode keeps every section on its own
  // ground and alternates two tones of it (ink and coal in dark, bone and paper in light). --hi is the thin-shape accent:
  // signal on dark grounds, a deep lime on light ones, where signal would vanish.
  const INK = { "--bg": "#0B0B0A", "--fg": "#ECEAE4", "--mute": "#8C8A84", "--line": "#2A2A27", "--surface": "#151513", "--tick": "#C8FF2E", "--hi": "#C8FF2E", "--dim": "#3A3A36" };
  const PAPER = { "--bg": "#ECEAE4", "--fg": "#0B0B0A", "--mute": "#5E5B54", "--line": "#C9C5BB", "--surface": "#E2DFD7", "--tick": "#0B0B0A", "--hi": "#4C7300", "--dim": "#C9C5BB" };
  const BONE = { "--bg": "#F6F5F1", "--fg": "#0B0B0A", "--mute": "#5E5B54", "--line": "#D6D2C8", "--surface": "#ECEAE4", "--tick": "#0B0B0A", "--hi": "#4C7300", "--dim": "#D6D2C8" };
  const COAL = { "--bg": "#141413", "--fg": "#ECEAE4", "--mute": "#8C8A84", "--line": "#2C2C29", "--surface": "#1C1C1A", "--tick": "#C8FF2E", "--hi": "#C8FF2E", "--dim": "#3A3A36" };
  const PALETTES = { dark: { ink: INK, paper: COAL }, light: { ink: BONE, paper: PAPER } };
  Acq.mode = root.dataset.mode === "light" ? "light" : "dark";
  root.dataset.mode = Acq.mode;
  let section = null, applied = null;
  const setTheme = (name, instant) => {
    section = name;
    const key = Acq.mode + ":" + name;
    if (applied === key) return;
    applied = key;
    root.dataset.theme = name;
    root.dataset.ground = Acq.mode;
    gsap.to(root, { ...PALETTES[Acq.mode][name], duration: instant || reduce ? 0 : 0.6, ease: "power2.inOut", overwrite: true });
  };
  Acq.setTheme = setTheme;
  Acq.setMode = (mode) => {
    if (mode === Acq.mode) return;
    Acq.mode = mode;
    root.dataset.mode = mode;
    localStorage.setItem("acquit:mode", mode);
    if (section) setTheme(section);
    document.dispatchEvent(new CustomEvent("acq:mode", { detail: mode }));
  };

  const wireButtons = (scope = document) => {
    scope.querySelectorAll(".btn__label:not([data-wired])").forEach((el) => {
      const label = el.dataset.label || el.textContent.trim();
      el.dataset.wired = "";
      el.innerHTML = "";
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = label; b.textContent = label; b.setAttribute("aria-hidden", "true");
      el.append(a, b);
    });
    scope.querySelectorAll(".btn__icon:not([data-wired])").forEach((el) => {
      const glyph = el.textContent.trim();
      el.dataset.wired = "";
      el.innerHTML = `<i>${glyph}</i><i>${glyph}</i>`;
    });
  };
  Acq.wireButtons = wireButtons;

  const wireMagnetic = (scope = document) => {
    if (!fine || reduce) return;
    scope.querySelectorAll("[data-magnetic]:not([data-mag-wired])").forEach((el) => {
      el.dataset.magWired = "";
      const strength = parseFloat(el.dataset.magnetic) || 0.3;
      const inner = el.querySelector(".mag-inner");
      const xTo = gsap.quickTo(el, "x", { duration: 0.6, ease: "power3.out" });
      const yTo = gsap.quickTo(el, "y", { duration: 0.6, ease: "power3.out" });
      const ixTo = inner && gsap.quickTo(inner, "x", { duration: 0.6, ease: "power3.out" });
      const iyTo = inner && gsap.quickTo(inner, "y", { duration: 0.6, ease: "power3.out" });
      let rect = null;
      el.addEventListener("pointerenter", () => { rect = el.getBoundingClientRect(); });
      el.addEventListener("pointermove", (e) => {
        rect ??= el.getBoundingClientRect();
        const mx = e.clientX - (rect.left + rect.width / 2), my = e.clientY - (rect.top + rect.height / 2);
        const clamp = (v) => Math.max(-14, Math.min(14, v));
        xTo(clamp(mx * strength)); yTo(clamp(my * strength));
        if (inner) { ixTo(clamp(mx * strength * 0.45)); iyTo(clamp(my * strength * 0.45)); }
      });
      el.addEventListener("pointerleave", () => {
        rect = null;
        gsap.to(inner ? [el, inner] : el, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)", overwrite: true });
      });
    });
  };
  Acq.wireMagnetic = wireMagnetic;

  const wireCursor = () => {
    if (!fine) return;
    const c = document.createElement("div");
    c.className = "cursor";
    c.innerHTML = '<div class="cursor__ring"></div><div class="cursor__dot"></div>';
    const chip = document.createElement("div");
    chip.className = "cursor-chip";
    chip.innerHTML = "<span></span>";
    document.body.append(c, chip);
    const dot = c.querySelector(".cursor__dot"), ring = c.querySelector(".cursor__ring"), chipLabel = chip.querySelector("span");
    let tx = -100, ty = -100, dx = tx, dy = ty, rx = tx, ry = ty, kx = tx, ky = ty, seen = false;
    addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      tx = e.clientX; ty = e.clientY;
      if (!seen) { seen = true; dx = rx = kx = tx; dy = ry = ky = ty; c.classList.add("is-on"); }
    }, { passive: true });
    document.addEventListener("pointerleave", () => c.classList.remove("is-on"));
    document.addEventListener("pointerenter", () => seen && c.classList.add("is-on"));
    addEventListener("pointerdown", () => c.classList.add("is-down"));
    addEventListener("pointerup", () => c.classList.remove("is-down"));
    let current = null;
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest("[data-cursor], a, button, [role=button], input, label");
      if (t === current) return;
      current = t;
      const label = t?.dataset?.cursor;
      c.classList.toggle("is-link", !!t && !label);
      c.classList.toggle("is-chip", !!label);
      if (label) { chipLabel.textContent = label; chip.classList.remove("is-off"); chip.classList.add("is-on"); }
      else { chip.classList.remove("is-on"); chip.classList.add("is-off"); }
    });
    gsap.ticker.add((_, dtMs) => {
      const dt = Math.min(dtMs, 64) / 1000;
      const a = reduce ? 1 : 1 - Math.exp(-dt * 38), b = reduce ? 1 : 1 - Math.exp(-dt * 15), k = reduce ? 1 : 1 - Math.exp(-dt * 12);
      dx += (tx - dx) * a; dy += (ty - dy) * a; rx += (tx - rx) * b; ry += (ty - ry) * b; kx += (tx - kx) * k; ky += (ty - ky) * k;
      dot.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      chip.style.transform = `translate3d(${kx}px, ${ky}px, 0)`;
    });
  };

  const wireGrain = () => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 160;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) { const light = Math.random() < 0.5; const v = light ? 255 : 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = (Math.random() * (light ? 18 : 26)) | 0; }
    ctx.putImageData(img, 0, 0);
    const g = document.createElement("div");
    g.className = "grain";
    g.style.backgroundImage = `url(${cv.toDataURL()})`;
    g.setAttribute("aria-hidden", "true");
    document.body.append(g);
  };

  const wireReveals = () => {
    document.querySelectorAll('[data-reveal="lines"]').forEach((el) => {
      const split = SplitText.create(el, { type: "lines", mask: "lines", linesClass: "rv-line" });
      if (reduce) return;
      gsap.from(split.lines, { yPercent: 110, duration: 1.1, ease: "expo.out", stagger: 0.08, scrollTrigger: { trigger: el, start: "top 85%", once: true } });
    });
    if (reduce) return;
    document.querySelectorAll('[data-reveal="fade"]').forEach((el) => {
      gsap.from(el, { y: 24, autoAlpha: 0, duration: 0.9, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 88%", once: true } });
    });
    document.querySelectorAll('[data-reveal="rule"]').forEach((el) => {
      gsap.from(el, { scaleX: 0, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 90%", once: true } });
    });
  };

  const wireScramble = () => {
    document.querySelectorAll("[data-scramble]").forEach((el) => {
      el.dataset.text = el.textContent;
      if (reduce) return;
      const duration = parseFloat(el.dataset.scrambleDuration) || 0.7;
      ScrollTrigger.create({ trigger: el, start: "top 92%", once: true, onEnter: () => Acq.scramble(el, { duration }) });
    });
    document.querySelectorAll("[data-scramble-hover]").forEach((host) => {
      const el = host.querySelector(".scr") || host;
      el.dataset.text = el.textContent;
      let lockedUntil = 0;
      host.addEventListener("pointerenter", () => {
        const now = performance.now();
        if (now < lockedUntil) return;
        lockedUntil = now + 420;
        Acq.scramble(el, { duration: 0.35, swap: 0.04 });
      });
    });
  };

  // Rect checks instead of ScrollTriggers: pinned sections change height after triggers are measured, which left theme triggers with stale ends.
  const wireThemes = () => {
    const sections = [...document.querySelectorAll("[data-theme]")];
    if (!sections.length) return;
    let queued = false;
    const check = (instant) => {
      queued = false;
      const line = innerHeight * 0.55;
      const hit = sections.find((s) => { const r = s.getBoundingClientRect(); return r.top <= line && r.bottom > line; });
      if (hit) setTheme(hit.dataset.theme, instant);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(() => check(false)); } };
    check(true);
    if (Acq.lenis) Acq.lenis.on("scroll", queue);
    addEventListener("scroll", queue, { passive: true });
    addEventListener("resize", queue);
  };

  const wireAnchors = () => {
    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute("href");
      const target = id === "#top" ? 0 : document.querySelector(id);
      if (target === null) return;
      e.preventDefault();
      if (Acq.lenis) Acq.lenis.scrollTo(target, { duration: 1.6, easing: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2) });
      else (target === 0 ? window : target).scrollIntoView?.() ?? window.scrollTo(0, 0);
    });
  };

  wireButtons();
  domReady.then(() => { wireCursor(); wireGrain(); wireAnchors(); wireMagnetic(); });
  Acq.ready.then(() => {
    wireReveals();
    wireScramble();
    requestAnimationFrame(() => { ScrollTrigger.sort(); ScrollTrigger.refresh(); wireThemes(); });
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? gsap.ticker.sleep() : gsap.ticker.wake()));
})();
