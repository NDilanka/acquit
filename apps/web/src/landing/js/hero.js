import gsap from "gsap";
import { SplitText } from "gsap/SplitText";

(() => {
  const hero = document.querySelector(".hero");
  if (!hero) return;

  const video = hero.querySelector(".hero__video");
  const title = hero.querySelector(".hero__title");
  const ledeEl = hero.querySelector(".hero__lede");
  const meta = hero.querySelector(".hero__meta");
  const field = hero.querySelector("[data-hero-field]");
  const fieldName = hero.querySelector("[data-hero-field-name]");
  const pillbox = hero.querySelector("[data-hero-pillbox]");
  const ctas = hero.querySelector(".hero__ctas");
  const cue = hero.querySelector(".hero__scroll");
  const cueBar = hero.querySelector(".hero__cue-bar");
  const marquee = hero.querySelector(".hero__marquee");
  const ticker = hero.querySelector(".hero__ticker");
  const setTemplate = ticker.querySelector(".hero__set");
  const clock = hero.querySelector(".hero__clock");

  const reduce = Acq.reduce;
  const fine = Acq.fine;
  const wideMq = matchMedia("(min-width: 900px)");

  // Breathing type state. Char centres are cached and refreshed about every 250ms while active.
  // WD_MAX is the widest the breath goes. At 1440 the widest line then ends inside the content width (measured).
  const WD_BASE = 68;
  const WD_MAX = 78;
  let charState = [];
  let h1Band = { top: 0, bottom: 0 };
  let lastMeasure = -1000;
  let breathOn = false;
  let awayFromBase = false;

  const measureChars = () => {
    const r = title.getBoundingClientRect();
    h1Band = { top: r.top, bottom: r.bottom };
    for (const c of charState) {
      const b = c.el.getBoundingClientRect();
      c.x = b.left + b.width / 2;
      c.y = b.top + b.height / 2;
    }
    lastMeasure = performance.now();
  };

  const ptr = { x: 0, y: 0, inside: false };

  const breathTick = (dt) => {
    if (!breathOn) return;
    const inBand = ptr.inside && ptr.y >= h1Band.top && ptr.y <= h1Band.bottom;
    if (!inBand && !awayFromBase) return;
    if (performance.now() - lastMeasure > 250) measureChars();
    const k = 1 - Math.exp(-dt * 10);
    awayFromBase = false;
    for (const c of charState) {
      let target = WD_BASE;
      if (inBand) {
        const t = Math.max(0, 1 - Math.hypot(ptr.x - c.x, ptr.y - c.y) / 260);
        target = WD_BASE + (WD_MAX - WD_BASE) * t * t * (3 - 2 * t);
      }
      c.w += (target - c.w) * k;
      if (Math.abs(target - c.w) < 0.02) c.w = target;
      const wr = Math.round(c.w * 10) / 10;
      if (wr !== c.last) {
        c.el.style.fontVariationSettings = `"wdth" ${wr}`;
        c.last = wr;
      }
      if (c.w > WD_BASE + 0.05) awayFromBase = true;
    }
  };

  // Marquee state.
  const MARQUEE_BASE = 38;
  let marqueeOn = false;
  let setW = 0;
  let mx = 0;
  let speed = 0;
  let scrollDir = -1;
  let scrollV = 0;
  let lastScrollY = window.scrollY;

  const marqueeTick = (dt) => {
    if (!marqueeOn || !setW) return;
    const y = window.scrollY;
    const v = (y - lastScrollY) / Math.max(dt, 1e-3);
    lastScrollY = y;
    scrollV += (v - scrollV) * (1 - Math.exp(-dt * 12));
    if (Math.abs(v) > 1) scrollDir = v > 0 ? -1 : 1;
    const dir = Math.abs(scrollV) > 20 ? scrollDir : -1;
    const mult = Math.min(4, 1 + Math.abs(scrollV) / 600);
    const target = dir * MARQUEE_BASE * mult;
    speed += (target - speed) * (1 - Math.exp(-dt * 3));
    mx += speed * dt;
    if (mx <= -setW) mx += setW;
    else if (mx > 0) mx -= setW;
    ticker.style.transform = `translate3d(${mx.toFixed(2)}px, 0, 0)`;
  };

  const buildTicker = () => {
    ticker.querySelectorAll("[data-clone]").forEach((n) => n.remove());
    setW = setTemplate.getBoundingClientRect().width;
    if (!setW) return;
    const sets = Math.ceil(innerWidth / setW) + 2;
    for (let i = 1; i < sets; i++) {
      const c = setTemplate.cloneNode(true);
      c.dataset.clone = "";
      ticker.append(c);
    }
  };

  // Lede: re-split on resize so the lines always match the current wrap.
  let ledeSplit = null;
  let introDone = false;
  const splitLede = () => {
    ledeSplit?.revert();
    ledeSplit = SplitText.create(ledeEl, { type: "lines", mask: "lines", linesClass: "hero__split-line" });
    if (!introDone) gsap.set(ledeSplit.lines, { yPercent: 110 });
  };

  let lineSplits = [];
  const ready = Acq.ready.then(() => {
    if (reduce) return;
    lineSplits = [...title.querySelectorAll(".hero__line")].map((el) => SplitText.create(el, {
      type: "lines,chars", mask: "lines", linesClass: "hero__split-line", charsClass: "hero__char",
    }));
    charState = lineSplits.flatMap((s) => s.chars).map((el) => ({ el, x: 0, y: 0, w: WD_BASE, last: WD_BASE }));
    lineSplits.forEach((s) => gsap.set(s.chars, { yPercent: 110 }));
    splitLede();
    gsap.set([ctas, field, cue], { autoAlpha: 0 });
    buildTicker();
  });

  // Clock: local time only.
  const clockFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const paintClock = () => { clock.textContent = clockFmt.format(new Date()); };
  paintClock();
  setInterval(paintClock, 1000);

  // Field ticker.
  const FIELDS = [
    { name: "CODE FIXES", status: "LIVE", cls: "pill--live" },
    { name: "3D PRINTS", status: "IN BUILD", cls: "pill--build" },
    { name: "3D RENDERS", status: "ROADMAP", cls: "pill--roadmap" },
    { name: "MOTION AND VIDEO", status: "ROADMAP", cls: "pill--roadmap" },
    { name: "WRITING", status: "ROADMAP", cls: "pill--roadmap" },
    { name: "TRANSLATION", status: "ROADMAP", cls: "pill--roadmap" },
  ];
  const pills = FIELDS.map((f, i) => {
    const p = document.createElement("span");
    p.className = `pill ${f.cls} hero__pill` + (i === 0 ? "" : " is-below");
    p.textContent = f.status;
    pillbox.append(p);
    return p;
  });
  let fieldIdx = 0;
  let cycleTimer = 0;
  let fieldHover = false;

  const showField = (next) => {
    const prev = fieldIdx;
    fieldIdx = next;
    const out = pills[prev];
    const incoming = pills[next];
    out.classList.remove("is-below");
    out.classList.add("is-above");
    incoming.style.transition = "none";
    incoming.classList.remove("is-above");
    incoming.classList.add("is-below");
    void incoming.offsetWidth;
    incoming.style.transition = "";
    incoming.classList.remove("is-below");
    Acq.scramble(fieldName, { text: FIELDS[next].name, duration: 0.5 });
  };

  const scheduleCycle = () => {
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(() => {
      if (!fieldHover && heroVisible && !document.hidden) showField((fieldIdx + 1) % FIELDS.length);
      scheduleCycle();
    }, 2600);
  };
  field.addEventListener("pointerenter", () => { fieldHover = true; });
  field.addEventListener("pointerleave", () => { fieldHover = false; });

  // Pointer tracking.
  hero.addEventListener("pointermove", (e) => {
    if (!fine || e.pointerType !== "mouse") return;
    ptr.inside = true;
    ptr.x = e.clientX;
    ptr.y = e.clientY;
  }, { passive: true });
  hero.addEventListener("pointerleave", () => { ptr.inside = false; });

  // Scroll: fade the scroll cue after 80px.
  let cueHidden = false;
  const onScroll = () => {
    const shouldHide = window.scrollY > 80;
    if (shouldHide !== cueHidden && !reduce) {
      cueHidden = shouldHide;
      gsap.to(cue, { autoAlpha: shouldHide ? 0 : 1, duration: 0.4, ease: "power2.out", overwrite: "auto" });
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // Resize: re-measure the text and rebuild the ticker.
  const resize = () => {
    if (reduce) return;
    ready.then(() => {
      measureChars();
      buildTicker();
      if (ledeSplit) splitLede();
    });
    breathOn = breathOn && fine && wideMq.matches;
  };
  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); };
  resize();
  addEventListener("resize", onResize);

  // Visibility: pause the video, the cue loop, and the marquee when the hero is off screen.
  const cueTween = gsap.fromTo(cueBar, { y: 0 }, { y: 42, duration: 1.6, ease: "power2.inOut", repeat: -1 });
  if (reduce) cueTween.pause();
  let heroVisible = true;
  const io = new IntersectionObserver((entries) => {
    const on = entries[0].isIntersecting;
    heroVisible = on;
    marqueeOn = on && !reduce;
    if (on && !reduce) { cueTween.resume(); video.play().catch(() => {}); }
    else { cueTween.pause(); video.pause(); }
  }, { threshold: 0 });
  io.observe(hero);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) video.pause();
    else if (heroVisible && !reduce) video.play().catch(() => {});
  });

  if (reduce) {
    video.removeAttribute("autoplay");
    video.pause();
  }

  // Frame loop: breathing type and marquee.
  const frame = (_, deltaMs) => {
    if (!heroVisible) return;
    const dt = Math.min(deltaMs, 64) / 1000;
    breathTick(dt);
    marqueeTick(dt);
  };
  if (!reduce) gsap.ticker.add(frame);

  // Entrance: runs once the fonts are ready and the preloader starts its exit.
  Promise.all([ready, Acq.intro]).then(() => {
    introDone = true;
    if (reduce) return;
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    const LINE_STEP = 0.08;
    const lastLineAt = (lineSplits.length - 1) * LINE_STEP;
    const afterLastLine = lastLineAt + 0.35;
    tl.fromTo(meta, { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 0.1);
    lineSplits.forEach((s, i) => {
      tl.fromTo(s.chars, { yPercent: 110 }, { yPercent: 0, duration: 1.15, stagger: 0.022 }, i * LINE_STEP);
    });
    tl.fromTo(ledeSplit.lines, { yPercent: 110 }, { yPercent: 0, duration: 1.1, stagger: 0.08 }, afterLastLine);
    tl.fromTo(field, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.9 }, afterLastLine);
    tl.fromTo(ctas, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.9 }, afterLastLine + 0.2);
    tl.fromTo(cue, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8 }, afterLastLine + 0.4);
    tl.fromTo(marquee, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8 }, 0.6);
    tl.call(() => {
      measureChars();
      breathOn = fine && wideMq.matches;
      lastScrollY = window.scrollY;
    }, null, 1.6);
    scheduleCycle();
  }).catch((e) => console.error("hero entrance failed", e && e.stack ? e.stack : e));
})();
