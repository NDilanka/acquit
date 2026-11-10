import * as THREE from "three";
import type { Vec2 } from "./contract.ts";
import type { Palette } from "./palette.ts";
import type { DrawItem, DrawList, Place, Stroke } from "./scene-draw.ts";
import type { Frame } from "./timeline.ts";

export type StageInput = {
  readonly frame: Frame;
  /** The place the camera turns to, with the ids of the paths to colour as failing. */
  readonly focus: { readonly place: Place | null; readonly refs: readonly string[] } | null;
};

export type Stage = {
  update(input: StageInput): void;
  setPalette(palette: Palette): void;
  resetView(): void;
  dispose(): void;
};

// Pixel ratio is capped so a laptop on integrated graphics keeps a steady frame rate on a high-density screen.
const MAX_PIXEL_RATIO = 1.5;
const FOV = 38;
const HEAD_LIFT = 22;
const RIBBON_WIDTH: Readonly<Record<Stroke, number>> = { cut: 0.8, engrave: 1.4, travel: 0, copper: 1, drill: 1, route: 1, zone: 1, other: 0.8 };

type Ribbon = { item: DrawItem; mesh: THREE.Mesh | THREE.Line; segments: number; material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial };

type Orbit = { azimuth: number; polar: number; distance: number; target: THREE.Vector3 };

function ribbonGeometry(points: readonly Vec2[], width: number, y: number, map: (p: Vec2) => [number, number]): { geometry: THREE.BufferGeometry; segments: number } {
  const pos: number[] = [];
  let segments = 0;
  const h = width / 2;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = map(points[i - 1]!);
    const [bx, bz] = map(points[i]!);
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    // Each quad runs half a width past both ends, so corners close without a notch.
    const sx = ax - dx * h, sz = az - dz * h, ex = bx + dx * h, ez = bz + dz * h;
    const nx = -dz * h, nz = dx * h;
    pos.push(sx + nx, y, sz + nz, sx - nx, y, sz - nz, ex + nx, y, ez + nz);
    pos.push(ex + nx, y, ez + nz, sx - nx, y, sz - nz, ex - nx, y, ez - nz);
    segments++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return { geometry, segments };
}

function shapeOf(points: readonly Vec2[], map: (p: Vec2) => [number, number]): THREE.Shape {
  // The shape lies in x, -z so that rotating it onto the floor puts the drawing's y axis on world z.
  return new THREE.Shape(points.map((p) => { const [x, z] = map(p); return new THREE.Vector2(x, -z); }));
}

