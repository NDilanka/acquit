import gsap from "gsap";

(() => {
  const header = document.querySelector("[data-nav]");
  if (!header) return;
  const overlay = document.querySelector("[data-nav-overlay]");
  const menuBtn = header.querySelector("[data-nav-menu]");
  const closeBtn = overlay.querySelector("[data-nav-close]");
  const soundBtn = header.querySelector("[data-nav-sound]");
  const links = [...overlay.querySelectorAll(".nav-overlay__link")];
  const mobileMq = matchMedia("(max-width: 899px)");

  const paintSound = (on) => {
    soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
    soundBtn.classList.toggle("is-on", !!on);
  };
  paintSound(Acq.sound.on);

  const modeBtn = header.querySelector("[data-nav-mode]");
  const modeLabel = header.querySelector("[data-nav-mode-label]");
  const paintMode = (mode, animate) => {
    const text = mode === "dark" ? "DARK" : "LIGHT";
    modeBtn.setAttribute("aria-pressed", mode === "dark" ? "true" : "false");
    if (animate) Acq.scramble(modeLabel, { text, duration: 0.35 });
    else modeLabel.textContent = text;
  };
  paintMode(Acq.mode, false);
  modeBtn.addEventListener("click", () => {
    Acq.setMode(Acq.mode === "dark" ? "light" : "dark");
    Acq.sound.blip(480, 720, 80, 0.03);
  });
  document.addEventListener("acq:mode", (e) => paintMode(e.detail, true));
  document.addEventListener("acq:sound", (e) => paintSound(e.detail));
  soundBtn.addEventListener("click", () => Acq.sound.toggle());

  let hidden = false;
  let menuOpen = false;
  let lastFocus = null;
  const setHidden = (h) => {
    if (h === hidden) return;
    hidden = h;
    header.classList.toggle("is-hidden", h);
  };
  header.addEventListener("focusin", () => setHidden(false));

  let anchorY = window.scrollY;
  const onScrollPos = (y) => {
    if (menuOpen) return;
    if (y < 120) { setHidden(false); anchorY = y; return; }
    if (y - anchorY > 8) { setHidden(true); anchorY = y; }
    else if (anchorY - y > 8) { setHidden(false); anchorY = y; }
  };
  if (Acq.lenis) Acq.lenis.on("scroll", () => onScrollPos(Acq.lenis.scroll));
  else window.addEventListener("scroll", () => onScrollPos(window.scrollY), { passive: true });

  const lockScroll = (on) => {
    if (Acq.lenis) { if (on) Acq.lenis.stop(); else Acq.lenis.start(); }
    else document.documentElement.style.overflow = on ? "hidden" : "";
  };

  const focusables = () => [closeBtn, ...overlay.querySelectorAll("a[href], button")];
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(true); return; }
    if (e.key !== "Tab") return;
    const list = focusables();
    const first = list[0];
    const last = list[list.length - 1];
    const inside = overlay.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  };

  const openMenu = () => {
    if (menuOpen) return;
    menuOpen = true;
    lastFocus = document.activeElement;
    menuBtn.setAttribute("aria-expanded", "true");
    setHidden(false);
    overlay.style.visibility = "visible";
    lockScroll(true);
    document.addEventListener("keydown", onKey);
    gsap.killTweensOf(overlay);
    gsap.fromTo(overlay,
      { clipPath: "inset(0% 0% 100% 0%)" },
      { clipPath: "inset(0% 0% 0% 0%)", duration: 0.8, ease: "power4.inOut" });
    gsap.fromTo(links, { yPercent: 110 }, { yPercent: 0, duration: 1, ease: "expo.out", stagger: 0.06, delay: 0.35 });
    closeBtn.focus({ preventScroll: true });
  };

  const closeMenu = (restoreFocus) => {
    if (!menuOpen) return;
    menuOpen = false;
    menuBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    lockScroll(false);
    gsap.killTweensOf(overlay);
    gsap.killTweensOf(links);
    gsap.to(links, { yPercent: 110, duration: 0.3, ease: "power2.in", stagger: 0.02 });
    gsap.to(overlay, {
      clipPath: "inset(0% 0% 100% 0%)",
      duration: 0.6,
      ease: "power4.inOut",
      onComplete: () => { overlay.style.visibility = "hidden"; },
    });
    if (restoreFocus) {
      const target = lastFocus instanceof HTMLElement ? lastFocus : menuBtn;
      target.focus({ preventScroll: true });
    }
  };

  menuBtn.addEventListener("click", () => (menuOpen ? closeMenu(true) : openMenu()));
  closeBtn.addEventListener("click", () => closeMenu(true));
  overlay.querySelectorAll("[data-nav-link]").forEach((a) => a.addEventListener("click", () => closeMenu(false)));
  mobileMq.addEventListener("change", (e) => { if (!e.matches) closeMenu(false); });

  Acq.intro.then(() => {
    if (Acq.reduce) return;
    gsap.from(header.querySelectorAll("[data-nav-item]"), {
      y: -12, autoAlpha: 0, duration: 0.8, ease: "expo.out", stagger: 0.06, delay: 0.5,
    });
  });
})();
