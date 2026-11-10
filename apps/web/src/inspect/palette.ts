/** Stage colours, read from the design tokens so the 3D view follows the light and dark themes. */
export type Palette = {
  readonly background: string;
  readonly bed: string;
  readonly bedLine: string;
  readonly sheet: string;
  readonly part: string;
  readonly cutHot: string;
  readonly cutCool: string;
  readonly engrave: string;
  readonly travel: string;
  readonly fail: string;
  readonly head: string;
  readonly beam: string;
  readonly copper: string;
  readonly other: string;
};

const TOKENS: Readonly<Record<keyof Palette, string>> = {
  background: "--surface",
  bed: "--surface-2",
  bedLine: "--line-2",
  sheet: "--panel",
  part: "--green-bg",
  cutHot: "--em-400",
  cutCool: "--ink-2",
  engrave: "--blue",
  travel: "--muted",
  fail: "--red",
  head: "--ink-2",
  beam: "--em-300",
  copper: "--amber",
  other: "--muted",
};

const FALLBACK: Palette = {
  background: "#F6F7F6",
  bed: "#E6E9E7",
  bedLine: "#77827B",
  sheet: "#FFFFFF",
  part: "#CCFAE9",
  cutHot: "#0CAB75",
  cutCool: "#2A2F2D",
  engrave: "#285A78",
  travel: "#5F6662",
  fail: "#A0352C",
  head: "#2A2F2D",
  beam: "#3BD9A1",
  copper: "#79500B",
  other: "#5F6662",
};

export function readPalette(): Palette {
  if (typeof document === "undefined") return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const key of Object.keys(TOKENS) as (keyof Palette)[]) {
    const value = style.getPropertyValue(TOKENS[key]).trim();
    out[key] = /^#[0-9a-f]{3,8}$/i.test(value) ? value : FALLBACK[key];
  }
  return out as Palette;
}

/** Calls back whenever the theme attribute on <html> changes. */
export function onThemeChange(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
