import { createElement as h } from "react";
import { sparkCoords, type PassingTests } from "./verdict-grid.ts";

const SPARK = { width: 96, height: 18 } as const;

/** Counts are the reading; the dot or multi-attempt trend is an addition, never the only visible value. */
export function VerdictPassing({ passing: { text, points } }: { readonly passing: PassingTests }) {
  if (points.length === 0) return h("span", { className: "muted" }, text);
  return h("span", { className: "verdict-passing" },
    h("span", { className: "num", title: "Latest recorded test counts" }, text,
      points.length === 1 ? h("span", { className: "verdict-single", "aria-hidden": true }, "●") : null),
    points.length >= 2 ? h("svg", {
      className: "verdict-spark", width: SPARK.width, height: SPARK.height, viewBox: `0 0 ${SPARK.width} ${SPARK.height}`, role: "img",
      "aria-label": `Passing share of ${points.length} counted attempts: ${points.map(point => `${Math.round(point * 100)}%`).join(", ")}`,
    }, h("polyline", { points: sparkCoords(points, SPARK.width, SPARK.height) })) : null,
  );
}
