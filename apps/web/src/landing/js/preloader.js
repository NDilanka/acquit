import gsap from "gsap";

(() => {
  const el = document.querySelector("[data-preloader]");
  if (!el) return;

  const KEY = "acquit:intro";
  const nointro = new URLSearchParams(location.search).has("nointro");
  let seen = false;
  try { seen = sessionStorage.getItem(KEY) === "1"; } catch (_) { /* storage blocked: play the intro */ }
  if (Acq.reduce || nointro || seen) { el.remove(); Acq.startIntro(); return; }
  try { sessionStorage.setItem(KEY, "1"); } catch (_) { /* storage blocked */ }

  const MIN = 700;
  const MAX = 1100;
  const t0 = performance.now();
  const label = el.querySelector(".preloader__label");
  const count = el.querySelector(".preloader__count");
  const fill = el.querySelector(".preloader__fill");
  const logo = el.querySelector(".preloader__logo");
  const video = document.querySelector(".hero__video");

  let fontsOk = false;
  let videoOk = !video || video.readyState >= 3;
  Acq.ready.then(() => { fontsOk = true; });
  if (!videoOk) {
    const done = () => { videoOk = true; };
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("error", done, { once: true });
    video.querySelector("source")?.addEventListener("error", done, { once: true });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    el.remove();
    Acq.lenis?.start();
  };
  Acq.lenis?.stop();

  Acq.scramble(label, { text: "CLEARING", duration: 0.7 });
  const glyphs = logo.querySelectorAll("svg > path:not(.tick)");
  const mark = logo.querySelector(".tick");
  gsap.from(glyphs, { yPercent: 40, autoAlpha: 0, duration: 0.8, ease: "expo.out", stagger: 0.035 });
  gsap.from(mark, { scale: 0, rotate: -20, duration: 0.45, ease: "back.out(2.2)", delay: 0.4 });

  let value = 0;
  let exiting = false;
  let hardCap = 0;
  let lastText = "";

  const paint = () => {
    const text = String(Math.round(value)).padStart(3, "0");
    if (text !== lastText) { count.textContent = text; lastText = text; }
    fill.style.transform = `scaleX(${(value / 100).toFixed(4)})`;
  };

  const exit = () => {
    if (exiting) return;
    exiting = true;
    clearTimeout(hardCap);
    gsap.ticker.remove(tick);
    value = 100;
    paint();
    Acq.startIntro();
    gsap.to(el, {
      clipPath: "inset(0% 0% 100% 0%)",
      duration: 0.9,
      ease: "power4.inOut",
      onComplete: release,
    });
    setTimeout(release, 1500);
  };

  const tick = (_, deltaMs) => {
    const elapsed = performance.now() - t0;
    const dt = Math.min(deltaMs, 64) / 1000;
    const real = (fontsOk ? 50 : 0) + (videoOk ? 50 : 0);
    const creep = 30 * Math.min(1, elapsed / MIN);
    const target = Math.max(real, creep);
    value += (target - value) * (1 - Math.exp(-dt * (real === 100 ? 9 : 5)));
    paint();
    if ((real === 100 && value > 99.5 && elapsed >= MIN) || elapsed >= MAX) exit();
  };

  gsap.ticker.add(tick);
  hardCap = setTimeout(exit, MAX);
  el.addEventListener("click", exit);
  window.addEventListener("keydown", exit, { once: true });
})();
