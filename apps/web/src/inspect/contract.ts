// The shared Verdict and Scene shapes, typed loosely enough that every checker's verdict fits: a newer checker may add
// path kinds or a workflow name this viewer has not met, and the viewer still draws it with a default style.

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export type InspectFinding = {
  readonly rule: string;
  readonly ok: boolean;
  readonly hidden: boolean;
  readonly message: string;
  readonly at?: Vec3;
  readonly refs?: readonly string[];
};

export type InspectPath = {
  readonly id: string;
  readonly kind: string;
  readonly layer: string;
  readonly z: number;
  readonly width?: number;
  readonly closed: boolean;
  readonly net?: string;
  readonly order?: number;
  readonly points: readonly Vec2[];
};

export type InspectScene = {
  readonly units: "mm";
  readonly size: Vec3;
  readonly stock?: { readonly size: Vec3; readonly material: string };
  readonly paths: readonly InspectPath[];
};

export type InspectVerdict = {
  readonly workflow: string;
  readonly pass: boolean;
  readonly findings: readonly InspectFinding[];
  readonly measured: Readonly<Record<string, number | string>>;
  readonly scene: InspectScene;
};

/** One file a visitor can feed the checker. `run` calls the real checker on `text`. */
export type Delivery = {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly cheat: boolean;
  readonly fileName: string;
  readonly text: string;
  readonly run: () => InspectVerdict;
};
