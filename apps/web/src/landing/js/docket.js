import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

(() => {
  const section = document.getElementById("docket");
  if (!section) return;

  const pin = section.querySelector(".docket-pin");
  const track = section.querySelector(".docket-track");
  const steps = [...section.querySelectorAll(".docket-card[data-kind]")];
  const ticks = [...section.querySelectorAll(".docket-rail__tick")];
  const fill = section.querySelector(".docket-rail__fill");
  const chip = section.querySelector(".docket-chip");
  const stamp = section.querySelector(".docket-stamp");
  const stampPulse = section.querySelector(".docket-stamp__pulse");
  const stampCard = steps[steps.length - 1];

  // Core fires every data-scramble element at once. The index rows stagger .06s, so this script takes them over before core wires them.
  const indexRows = [...section.querySelectorAll(".docket-index [data-scramble]")];
  indexRows.forEach((el) => el.removeAttribute("data-scramble"));

  const CHIP = {
    none: ["ESCROW · NONE", ""],
    open: ["ESCROW · OPEN", ""],
    held: ["ESCROW · HELD", "pill--hold"],
    released: ["ESCROW · RELEASED", "pill--live"],
  };

  let chipState = "none";
  let active = 0;
  let stamped = false;
  let lefts = [];
  let widths = [];
  let dist = 0;
  let setFill = null;
  let h = null;

  const measure = () => {
    dist = Math.max(0, track.scrollWidth - pin.clientWidth);
    lefts = steps.map((c) => c.offsetLeft);
    widths = steps.map((c) => c.offsetWidth);
  };

  const setChip = (state) => {
    if (state === chipState) return;
    chipState = state;
    const [text, mod] = CHIP[state];
    chip.classList.remove("pill--hold", "pill--live");
    if (mod) chip.classList.add(mod);
    Acq.scramble(chip, { text, duration: 0.4 });
  };

  const chipFor = () => {
    if (active === 0) return "none";
    if (active === 1) return "open";
    if (active === 2) return "held";
    return stamped ? "released" : "held";
  };

  const setActive = (i) => {
    if (i === active) return;
    active = i;
    ticks.forEach((t, k) => t.classList.toggle("is-active", k === i));
    setChip(chipFor());
  };

  const contact = () => {
    Acq.sound.blip(220, 90, 120, 0.05);
    stampCard.animate(
      [{ transform: "translateY(0px)" }, { transform: "translateY(3px)", offset: 0.5 }, { transform: "translateY(0px)" }],
      { duration: 180, easing: "ease-out" }
    );
    stampPulse.animate(
      [{ transform: "scale(1)", opacity: 0.25 }, { transform: "scale(1.6)", opacity: 0 }],
      { duration: 600, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
    stamped = true;
    setChip(chipFor());
  };

  const slam = () => {
    stamp.animate(
      [
        { opacity: 0, transform: "rotate(-16deg) scale(1.9)" },
        { opacity: 1, transform: "rotate(-8deg) scale(1)" },
      ],
      { duration: 420, easing: "cubic-bezier(.22,.8,.3,1.08)", fill: "forwards" }
    );
    setTimeout(contact, 260);
  };

  const q = (root, sel) => [...root.querySelectorAll(sel)];
  const svgOf = (card) => card.querySelector(".docket-diagram");

  // A dashed path starts hidden: dash 1, offset 1, opacity 0. Its draw turns it on and moves the offset to 0.
  const prep = (els) =>
    els.forEach((el) => {
      el.setAttribute("pathLength", "1");
      gsap.set(el, { strokeDasharray: "1 1", strokeDashoffset: 1, opacity: 0 });
    });

  const draw = (tl, el, at, dur = 0.4) =>
    tl
      .set(el, { opacity: 1 }, at)
      .to(el, { strokeDashoffset: 0, duration: dur, ease: "power1.inOut" }, at);

  const placeOn = (route, dot, p) => {
    const pt = route.getPointAtLength(p * route.getTotalLength());
    dot.setAttribute("cx", pt.x.toFixed(2));
    dot.setAttribute("cy", pt.y.toFixed(2));
  };

  // Each card sets its start frame, then returns a story (tl, plays once) and an ambient loop (amb, runs only after the story and while the card is visible).
  const DIAGRAMS = {
    post(card) {
      const svg = svgOf(card);
      const lines = q(svg, "[data-d=line]");
      const caret = svg.querySelector("[data-d=caret]");
      const scan = svg.querySelector("[data-d=scan]");
      const conn = svg.querySelector("[data-d=conn]");
      const lock = svg.querySelector("[data-d=lock]");
      const shackle = svg.querySelector("[data-d=shackle]");
      const key = svg.querySelector("[data-d=key]");
      const label = svg.querySelector("[data-d=label]");

      prep([...lines, conn]);
      gsap.set(caret, { opacity: 0 });
      gsap.set(scan, { opacity: 0, y: 18 });
      gsap.set(lock, { opacity: 0 });
      gsap.set(shackle, { opacity: 0, y: -14 });
      gsap.set(key, { attr: { r: 0 } });
      gsap.set(label, { opacity: 0, y: 4 });

      // The contract types in line by line under a caret. The connector joins the lock, and the shackle clicks shut.
      const TYPE = 0.14;
      const STEP = 0.22;
      const WRITE = 0.2;
      const end = TYPE + (lines.length - 1) * STEP + WRITE;
      const tl = gsap.timeline({ paused: true });
      lines.forEach((line, i) => {
        const t = TYPE + i * STEP;
        const a = line.getPointAtLength(0);
        const b = line.getPointAtLength(line.getTotalLength());
        tl.set(caret, { opacity: 1, x: a.x + 6, y: a.y }, t);
        draw(tl, line, t, WRITE);
        tl.to(caret, { x: b.x + 6, duration: WRITE, ease: "power1.inOut" }, t);
      });
      tl.set(caret, { opacity: 0 }, end + 0.04);
      draw(tl, conn, end + 0.02, 0.26);
      tl.to(lock, { opacity: 1, duration: 0.18, ease: "power1.out" }, end + 0.2)
        .set(shackle, { opacity: 1 }, end + 0.2)
        .to(shackle, { y: 0, duration: 0.34, ease: "back.out(2.4)" }, end + 0.34)
        .to(key, { attr: { r: 4.5 }, duration: 0.28, ease: "back.out(2)" }, end + 0.56)
        .to(label, { opacity: 1, y: 0, duration: 0.25, ease: "power2.out" }, end + 0.6);

      const amb = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.4 })
        .set(scan, { opacity: 0, y: 18 }, 0)
        .to(scan, { y: 300, duration: 2.2, ease: "power1.inOut" }, 0)
        .to(scan, { opacity: 0.8, duration: 0.4, ease: "power1.out" }, 0)
        .to(scan, { opacity: 0, duration: 0.4, ease: "power1.in" }, 1.8);
      return { tl, amb };
    },

    bid(card) {
      const svg = svgOf(card);
      const routes = q(svg, "[data-d=route]");
      const dots = q(svg, "[data-d=dot]");
      const core = svg.querySelector("[data-d=core]");
      const pulse = svg.querySelector("[data-d=pulse]");
      const win = svg.querySelector("[data-d=win]");
      const WIN = 1;

      prep(routes);
      gsap.set(dots, { opacity: 1 });
      gsap.set(core, { attr: { r: 3 } });
      gsap.set(pulse, { opacity: 0 });
      gsap.set(win, { opacity: 0 });

      // Three bids travel their routes into the hub, and each landing pulses it. The middle route then locks in and the others dim.
      const FIRST = 0.15;
      const GAP = 0.3;
      const RUN = 0.5;
      const LOCK = FIRST + 2 * GAP + RUN + 0.15;
      const tl = gsap.timeline({ paused: true });
      routes.forEach((route, i) => {
        const dot = dots[i];
        const t = FIRST + i * GAP;
        const run = { p: 0 };
        draw(tl, route, t, RUN);
        tl.to(run, { p: 1, duration: RUN, ease: "power1.inOut", onUpdate: () => placeOn(route, dot, run.p) }, t);
        tl.set(dot, { opacity: 0 }, t + RUN);
        tl.set(pulse, { opacity: 0.7, attr: { r: 30 } }, t + RUN)
          .to(pulse, { opacity: 0, attr: { r: 42 }, duration: 0.42, ease: "power2.out", overwrite: "auto" }, t + RUN);
        tl.to(core, { attr: { r: 5 }, duration: 0.12, ease: "power2.out", yoyo: true, repeat: 1 }, t + RUN);
      });
      tl.to(win, { opacity: 1, duration: 0.35, ease: "power2.out" }, LOCK)
        .to(routes.filter((_, i) => i !== WIN), { opacity: 0.3, duration: 0.35, ease: "power2.out" }, LOCK)
        .to(core, { attr: { r: 8 }, duration: 0.45, ease: "back.out(2)" }, LOCK);

      // Ambient: packets keep flowing into the hub on the winning route only.
      const flow = { p: 0 };
      const amb = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.5 })
        .set(dots[WIN], { opacity: 0 }, 0)
        .to(dots[WIN], { opacity: 1, duration: 0.2 }, 0)
        .to(flow, { p: 1, duration: 1.3, ease: "power1.inOut", onUpdate: () => placeOn(routes[WIN], dots[WIN], flow.p) }, 0)
        .to(dots[WIN], { opacity: 0, duration: 0.2 }, 1.1);
      return { tl, amb };
    },

    fund(card) {
      const svg = svgOf(card);
      const lid = svg.querySelector("[data-d=lid]");
      const label = svg.querySelector("[data-d=label]");
      const pulse = svg.querySelector("[data-d=pulse]");
      const key = svg.querySelector("[data-d=key]");
      const coins = q(svg, "[data-d=coin]");
      const TOP = 40;
      const FLOOR = 284;

      // Start frame: a closed vault, nothing inside, HELD not yet shown. The lid hinges at its back-left corner.
      gsap.set(lid, { rotation: 0, svgOrigin: "96 170" });
      gsap.set(coins, { attr: { cy: TOP }, opacity: 0 });
      gsap.set(label, { opacity: 0, y: 4 });
      gsap.set(key, { opacity: 0, scale: 0, svgOrigin: "180 258" });
      gsap.set(pulse, { opacity: 0, attr: { r: 4 } });

      // The lid lifts, coins drop in with a gravity ease and a small settle, the lid drops shut, and HELD shows.
      const tl = gsap.timeline({ paused: true });
      tl.to(lid, { rotation: -90, duration: 0.35, ease: "power2.out" }, 0.1);
      coins.forEach((coin, i) => {
        const t = 0.45 + i * 0.12;
        tl.to(coin, { opacity: 1, duration: 0.08 }, t)
          .to(coin, { attr: { cy: FLOOR }, duration: 0.42, ease: "power2.in" }, t)
          .to(coin, { attr: { cy: FLOOR - 6 }, duration: 0.09, ease: "power2.out" }, t + 0.42)
          .to(coin, { attr: { cy: FLOOR }, duration: 0.1, ease: "power2.in" }, t + 0.51);
      });
      tl.to(lid, { rotation: 0, duration: 0.35, ease: "power2.in" }, 1.15)
        .call(() => Acq.sound.blip(200, 110, 90, 0.04), null, 1.45)
        .to(label, { opacity: 1, y: 0, duration: 0.25, ease: "power2.out" }, 1.45)
        .to(key, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2.4)" }, 1.5);

      // Ambient: a slow pulse on the lock. The coins stay still.
      const amb = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.9 })
        .set(pulse, { opacity: 0.7, attr: { r: 4 } }, 0)
        .to(pulse, { opacity: 0, attr: { r: 14 }, duration: 1.6, ease: "power1.out" }, 0);
      return { tl, amb };
    },

    verify(card) {
      const svg = svgOf(card);
      const ticks = q(svg, "[data-d=tick]");
      const bars = q(svg, "[data-d=redact]");
      const shines = q(svg, "[data-d=shine]");
      const hidden = q(svg, "[data-d=hidden]");
      const scan = svg.querySelector("[data-d=scan]");
      const ROWS = [40, 100, 160, 220, 280];
      const SWEEP = 1.1;
      const T0 = 0.1;
      const Y0 = 14;
      const Y1 = 306;

      // Start frame: unchecked rows, empty redaction bars, scan line off.
      prep(ticks);
      gsap.set(bars, { attr: { width: 0 } });
      gsap.set(shines, { opacity: 0 });
      gsap.set(hidden, { opacity: 0 });
      gsap.set(scan, { opacity: 0, y: Y0 });

      // The scan line moves down at power1.inOut. Each row checks when the line crosses it.
      const sweepEase = gsap.parseEase("power1.inOut");
      const crossAt = (y) => {
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 24; k++) {
          const m = (lo + hi) / 2;
          if (Y0 + sweepEase(m) * (Y1 - Y0) < y) lo = m;
          else hi = m;
        }
        return T0 + hi * SWEEP;
      };

      const tl = gsap.timeline({ paused: true });
      tl.set(scan, { opacity: 1, y: Y0 }, T0)
        .to(scan, { y: Y1, duration: SWEEP, ease: "power1.inOut" }, T0)
        .set(scan, { opacity: 0 }, T0 + SWEEP);

      let last = 0;
      ROWS.forEach((y, i) => {
        const t = crossAt(y);
        draw(tl, ticks[i], t, 0.2);
        tl.call(() => Acq.sound.blip(640, 880, 60, 0.03), null, t);
        if (i < 3) return;
        const k = i - 3;
        tl.to(bars[k], { attr: { width: 150 }, duration: 0.22, ease: "power2.out" }, t + 0.05)
          .set(shines[k], { opacity: 1, attr: { x: 64 } }, t + 0.25)
          .to(shines[k], { attr: { x: 208 }, duration: 0.5, ease: "power1.inOut" }, t + 0.25)
          .set(shines[k], { opacity: 0 }, t + 0.75)
          .to(hidden[k], { opacity: 1, duration: 0.25 }, t + 0.3);
        last = Math.max(last, t + 0.75);
      });
      tl.call(slam, null, last + 0.05);

      // Ambient: a periodic scan sweep down the rows.
      const amb = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.6 })
        .set(scan, { opacity: 0, y: Y0 }, 0)
        .to(scan, { y: Y1, duration: 2, ease: "power1.inOut" }, 0)
        .to(scan, { opacity: 0.8, duration: 0.4, ease: "power1.out" }, 0)
        .to(scan, { opacity: 0, duration: 0.45, ease: "power1.in" }, 1.55);
      return { tl, amb };
    },
  };

  // Built on the first desktop or stacked setup. Building at load would apply the start frames under reduced motion, which must keep the markup's final frames.
  // One entry per card. The story starts once; the ambient loop runs only after the story and while the card is visible.
  let cards = null;
  const buildCards = () => {
    if (cards) return;
    cards = steps.map((card) => {
      const { tl, amb } = DIAGRAMS[card.dataset.kind](card);
      const c = { started: false, played: false, visible: false };
      c.sync = () => (c.played && c.visible ? amb.play() : amb.pause());
      c.start = () => {
        if (c.started) return;
        c.started = true;
        tl.play(0);
      };
      c.setVisible = (on) => {
        if (c.visible === on) return;
        c.visible = on;
        c.sync();
      };
      tl.eventCallback("onComplete", () => { c.played = true; c.sync(); });
      return c;
    });
  };

  // Desktop: a card plays once its centre passes 75% of the pinned viewport. Checked on every pin update, because a card can already be in range at load.
  const checkCentres = () => {
    if (!h || !h.scrollTrigger || window.scrollY < h.scrollTrigger.start - 2) return;
    const x = -h.progress() * dist;
    const limit = pin.clientWidth * 0.75;
    cards.forEach((c, i) => {
      if (!c.started && lefts[i] + x + widths[i] / 2 <= limit) c.start();
    });
  };

  // The active rail step is the card nearest the viewport centre. The fill eases toward the scroll progress.
  const onScrub = () => {
    if (!h) return;
    const p = h.progress();
    setFill(p);
    const x = -p * dist;
    const mid = pin.clientWidth / 2;
    let idx = 0;
    let best = Infinity;
    steps.forEach((_, i) => {
      const d = Math.abs(lefts[i] + x + widths[i] / 2 - mid);
      if (d < best) { best = d; idx = i; }
    });
    setActive(Math.min(idx, ticks.length - 1));
    checkCentres();
  };

  const setupDesktop = () => {
    buildCards();
    measure();
    setFill = gsap.quickTo(fill, "scaleX", { duration: 0.6, ease: "power3.out" });
    h = gsap.to(track, {
      x: () => -dist,
      ease: "none",
      onUpdate: onScrub,
      scrollTrigger: {
        trigger: pin,
        pin: true,
        anticipatePin: 1,
        start: "top top",
        end: () => "+=" + dist,
        scrub: 1,
        invalidateOnRefresh: true,
        onUpdate: checkCentres,
      },
    });

    steps.forEach((card, i) => {
      ScrollTrigger.create({
        trigger: card,
        containerAnimation: h,
        start: "left 100%",
        end: "right 0%",
        onUpdate: (self) => cards[i].setVisible(self.isActive),
      });
      gsap.fromTo(
        card.querySelector(".docket-card__num"),
        { xPercent: 0 },
        {
          xPercent: -6,
          ease: "none",
          scrollTrigger: { trigger: card, containerAnimation: h, start: "left right", end: "right left", scrub: true },
        }
      );
    });
    // The pin trigger's progress stays at 0 at its start, so its onUpdate can miss the first card. Window scroll always fires.
    window.addEventListener("scroll", checkCentres, { passive: true });
    onScrub();
  };

  const setupStacked = () => {
    buildCards();
    steps.forEach((card, i) => {
      ScrollTrigger.create({
        trigger: card,
        start: "top 80%",
        onUpdate: (self) => { if (self.progress > 0) cards[i].start(); },
      });
      ScrollTrigger.create({
        trigger: card,
        start: "top bottom",
        end: "bottom top",
        onUpdate: (self) => cards[i].setVisible(self.isActive),
      });
    });
  };

  Acq.ready.then(() => {
    ScrollTrigger.addEventListener("refreshInit", measure);
    if (!Acq.reduce) {
      indexRows.forEach((el, i) => {
        ScrollTrigger.create({
          trigger: el,
          start: "top 92%",
          once: true,
          onEnter: () => Acq.scramble(el, { duration: 0.7, delay: i * 0.06 }),
        });
      });
    }
    const mm = gsap.matchMedia();
    mm.add(
      {
        desktop: "(min-width: 900px) and (prefers-reduced-motion: no-preference)",
        stacked: "(max-width: 899.98px) and (prefers-reduced-motion: no-preference)",
      },
      (ctx) => {
        section.classList.add("is-armed");
        if (ctx.conditions.desktop) setupDesktop();
        else setupStacked();
        return () => {
          section.classList.remove("is-armed");
          window.removeEventListener("scroll", checkCentres);
        };
      }
    );
  });
})();