function extrude(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

export function createThreeStage(host: HTMLElement, list: DrawList, initial: Palette, options: { reducedMotion: boolean }): Stage {
  let palette = initial;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  const canvas = renderer.domElement;
  canvas.className = "insp-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 6000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f8c, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-120, 260, 160);
  scene.add(sun);

  const top = list.top;
  const stock = list.stock;
  const { min, max } = list.bounds;
  const sheetW = stock ? stock.size[0] : max[0] - min[0];
  const sheetH = stock ? stock.size[1] : max[1] - min[1];
  const sheetX = stock ? 0 : min[0];
  const sheetY = stock ? 0 : min[1];
  const cx = sheetX + sheetW / 2;
  const cy = sheetY + sheetH / 2;
  const map = (p: Vec2): [number, number] => [p[0] - cx, p[1] - cy];

  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => { owned.push(x); return x; };

  // The bed: a slab a little larger than the sheet, with slats.
  const margin = 24;
  const bedMat = keep(new THREE.MeshStandardMaterial({ color: palette.bed, roughness: 0.9, metalness: 0.05 }));
  const bed = new THREE.Mesh(keep(new THREE.BoxGeometry(sheetW + margin * 2, 6, sheetH + margin * 2)), bedMat);
  bed.position.set(0, -3.05, 0);
  scene.add(bed);
  const slatPos: number[] = [];
  for (let x = -sheetW / 2 - margin + 10; x < sheetW / 2 + margin; x += 10) slatPos.push(x, 0.01, -sheetH / 2 - margin, x, 0.01, sheetH / 2 + margin);
  const slatGeo = keep(new THREE.BufferGeometry());
  slatGeo.setAttribute("position", new THREE.Float32BufferAttribute(slatPos, 3));
  const slatMat = keep(new THREE.LineBasicMaterial({ color: palette.bedLine, transparent: true, opacity: 0.35 }));
  scene.add(new THREE.LineSegments(slatGeo, slatMat));

  // The sheet, split into the pieces the cut leaves: the skeleton around the part, the part, and the slugs inside it.
  const sheetMat = keep(new THREE.MeshStandardMaterial({ color: palette.sheet, roughness: 0.55, metalness: 0, transparent: true, opacity: 1 }));
  const partMat = keep(new THREE.MeshStandardMaterial({ color: palette.sheet, roughness: 0.5, metalness: 0, transparent: true, opacity: 1 }));
  const slugMat = keep(new THREE.MeshStandardMaterial({ color: palette.sheet, roughness: 0.55, metalness: 0, transparent: true, opacity: 1 }));
  const sheetColor = new THREE.Color(palette.sheet);
  const partColor = new THREE.Color(palette.part);
  const outline = list.pieces.outline;
  const outlineOnSheet = outline !== null && stock !== null && outline.every(([x, y]) => x >= 0 && y >= 0 && x <= stock.size[0] && y <= stock.size[1]);
  let slugs: THREE.Mesh[] = [];
  let skeleton: THREE.Mesh | null = null;
  if (stock || outline) {
    const rect: Vec2[] = [[sheetX, sheetY], [sheetX + sheetW, sheetY], [sheetX + sheetW, sheetY + sheetH], [sheetX, sheetY + sheetH]];
    const skeletonShape = shapeOf(rect, map);
    if (outline && outlineOnSheet) {
      skeletonShape.holes.push(shapeOf(outline, map));
      const partShape = shapeOf(outline, map);
      for (const inner of list.pieces.inner) partShape.holes.push(shapeOf(inner.points, map));
      scene.add(new THREE.Mesh(keep(extrude(partShape, top)), partMat));
      slugs = list.pieces.inner.map((inner) => {
        const m = new THREE.Mesh(keep(extrude(shapeOf(inner.points, map), top)), slugMat);
        scene.add(m);
        return m;
      });
    }
    skeleton = new THREE.Mesh(keep(extrude(skeletonShape, top)), sheetMat);
    scene.add(skeleton);
  }

  // One ribbon per drawn path; travel is a thin line.
  const ribbons: Ribbon[] = list.items.map((item, index) => {
    if (item.stroke === "travel") {
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(item.points.flatMap((p) => { const [x, z] = map(p); return [x, top + 0.2, z]; }), 3));
      const material = keep(new THREE.LineBasicMaterial({ color: palette.travel, transparent: true, opacity: 0.5, depthWrite: false }));
      const line = new THREE.Line(g, material);
      line.renderOrder = 2;
      scene.add(line);
      return { item, mesh: line, segments: Math.max(0, item.points.length - 1), material };
    }
    const width = item.width ?? RIBBON_WIDTH[item.stroke];
    const lift = item.stroke === "engrave" ? 0.12 : 0.08 + index * 0.0005;
    const { geometry, segments } = ribbonGeometry(item.points, width, item.z + lift, map);
    keep(geometry);
    const material = keep(new THREE.MeshBasicMaterial({ color: palette.cutHot, side: THREE.DoubleSide, transparent: true, opacity: 1, depthWrite: false }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 3;
    scene.add(mesh);
    return { item, mesh, segments, material };
  });

  // The head on its gantry, the beam and the glow where it meets the sheet.
  const headMat = keep(new THREE.MeshStandardMaterial({ color: palette.head, roughness: 0.4, metalness: 0.3 }));
  const gantry = new THREE.Mesh(keep(new THREE.BoxGeometry(sheetW + margin * 2, 5, 9)), headMat);
  scene.add(gantry);
  const head = new THREE.Group();
  const carriage = new THREE.Mesh(keep(new THREE.BoxGeometry(14, 10, 14)), headMat);
  carriage.position.set(0, HEAD_LIFT + 5, 0);
  const nozzle = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.2, 4.5, 7, 20)), headMat);
  nozzle.position.set(0, HEAD_LIFT - 3.5, 0);
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: palette.beam, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const beam = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.35, 0.35, HEAD_LIFT - 7, 8)), beamMat);
  beam.position.set(0, (HEAD_LIFT - 7) / 2, 0);
  const glow = new THREE.Mesh(keep(new THREE.SphereGeometry(2.4, 16, 12)), beamMat);
  head.add(carriage, nozzle, beam, glow);
  scene.add(head);

  // The marker: a ring on the part and a pin above it.
  const markerMat = keep(new THREE.MeshBasicMaterial({ color: palette.fail, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
  const ringGeo = keep(new THREE.RingGeometry(1, 1.12, 64));
  ringGeo.rotateX(-Math.PI / 2);
  const marker = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, markerMat);
  ring.renderOrder = 4;
  const pin = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.4, 0.4, 16, 8)), markerMat);
  const pinHead = new THREE.Mesh(keep(new THREE.SphereGeometry(1.8, 16, 12)), markerMat);
  marker.add(ring, pin, pinHead);
  marker.visible = false;
  scene.add(marker);

  // Camera: an orbit around a target, eased toward a wanted orbit.
  const partW = Math.max(20, max[0] - min[0]);
  const partH = Math.max(20, max[1] - min[1]);
  const [bcx, bcz] = map([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]);
  const homeOrbit = (): Orbit => {
    const aspect = camera.aspect || 1;
    const vHalf = (FOV * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const fit = Math.max((partW * 0.62) / Math.tan(hHalf), (partH * 0.8) / Math.tan(vHalf));
    return { azimuth: -0.42, polar: 0.92, distance: fit * 1.25 + 40, target: new THREE.Vector3(bcx, top, bcz + partH * 0.04) };
  };
  let want = homeOrbit();
  const now: Orbit = { ...want, target: want.target.clone() };
  let userMoved = false;
  let focusKey: string | null = null;
  let focusStartedAt = 0;
  let dirty = true;

  const applyCamera = () => {
    const { azimuth, polar, distance, target } = now;
    camera.position.set(
      target.x + distance * Math.sin(polar) * Math.sin(azimuth),
      target.y + distance * Math.cos(polar),
      target.z + distance * Math.sin(polar) * Math.cos(azimuth),
    );
    camera.lookAt(target);
  };

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved && focusKey === null) want = homeOrbit();
    if (options.reducedMotion || !userMoved) Object.assign(now, { ...want, target: now.target.copy(want.target) });
    dirty = true;
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  let visible = true;
  const intersection = new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); });
  intersection.observe(host);

  // Pointer and keyboard orbit. Touch drags only turn the view sideways so a vertical swipe still scrolls the page.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
  };
  const onMove = (e: PointerEvent) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0) zoom(pinch / d);
      pinch = d;
      return;
    }
    turn(dx * 0.008, e.pointerType === "touch" ? 0 : dy * 0.006);
  };
  const onUp = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch = 0; };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0012)); };
  const onKey = (e: KeyboardEvent) => {
    const step = 0.12;
    if (e.key === "ArrowLeft") turn(-step, 0);
    else if (e.key === "ArrowRight") turn(step, 0);
    else if (e.key === "ArrowUp") turn(0, -step);
    else if (e.key === "ArrowDown") turn(0, step);
    else if (e.key === "+" || e.key === "=") zoom(0.85);
    else if (e.key === "-" || e.key === "_") zoom(1 / 0.85);
    else if (e.key === "0" || e.key === "Home") resetView();
    else return;
    e.preventDefault();
  };
  function turn(da: number, dp: number) {
    userMoved = true;
    want.azimuth -= da;
    want.polar = Math.min(1.45, Math.max(0.12, want.polar + dp));
    now.azimuth = want.azimuth;
    now.polar = want.polar;
    dirty = true;
  }
  function zoom(factor: number) {
    userMoved = true;
    want.distance = Math.min(3000, Math.max(25, want.distance * factor));
    now.distance = want.distance;
    dirty = true;
  }
  function resetView() {
    userMoved = false;
    want = homeOrbit();
    if (focusKey !== null && lastFocus) want = focusOrbit(lastFocus);
    if (options.reducedMotion) Object.assign(now, { ...want, target: now.target.copy(want.target) });
    dirty = true;
  }
  host.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("keydown", onKey);

  let lastFocus: Place | null = null;
  const focusOrbit = (place: Place): Orbit => {
    const [x, z] = map([place.x, place.y]);
    const home = homeOrbit();
    return { azimuth: home.azimuth + 0.12, polar: 0.82, distance: Math.min(home.distance * 0.72, Math.max(90, place.radius * 9)), target: new THREE.Vector3(x, top, z) };
  };

  let last: StageInput | null = null;
  const paint = (input: StageInput, time: number) => {
    const { frame, focus } = input;
    const failing = new Set(focus?.refs ?? []);
    ribbons.forEach((r, i) => {
      const p = frame.progress[i] ?? 0;
      const count = Math.floor(p * r.segments + 1e-6);
      if (r.item.stroke === "travel") {
        r.mesh.geometry.setDrawRange(0, count > 0 ? count + 1 : 0);
        r.mesh.visible = count > 0 && frame.drop < 1;
        r.material.opacity = 0.5 * (1 - frame.drop);
        return;
      }
      r.mesh.geometry.setDrawRange(0, count * 6);
      const color = failing.has(r.item.id) ? palette.fail : r.item.stroke === "engrave" ? palette.engrave : r.item.stroke === "cut" ? null : palette.copper;
      if (color) r.material.color.set(color);
      else r.material.color.lerpColors(new THREE.Color(palette.cutHot), new THREE.Color(palette.cutCool), frame.drop);
    });
    // Head position and beam.
    const at = frame.head;
    if (at) {
      const [hx, hz] = map(at);
      head.position.set(hx, top, hz);
      gantry.position.set(0, top + HEAD_LIFT + 12, hz);
    }
    beam.visible = frame.cutting;
    glow.visible = frame.cutting;
    if (frame.cutting && !options.reducedMotion) glow.scale.set(1, 1, 1).lerp(new THREE.Vector3(1.25, 1.25, 1.25), 0.5 + 0.5 * Math.sin(time / 60));
    // After the cut: slugs fall through the bed, the skeleton fades, the part takes its finished colour.
    const d = frame.drop;
    for (const s of slugs) { s.position.set(0, -d * 14, 0); s.visible = d < 1; }
    slugMat.opacity = 1 - d;
    if (skeleton) sheetMat.opacity = outlineOnSheet ? 1 - d * 0.82 : 1;
    partMat.color.lerpColors(sheetColor, partColor, d);
    // Marker and camera.
    const place = focus?.place ?? null;
    const key = place ? `${place.x},${place.y},${place.radius}` : null;
    if (key !== focusKey) {
      focusKey = key;
      focusStartedAt = time;
      lastFocus = place;
      if (!userMoved) want = place ? focusOrbit(place) : homeOrbit();
      if (options.reducedMotion) Object.assign(now, { ...want, target: now.target.copy(want.target) });
    }
    marker.visible = place !== null;
    if (place) {
      const [mx, mz] = map([place.x, place.y]);
      marker.position.set(mx, top + 0.3, mz);
      const r = place.radius + 2;
      ring.scale.set(r, 1, r);
      pin.position.set(0, 8, 0);
      pinHead.position.set(0, 16, 0);
      const age = time - focusStartedAt;
      const pulse = options.reducedMotion || age > 4000 ? 1 : 1 + 0.18 * Math.max(0, Math.sin(age / 140)) * (1 - age / 4000);
      ring.scale.set(r * pulse, 1, r * pulse);
    }
  };

  let raf = 0;
  let prev = performance.now();
  const loop = (time: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (time - prev) / 1000);
    prev = time;
    const k = options.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.2);
    const moving =
      Math.abs(now.azimuth - want.azimuth) + Math.abs(now.polar - want.polar) > 1e-4 ||
      Math.abs(now.distance - want.distance) > 0.05 ||
      now.target.distanceTo(want.target) > 0.02;
    if (moving) {
      now.azimuth += (want.azimuth - now.azimuth) * k;
      now.polar += (want.polar - now.polar) * k;
      now.distance += (want.distance - now.distance) * k;
      now.target.lerp(want.target, k);
    }
    const pulsing = focusKey !== null && !options.reducedMotion && time - focusStartedAt < 4200;
    if (!visible || !(dirty || moving || pulsing || (last?.frame.cutting ?? false))) return;
    if (last) paint(last, time);
    applyCamera();
    renderer.render(scene, camera);
    dirty = false;
  };
  raf = requestAnimationFrame(loop);

  const applyPalette = () => {
    scene.background = new THREE.Color(palette.background);
    bedMat.color.set(palette.bed);
    slatMat.color.set(palette.bedLine);
    sheetMat.color.set(palette.sheet);
    slugMat.color.set(palette.sheet);
    sheetColor.set(palette.sheet);
    partColor.set(palette.part);
    headMat.color.set(palette.head);
    beamMat.color.set(palette.beam);
    markerMat.color.set(palette.fail);
    for (const r of ribbons) if (r.item.stroke === "travel") r.material.color.set(palette.travel);
    dirty = true;
  };
  applyPalette();

  return {
    update(input) {
      last = input;
      dirty = true;
    },
    setPalette(next) {
      palette = next;
      applyPalette();
    },
    resetView,
    dispose() {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      host.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("keydown", onKey);
      for (const o of owned) o.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
