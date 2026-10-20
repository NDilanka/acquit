(() => {
  const root = document.getElementById("machine");
  if (!root) return;

  const DEV_W = 680;
  const REFLOW_W = 620;
  const RCPT_W = 260;
  const TICKET_W = 260, TICKET_H = 150;
  const FEED_DEPTH = TICKET_H / 2;
  const ACCEPT = 0.44;
  const GRAVITY = 1000;
  const SEAT = "cubic-bezier(.2,.8,.25,1)";
  const PRESS = "cubic-bezier(.2,.8,.25,1)";
  const SNAP = "cubic-bezier(.22,.8,.3,1.08)";
  const FEED = "cubic-bezier(.55,.085,.68,.53)";
  const EJECT = "cubic-bezier(.5,1,.89,1)";
  const RETURN = "cubic-bezier(.2,.8,.2,1)";

  const TEXT = {
    idle: "DRAG A SUBMISSION INTO THE SLOT",
    run: "VERIFYING…",
    done: "VERDICT ISSUED · RESET TO TRY ANOTHER",
    label: "INSERT SUBMISSION",
    range: "RELEASE TO VERIFY",
  };
  const ESCROW = {
    idle: ["AWAITING VERDICT", "PAYOUT ONLY ON A PASS"],
    run: ["HELD", "VERIFYING"],
    pass: ["HELD", "RELEASES AFTER 72H REVIEW"],
    reject: ["MONEY STAYS HELD", "REJECTED · NO PAYOUT"],
  };
  const VERDICT = {
    pass: { word: "PASS", sub: "Receipt printed · sandbox" },
    reject: { word: "REJECTED", sub: "Money stays held · sandbox" },
  };
  const STEP = { drop: 1, checks: 2, verdict: 3 };
  const SCREEN_IDLE = "> VRF-01 READY · AWAITING SUBMISSION";
  const DIAL = { off: 180, code: 240, print: 300 };

  const SCRIPTS = {
    a: {
      verdict: "pass",
      dial: DIAL.code,
      lines: [
        { t: "> verifier vrf-01 · job #0412 · field: code" },
        { t: "> frozen tests ............ ", count: 12, tail: "/12", ok: true },
        { t: "> hidden cases ........... 5/5", ok: true },
        { t: "> diff touches tests/ ...... no", ok: true },
      ],
    },
    b: {
      verdict: "reject",
      dial: DIAL.code,
      lines: [
        { t: "> verifier vrf-01 · job #0413 · field: code" },
        { t: "> frozen tests ............ ", count: 12, tail: "/12", ok: true },
        { t: "> diff touches tests/ ...... YES", tone: "hold", ok: false },
        { t: "> tests/pagination.test.ts edited", tone: "hold" },
      ],
    },
    c: {
      verdict: "pass",
      dial: DIAL.print,
      lines: [
        { t: "> verifier vrf-02 · field: 3d print" },
        { t: "> printer: SIMULATED (sandbox)" },
        { t: "> manifold ................ ok", ok: true },
        { t: "> dimensions ±0.2mm ....... ", count: 4, tail: "/4", ok: true },
        { t: "> photo evidence .......... ok", ok: true },
      ],
    },
  };

  const RECEIPT = {
    a: { job: "#0412 · CODE FIX", pay: "$40.00 − FEE (SANDBOX)" },
    c: { job: "#0414 · 3D PRINT", pay: "$64.00 − FEE (SANDBOX)" },
  };

  const reduce = Acq.reduce;
  const $ = (sel) => root.querySelector(sel);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const blip = (f0, f1, ms, gain) => Acq.sound.blip(f0, f1, ms, gain);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const stage = $(".machine-stage");
  const devwrap = $(".machine-devwrap");
  const device = $(".machine-device");
  const slot = $(".machine-slot");
  const slotLabel = $(".machine-slot__label");
  const screen = $(".machine-screen");
  const screenLog = $(".machine-screen__log");
  const screenIdle = $(".machine-screen__idle");
  const screenIdleLine = $(".machine-screen__idle-line");
  const verdictEl = $(".machine-screen__verdict");
  const verdictWord = $(".machine-screen__verdict-word");
  const verdictSub = $(".machine-screen__verdict-sub");
  const bar = $(".machine-screen__bar");
  const flash = $(".machine-screen__flash");
  const led = $(".machine-led");
  const escrow = $(".machine-escrow");
  const escrowState = $(".machine-escrow__v");
  const escrowNote = $(".machine-escrow__n");
  const dial = $(".machine-dial");
  const needle = $(".machine-dial__needle");
  const mouth = $(".machine-mouth");
  const rcpt = $(".machine-rcpt");
  const receipt = $(".machine-receipt");
  const rcptJob = $('[data-rc="job"]');
  const rcptPay = $('[data-rc="pay"]');
  const instrText = $(".machine-instr__text");
  const instrSr = $(".machine-instr__sr");
  const resetBtn = $(".machine-reset");
  const steps = [...root.querySelectorAll(".machine-step")];

  const M = { slotX: 0, slotY: 0, recH: 0 };
  const state = { phase: "idle", active: null, keyboard: false, printed: false, raf: 0, last: 0, wobble: null };

  const shadow = (L) =>
    `drop-shadow(${(2 + 0.4 * L).toFixed(2)}px ${(3 + 0.9 * L).toFixed(2)}px ${(1 + 0.4 * L).toFixed(2)}px var(--sh))`;
  const REST = (T) => ({ x: 0, y: 0, r: T.base, s: 1, L: 0 });
  const pose = (T) => ({ x: T.x, y: T.y - T.L, r: T.base + T.tilt, s: T.s, L: T.L });
  const frame = (p) => ({
    translate: `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`,
    rotate: `${p.r.toFixed(2)}deg`,
    scale: p.s.toFixed(4),
    filter: shadow(p.L),
  });
  const applyPose = (T, p) => Object.assign(T.el.style, frame(p));
  const setPose = (T, p) => {
    applyPose(T, p);
    T.x = p.x;
    T.y = p.y + p.L;
    T.L = p.L;
    T.tilt = p.r - T.base;
    T.s = p.s;
  };
  const play = (T, frames, opts) => T.el.animate(frames, { fill: "forwards", ...opts });
  const cancelAnims = (T) => T.el.getAnimations().forEach((a) => a.cancel());
  const stripScale = ({ scale, ...rest }) => rest;

  const setInstr = (text, srText = "") => {
    instrText.textContent = text;
    instrSr.textContent = srText;
  };
  const setLed = (cls) => {
    led.classList.remove("is-pass", "is-hold");
    if (cls) led.classList.add(cls);
  };
  const placeReceipt = (y) => {
    receipt.style.translate = `0px ${y.toFixed(2)}px`;
  };
  const setDial = (deg, on) => {
    needle.style.setProperty("--a", `${deg}deg`);
    dial.classList.toggle("is-set", on);
  };
  const setStep = (n) =>
    steps.forEach((el, i) => {
      el.classList.toggle("is-done", i + 1 < n);
      el.classList.toggle("is-on", i + 1 === n);
    });
  const setEscrow = (key, tone = "") => {
    const [value, note] = ESCROW[key];
    escrow.classList.toggle("is-pass", tone === "pass");
    escrow.classList.toggle("is-hold", tone === "hold");
    Acq.scramble(escrowState, { text: value, duration: 0.32 });
    Acq.scramble(escrowNote, { text: note, duration: 0.32 });
  };
  const setBar = (f) => {
    bar.style.transform = `scaleX(${clamp(f, 0, 1).toFixed(3)})`;
  };
  const openVerdict = (kind) => {
    verdictWord.textContent = VERDICT[kind].word;
    verdictSub.textContent = VERDICT[kind].sub;
    verdictEl.classList.toggle("is-hold", kind === "reject");
    verdictEl.classList.add("is-open");
    if (reduce) return;
    flash.style.background = kind === "pass" ? "var(--signal)" : "var(--hold)";
    flash.animate([{ opacity: 0 }, { opacity: 0.4, offset: 0.2 }, { opacity: 0 }], { duration: 520, easing: "ease-out" });
  };
  const closeVerdict = () => verdictEl.classList.remove("is-open");

  const startWobble = () => {
    if (reduce) return;
    state.wobble?.cancel();
    state.wobble = needle.animate([{ rotate: "-5deg" }, { rotate: "5deg" }], {
      duration: 340,
      iterations: Infinity,
      direction: "alternate",
      easing: "ease-in-out",
    });
  };
  const stopWobble = () => {
    state.wobble?.cancel();
    state.wobble = null;
  };
  const settleDial = () => {
    if (reduce) return;
    needle.animate(
      [{ rotate: "7deg" }, { rotate: "-3deg", offset: 0.4 }, { rotate: "1deg", offset: 0.72 }, { rotate: "0deg" }],
      { duration: 820, easing: RETURN }
    );
  };
  const settleReceipt = () => {
    if (reduce) return;
    receipt.animate(
      [{ rotate: "0deg" }, { rotate: "1.4deg", offset: 0.3 }, { rotate: "-0.5deg", offset: 0.6 }, { rotate: "0deg" }],
      { duration: 640, easing: RETURN }
    );
  };
  const nudge = (T) => {
    if (reduce || state.phase !== "idle") return;
    T.el.animate(
      [
        { translate: "0px 0px", rotate: `${T.base}deg`, filter: shadow(0) },
        { translate: "0px -10px", rotate: `${T.base - 2}deg`, filter: shadow(12), offset: 0.4 },
        { translate: "0px 0px", rotate: `${T.base}deg`, filter: shadow(0) },
      ],
      { duration: 900, easing: SNAP }
    );
  };

  const dimOthers = (T) =>
    tickets.forEach((o) => {
      const other = o !== T;
      o.el.classList.toggle("is-dim", other);
      o.el.disabled = other;
    });
  const clearDim = () =>
    tickets.forEach((o) => {
      o.el.classList.remove("is-dim");
      o.el.disabled = false;
    });

  const drawBars = (svg, seed) => {
    let s = seed >>> 0 || 1;
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const W = 220;
    const rects = [];
    let x = 0;
    while (x < W) {
      const w = 1 + Math.floor(next() * 3);
      if (next() > 0.3) rects.push(`<rect x="${x}" y="0" width="${w}" height="20"/>`);
      x += w + 1 + Math.floor(next() * 2);
    }
    svg.setAttribute("viewBox", `0 0 ${W} 20`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = rects.join("");
  };

  const tickets = [...root.querySelectorAll(".machine-ticket")].map((el) => ({
    el,
    id: el.dataset.ticket,
    base: parseFloat(el.dataset.rot) || 0,
    sx: Acq.spring(1800, 76),
    sy: Acq.spring(1800, 76),
    sl: Acq.spring(320, 30),
    x: 0,
    y: 0,
    L: 0,
    tilt: 0,
    s: 1,
    cx: 0,
    cy: 0,
    w: TICKET_W,
    inRange: false,
    grab: null,
    ptr: { x: 0, y: 0 },
  }));

  const measure = () => {
    const reflow = stage.clientWidth < REFLOW_W;
    stage.classList.toggle("is-reflow", reflow);
    stage.style.setProperty("--dev-s", reflow ? "1" : Math.min(1, stage.clientWidth / DEV_W).toFixed(4));
    const sr = stage.getBoundingClientRect();
    const sl = slot.getBoundingClientRect();
    const mr = mouth.getBoundingClientRect();
    M.slotX = sl.left - sr.left + sl.width / 2;
    M.slotY = sl.top - sr.top + sl.height / 2;
    M.recH = receipt.offsetHeight;
    const portX = clamp(mr.left - sr.left, 0, stage.clientWidth - RCPT_W);
    const portY = mr.top - sr.top;
    rcpt.style.left = `${portX.toFixed(2)}px`;
    rcpt.style.top = `${portY.toFixed(2)}px`;
    rcpt.style.height = `${Math.max(0, stage.clientHeight - portY).toFixed(2)}px`;
    tickets.forEach((T) => {
      T.cx = T.el.offsetLeft + T.el.offsetWidth / 2;
      T.cy = T.el.offsetTop + T.el.offsetHeight / 2;
      T.w = T.el.offsetWidth;
    });
    if (state.phase === "idle") placeReceipt(-M.recH);
  };

  const drive = (spring, target, dt) => {
    if (reduce) {
      spring.x = target;
      spring.v = 0;
      return target;
    }
    spring.target = target;
    spring.step(dt);
    return spring.x;
  };

  const checkRange = (T) => {
    const inside = Math.hypot(T.cx + T.x - M.slotX, T.cy + T.y - M.slotY) <= ACCEPT * T.w;
    if (inside === T.inRange) return;
    T.inRange = inside;
    device.classList.toggle("is-range", inside);
    Acq.scramble(slotLabel, { text: inside ? TEXT.range : TEXT.label, duration: 0.3 });
  };

  const tick = (now) => {
    const T = state.active;
    const dt = clamp((now - state.last) / 1000, 0.001, 0.05);
    state.last = now;
    T.x = drive(T.sx, T.ptr.x, dt);
    T.y = drive(T.sy, T.ptr.y, dt);
    T.L = drive(T.sl, T.inRange ? 6 : 18, dt);
    T.tilt += (clamp(T.sx.v * 0.008, -7, 7) - T.tilt) * (1 - Math.exp(-dt * 14));
    T.s = 1.03;
    checkRange(T);
    applyPose(T, pose(T));
    state.raf = requestAnimationFrame(tick);
  };

  const begin = (T, e) => {
    cancelAnims(T);
    state.phase = "held";
    state.active = T;
    T.grab = { id: e.pointerId, x: e.clientX, y: e.clientY };
    T.ptr = { x: 0, y: 0 };
    T.sx.x = T.sx.v = T.sx.target = 0;
    T.sy.x = T.sy.v = T.sy.target = 0;
    T.sl.x = T.sl.v = T.sl.target = 0;
    T.tilt = 0;
    blip(640, 420, 105, 0.038);
    state.last = performance.now();
    state.raf = requestAnimationFrame(tick);
  };

  const snap = async (T) => {
    state.phase = "snapping";
    blip(360, 260, 70, 0.03);
    setTimeout(() => blip(360, 260, 70, 0.02), 110);
    if (!reduce) {
      await play(T, [frame(pose(T)), frame(REST(T))], { duration: 460, easing: SNAP }).finished;
    }
    setPose(T, REST(T));
    cancelAnims(T);
    state.phase = "idle";
    state.active = null;
  };

  const feed = async (T) => {
    state.phase = "feeding";
    setDial(SCRIPTS[T.id].dial, true);
    setEscrow("run");
    device.classList.remove("is-range");
    Acq.scramble(slotLabel, { text: TEXT.label, duration: 0.3 });
    dimOthers(T);
    const seated = { x: T.x, y: T.y };
    const fed = { x: seated.x, y: seated.y + FEED_DEPTH };
    [0, 200, 400].forEach((d) => setTimeout(() => blip(1200, 900, 25, 0.02), d));
    if (reduce) {
      setPose(T, { x: fed.x, y: fed.y, r: 0, s: 1, L: 0 });
    } else {
      slot.classList.add("is-feeding");
      await play(
        T,
        [
          { translate: `${seated.x}px ${seated.y}px`, clipPath: "inset(0px 0px 0px 0px)" },
          { translate: `${fed.x}px ${fed.y}px`, clipPath: "inset(0px 0px 100% 0px)" },
        ],
        { duration: 600, easing: FEED }
      ).finished;
      slot.classList.remove("is-feeding");
      setPose(T, { x: fed.x, y: fed.y, r: 0, s: 1, L: 0 });
      cancelAnims(T);
    }
    T.el.style.clipPath = "inset(0px 0px 100% 0px)";
    await run(T);
  };

  const insert = async (T, keyboard) => {
    state.phase = "seating";
    state.active = T;
    state.keyboard = keyboard;
    device.classList.add("is-busy");
    const to = { x: M.slotX - T.cx, y: M.slotY - T.cy };
    const end = { x: to.x, y: to.y, r: 0, s: 1, L: 0 };
    if (reduce) {
      setPose(T, end);
      return feed(T);
    }
    if (keyboard) setPose(T, REST(T));
    const glideFrames = keyboard
      ? [
          frame(REST(T)),
          frame({ x: to.x / 2, y: to.y / 2 - 70, r: T.base / 2, s: 1, L: 14 }),
          frame(end),
        ].map(stripScale)
      : [frame(pose(T)), frame(end)].map(stripScale);
    const glide = play(T, glideFrames, { duration: keyboard ? 900 : 700, easing: SEAT });
    const press = play(
      T,
      [
        { scale: T.s.toFixed(4) },
        { scale: "1.045", offset: 0.35 },
        { scale: "0.998", offset: 0.85 },
        { scale: "1" },
      ],
      { duration: 520, easing: PRESS }
    );
    await Promise.all([glide.finished, press.finished]);
    setPose(T, end);
    cancelAnims(T);
    await feed(T);
  };

  const release = (T) => {
    cancelAnimationFrame(state.raf);
    if (T.inRange) insert(T, false);
    else snap(T);
  };

  const shake = () => {
    if (reduce) return;
    devwrap.animate(
      [
        { translate: "0px 0px" },
        { translate: "3px 0px" },
        { translate: "-3px 0px" },
        { translate: "3px 0px" },
        { translate: "-3px 0px" },
        { translate: "0px 0px" },
      ],
      { duration: 320, easing: "ease-in-out" }
    );
  };

  const writeLines = async (lines) => {
    const total = lines.filter((l) => l.ok !== undefined).length;
    let done = 0;
    for (const line of lines) {
      const p = document.createElement("p");
      p.className = "machine-screen__line" + (line.tone === "hold" ? " is-hold" : "");
      const text = document.createElement("span");
      const mark = document.createElement("span");
      mark.className = "machine-screen__mark";
      p.append(text, mark);
      screenLog.append(p);
      const checked = line.ok !== undefined;
      const tail = line.count != null ? `${line.count}${line.tail}` : "";
      if (checked && !reduce) mark.classList.add("is-run");
      if (reduce) {
        text.textContent = line.t + tail;
      } else {
        for (let i = 1; i <= line.t.length; i++) {
          text.textContent = line.t.slice(0, i);
          await sleep(16);
        }
        if (line.count != null) {
          for (let n = 0; n <= line.count; n++) {
            text.textContent = line.t + n + line.tail;
            if (n < line.count) await sleep(30);
          }
        }
      }
      if (checked) {
        if (!reduce) await sleep(260);
        mark.classList.remove("is-run");
        mark.classList.add(line.ok ? "is-ok" : "is-fail");
        mark.textContent = line.ok ? "✓" : "✗";
        done += 1;
        setBar(done / total);
      }
      await sleep(reduce ? 0 : 160);
    }
  };

  const printReceipt = async (id) => {
    state.phase = "printing";
    rcptJob.textContent = RECEIPT[id].job;
    rcptPay.textContent = RECEIPT[id].pay;
    if (reduce) {
      placeReceipt(0);
      return;
    }
    const top = -M.recH;
    const STEPS = 12;
    for (let k = 1; k <= STEPS; k++) {
      const jitter = k < STEPS ? Math.random() * 2 - 1 : 0;
      placeReceipt(top + (M.recH * k) / STEPS + jitter);
      blip(1800, 1700, 12, 0.012);
      if (k < STEPS) await sleep(k % 4 === 0 ? 140 : 34 + Math.random() * 26);
    }
    settleReceipt();
  };

  const eject = async (T) => {
    state.phase = "ejecting";
    const seatedY = T.y - FEED_DEPTH;
    const seated = { x: T.x, y: seatedY, r: T.base, s: 1, L: 0 };
    const rest = REST(T);
    if (!reduce) {
      await play(
        T,
        [
          { translate: `${T.x}px ${T.y}px`, clipPath: "inset(0px 0px 100% 0px)" },
          { translate: `${T.x}px ${seatedY}px`, clipPath: "inset(0px 0px 0px 0px)" },
        ],
        { duration: 500, easing: EJECT }
      ).finished;
      await play(
        T,
        [
          { ...frame(seated), clipPath: "inset(0px 0px 0px 0px)" },
          { ...frame(rest), clipPath: "inset(0px 0px 0px 0px)" },
        ],
        { duration: 500, easing: SNAP }
      ).finished;
    }
    setPose(T, rest);
    T.el.style.clipPath = "none";
    cancelAnims(T);
  };

  const passVerdict = async (T) => {
    setLed("is-pass");
    setStep(STEP.verdict);
    settleDial();
    setEscrow("pass", "pass");
    openVerdict("pass");
    setInstr(TEXT.done, "Verdict: pass. Escrow releases after a 72-hour client review. Receipt printed.");
    T.el.disabled = true;
    await sleep(reduce ? 0 : 420);
    await printReceipt(T.id);
    state.printed = true;
    state.phase = "verdict";
    resetBtn.disabled = false;
    if (state.keyboard) resetBtn.focus({ preventScroll: true });
  };

  const rejectVerdict = async (T) => {
    setLed("is-hold");
    setStep(STEP.verdict);
    settleDial();
    setEscrow("reject", "hold");
    bar.classList.add("is-hold");
    openVerdict("reject");
    shake();
    setInstr(TEXT.done, "Verdict: rejected. Money stays held.");
    T.el.disabled = true;
    await eject(T);
    T.el.classList.add("is-rejected");
    state.phase = "verdict";
    resetBtn.disabled = false;
    if (state.keyboard) resetBtn.focus({ preventScroll: true });
  };

  const run = async (T) => {
    state.phase = "running";
    setInstr(TEXT.run);
    setStep(STEP.checks);
    setBar(0);
    screenIdle.hidden = true;
    startWobble();
    await writeLines(SCRIPTS[T.id].lines);
    stopWobble();
    if (SCRIPTS[T.id].verdict === "pass") await passVerdict(T);
    else await rejectVerdict(T);
  };

  const fallReceipt = () => {
    const frames = [];
    const N = 14;
    const dur = 0.6;
    for (let i = 0; i <= N; i++) {
      const t = (dur * i) / N;
      frames.push({
        offset: i / N,
        translate: `0px ${(0.5 * GRAVITY * t * t).toFixed(1)}px`,
        rotate: `${(6 * Math.min(1, t / 0.2)).toFixed(2)}deg`,
        opacity: Math.max(0, 1 - t / 0.42).toFixed(3),
      });
    }
    return receipt.animate(frames, { duration: dur * 1000, fill: "forwards" }).finished.then(() => {
      receipt.getAnimations().forEach((a) => a.cancel());
      receipt.style.rotate = "";
      receipt.style.opacity = "";
      placeReceipt(-M.recH);
    });
  };

  const returnTicket = (T) => {
    if (reduce) {
      setPose(T, REST(T));
      T.el.style.clipPath = "none";
      return Promise.resolve();
    }
    const rest = frame(REST(T));
    return play(
      T,
      [
        { ...rest, translate: "0px 24px", opacity: "0", clipPath: "inset(0px 0px 0px 0px)" },
        { ...rest, opacity: "1", clipPath: "inset(0px 0px 0px 0px)" },
      ],
      { duration: 500, easing: RETURN }
    ).finished.then(() => {
      setPose(T, REST(T));
      T.el.style.clipPath = "none";
      T.el.style.opacity = "";
      cancelAnims(T);
    });
  };

  const reset = async () => {
    if (state.phase !== "verdict") return;
    const T = state.active;
    state.phase = "resetting";
    resetBtn.disabled = true;
    device.classList.remove("is-busy");
    setInstr(TEXT.idle);
    setLed(null);
    setDial(DIAL.off, false);
    setStep(STEP.drop);
    setEscrow("idle");
    closeVerdict();
    setBar(0);
    bar.classList.remove("is-hold");
    screenLog.replaceChildren();
    screenIdle.hidden = false;
    const jobs = [];
    if (state.printed) jobs.push(reduce ? (placeReceipt(-M.recH), Promise.resolve()) : fallReceipt());
    if (SCRIPTS[T.id].verdict === "pass") jobs.push(returnTicket(T));
    else T.el.classList.remove("is-rejected");
    jobs.push(Acq.scramble(screenIdleLine, { text: SCREEN_IDLE, duration: 0.35 }));
    jobs.push(Acq.scramble(slotLabel, { text: TEXT.label, duration: 0.3 }));
    await Promise.all(jobs);
    state.printed = false;
    clearDim();
    setPose(T, REST(T));
    T.el.style.clipPath = "none";
    T.el.style.opacity = "";
    cancelAnims(T);
    state.active = null;
    state.keyboard = false;
    state.phase = "idle";
  };

  const bindTicket = (T) => {
    const el = T.el;
    el.addEventListener("pointerdown", (e) => {
      if (state.phase !== "idle" || e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      begin(T, e);
    });
    el.addEventListener("pointermove", (e) => {
      if (!T.grab || e.pointerId !== T.grab.id) return;
      T.ptr.x = e.clientX - T.grab.x;
      T.ptr.y = e.clientY - T.grab.y;
    });
    const end = (e) => {
      if (!T.grab || e.pointerId !== T.grab.id) return;
      T.grab = null;
      release(T);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("click", (e) => {
      if (e.detail === 0 && state.phase === "idle") insert(T, true);
    });
  };

  const init = () => {
    root.querySelectorAll("[data-bars]").forEach((svg) => drawBars(svg, parseInt(svg.dataset.bars, 10)));
    tickets.forEach((T) => {
      setPose(T, REST(T));
      bindTicket(T);
    });
    setStep(STEP.drop);
    measure();
    resetBtn.addEventListener("click", reset);
    let frameId = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    });
    const live = new IntersectionObserver(([entry]) => {
      root.classList.toggle("is-live", entry.isIntersecting);
      state.wobble?.[entry.isIntersecting ? "play" : "pause"]();
    });
    live.observe(root);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        screen.classList.add("is-on");
        io.disconnect();
        setTimeout(() => nudge(tickets[0]), 900);
      },
      { threshold: 0.3 }
    );
    io.observe(stage);
  };

  Acq.ready.then(init);
})();
