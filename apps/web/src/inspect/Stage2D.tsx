import { memo } from "react";
import type { Vec2 } from "./contract.ts";
import { partial, type DrawList, type Place, type Stroke } from "./scene-draw.ts";
import type { Frame } from "./timeline.ts";

const STROKE_VAR: Readonly<Record<Stroke, string>> = {
  cut: "var(--em-400)",
  engrave: "var(--blue)",
  travel: "var(--muted)",
  copper: "var(--amber)",
  drill: "var(--ink-2)",
  route: "var(--blue)",
  zone: "var(--amber)",
  other: "var(--muted)",
};

const pts = (points: readonly Vec2[]) => points.map(([x, y]) => `${x},${y}`).join(" ");
const ring = (points: readonly Vec2[]) => `M${pts(points).replace(/ /g, " L")} Z`;

/** The same scene drawn flat, for a browser without WebGL. It reads the same frame as the 3D stage. */
export const Stage2D = memo(function Stage2D({ list, frame, place, refs }: { list: DrawList; frame: Frame; place: Place | null; refs: readonly string[] }) {
  const { min, max } = list.bounds;
  const pad = Math.max(max[0] - min[0], max[1] - min[1]) * 0.12 + 6;
  const view = `${min[0] - pad} ${min[1] - pad} ${max[0] - min[0] + pad * 2} ${max[1] - min[1] + pad * 2}`;
  const d = frame.drop;
  const outline = list.pieces.outline;
  const failing = new Set(refs);
  return (
    <svg className="insp-flat" viewBox={view} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Flat view of the cut file on the sheet">
      <rect x={min[0] - pad} y={min[1] - pad} width={max[0] - min[0] + pad * 2} height={max[1] - min[1] + pad * 2} fill="var(--surface-2)" />
      {list.stock && <rect x={0} y={0} width={list.stock.size[0]} height={list.stock.size[1]} fill="var(--panel)" opacity={outline ? 1 - d * 0.82 : 1} />}
      {outline && (
        <path
          d={[ring(outline), ...list.pieces.inner.map((p) => ring(p.points))].join(" ")}
          fillRule="evenodd"
          fill="var(--green-bg)"
          opacity={d}
        />
      )}
      {list.items.map((item, i) => {
        const p = frame.progress[i] ?? 0;
        if (p <= 0) return null;
        const shown = partial(item.points, p);
        const travel = item.stroke === "travel";
        if (travel && d >= 1) return null;
        return (
          <polyline
            key={`${item.id}-${i}`}
            points={pts(shown)}
            fill="none"
            stroke={failing.has(item.id) ? "var(--red)" : item.stroke === "cut" && d > 0.5 ? "var(--ink-2)" : STROKE_VAR[item.stroke]}
            strokeWidth={travel ? 1 : item.stroke === "engrave" ? 3 : 2}
            strokeDasharray={travel ? "3 4" : undefined}
            opacity={travel ? 0.5 * (1 - d) : 1}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {frame.head && frame.cutting && <circle cx={frame.head[0]} cy={frame.head[1]} r={2.2} fill="var(--em-300)" opacity={0.9} />}
      {frame.head && d < 1 && (
        <circle cx={frame.head[0]} cy={frame.head[1]} r={4} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      )}
      {place && (
        <circle cx={place.x} cy={place.y} r={place.radius + 2} fill="none" stroke="var(--red)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
});
