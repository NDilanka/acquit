import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

(() => {
  const p = document.querySelector(".manifesto-p");
  if (!p || Acq.reduce) return;

  SplitText.create(p, {
    type: "words,chars",
    tag: "span",
    charsClass: "manifesto-char",
    autoSplit: true,
    onSplit(self) {
      return gsap.fromTo(
        self.chars,
        { "--w": 0 },
        {
          "--w": 1,
          duration: 0.4,
          stagger: 0.02,
          ease: "none",
          scrollTrigger: { trigger: p, start: "top 72%", end: "bottom 58%", scrub: 0.6 },
        }
      );
    },
  });
})();
