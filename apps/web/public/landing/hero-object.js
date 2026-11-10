// Acquit landing v2: hero object (three candidates) + metallic emerald candy paint.
// Exports: PAINT_DEFAULTS, PAINT_MODES, DEFAULT_PAINT_MODE, MATCAP_URL, MATCAP_DEFAULTS, ENV_DEFAULTS,
//          OBJECT_NAMES, makeEmeraldPaint, makeMatcapPaint, loadMatcap, resolvePaintMode, makeStudioEnv,
//          makeBulbGeometry, createHeroScene, createBulbScene.
// Auto-mounts on #hero-object when that element exists (main page). paint-test.html imports this
// module without #hero-object, so nothing mounts there.
// Paint modes: 'matcap' (default) is a MeshMatcapMaterial lookup built from the reference photo
// (paint/matcap-emerald.png, see paint/build-matcap.py); 'pbr' is the physical candy paint below.
// Pick with ?paint=matcap|pbr, the pill next to the object switcher, or localStorage wf:paint.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const TARGET_RADIUS = 1.0;      // every object is normalised to this bounding radius
const MAX_TILT = 0.14;          // ~8 deg pointer parallax on fine pointers
const FOV = 26;
const CAMERA_Z = 6;
export const OBJECT_NAMES = ['tick', 'token', 'ring'];

// Sampled from refs/accent-emerald.png, shadow to glint (informational; used by the defaults below).
export const PAINT_SAMPLES = ['#034136', '#055144', '#035D51', '#006749', '#006B5B', '#017F59', '#0FA774', '#34E2A5', '#C0FFE8'];

// Paint: metallic candy. Near-total metal whose F0 is the deep emerald base, so every reflection
// carries the paint tint (the green highlights in the photo). Broad roughness gives the soft bands,
// the clear coat adds the sharp gloss, and the flake normal only shows where light hits it.
export const PAINT_DEFAULTS = {
  color: '#007A5C',            // metal F0: deep emerald base
  metalness: 0.92,             // reflections, not diffuse, carry the look
  roughness: 0.34,             // broad, soft bands and flake sheen (suggested 0.35-0.45, low end for band definition)
  specularColor: '#6CFFD2',    // dielectric share only (about 8 percent of the mix)
  specularIntensity: 1,
  clearcoat: 1,
  clearcoatRoughness: 0.07,    // soft enough that softbox edges do not read as hard rectangles
  flakeStrength: 0.07,         // normalScale of the flake normal map: glints only where the bands are bright
  flakeRepeat: 14,             // flake tiles per UV unit (about 1 px glints on screen)
  envIntensity: 1,
};

// Paint modes. The matcap is a sphere-normal lookup: texel (u, v) holds the colour the photo shows on a
// sphere whose normal points there (lower lobe, front lit, built by paint/build-matcap.py). It is unlit
// and not tone mapped, so the object shows the photo's own colours and V highlights.
export const PAINT_MODES = ['matcap', 'pbr'];
export const DEFAULT_PAINT_MODE = 'matcap';
export const MATCAP_URL = new URL('paint/matcap-emerald-hybrid3.png', import.meta.url).href;
export const MATCAP_DEFAULTS = { matcapFlake: 0 };   // flake normal strength on the matcap (0 = off)

// Studio environment: a mostly dark dome with three LARGE soft rectangular softboxes (key upper left,
// rim right, weak fill), an overhead wide bar that bends into the V highlights on the head, and a
// faint floor bounce. Values above 1 are HDR, so the softboxes stay bright after PMREM.
export const ENV_DEFAULTS = {
  tone: 'aces',                // tone mapping: 'agx' | 'aces' | 'neutral' (ACES kept the greens saturated)
  exposure: 1.2,               // tone-mapping exposure (ACES darkens the mids)
  top: '#0E4B3F',              // dome zenith
  mid: '#02100C',              // horizon: the turned-away sides reflect this, so it stays near black
  bottom: '#0F5A47',           // lower dome: green, so the lower body picks up saturated tone
  keyIntensity: 0.8,
  hemiIntensity: 0.12,
  strips: [
    { p: [-7, 2.5, 5], w: 3.2, h: 9, i: 7, c: '#E6FFF3' },      // key: tall softbox, upper left
    { p: [0, 8, 3], w: 6, h: 1.6, i: 8, c: '#D6FFEE' },         // overhead bar, narrower and brighter (V highlights in the head dish)
    { p: [-6, 0, 7], w: 3, h: 12, i: 5, c: '#2FD29A' },         // broad emerald wall, front left: wraps the left lobe
    { p: [6, 0, 7], w: 3, h: 12, i: 3.5, c: '#1FC48E' },        // broad emerald wall, front right
    { p: [6, 2, -1], w: 2, h: 9, i: 1.8, c: '#8DFFD5' },        // rim, right (kept forward so the right edge stays deep)
    { p: [4, -1, 8], w: 6, h: 5, i: 0.25, c: '#A8FFD9' },       // weak fill, front right (large, soft)
    { p: [0, -6, 3], w: 14, h: 6, i: 0.9, c: '#2BC08E' },       // floor bounce: a bright green ground under the body
  ],
};

// Tone mapping choices (env.tone). AgX keeps saturated green from clipping to white.
const TONE_MAP = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping };

// ---------- flake normal map (procedural, shared canvas) ----------
let flakeCanvas = null;
function getFlakeCanvas() {
  if (flakeCanvas) return flakeCanvas;
  // Flake: about 2,200 tilted facets, each about 1 px on screen at flakeRepeat 14. Facets much smaller
  // than a pixel mip-average into a grey speckle.
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(128,128,255)';
  g.fillRect(0, 0, size, size);
  let seed = 90210;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 2200; i++) {
    const x = rnd() * size, y = rnd() * size, r = 8 + rnd() * 12;
    const R = 128 + (rnd() * 2 - 1) * 120, G = 128 + (rnd() * 2 - 1) * 120, B = 150 + rnd() * 105;
    g.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      g.beginPath(); g.arc(x + dx, y + dy, r, 0, TAU); g.fill();
    }
  }
  flakeCanvas = c;
  return c;
}

export function makeEmeraldPaint(overrides = {}) {
  const p = { ...PAINT_DEFAULTS, ...overrides };
  const flake = new THREE.CanvasTexture(getFlakeCanvas());
  flake.wrapS = flake.wrapT = THREE.RepeatWrapping;
  flake.repeat.set(p.flakeRepeat, p.flakeRepeat);
  flake.anisotropy = 8;
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.color),
    metalness: p.metalness,
    roughness: p.roughness,
    specularColor: new THREE.Color(p.specularColor),
    specularIntensity: p.specularIntensity,
    clearcoat: p.clearcoat,
    clearcoatRoughness: p.clearcoatRoughness,
    normalMap: flake,
    normalScale: new THREE.Vector2(p.flakeStrength, p.flakeStrength),
    envMapIntensity: p.envIntensity,
  });
  m.userData.paint = p;
  return m;
}

// ---------- matcap paint (the reference photo as a sphere-normal lookup) ----------
// The texture is sRGB, so three.js decodes it and the output matches the photo's pixels. toneMapped is
// off: ACES would desaturate the greens the matcap is meant to carry.
const matcapCache = new Map();
export function loadMatcap(url = MATCAP_URL) {
  if (!matcapCache.has(url)) {
    matcapCache.set(url, new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          resolve(tex);
        },
        undefined,
        () => resolve(null), // missing texture: scenes stay on PBR
      );
    }));
  }
  return matcapCache.get(url);
}

export function makeMatcapPaint(tex, overrides = {}, { flake = true } = {}) {
  const p = { ...PAINT_DEFAULTS, ...MATCAP_DEFAULTS, ...overrides };
  const m = new THREE.MeshMatcapMaterial({ matcap: tex, color: 0xffffff, toneMapped: false });
  if (flake && p.matcapFlake > 0) {
    const f = new THREE.CanvasTexture(getFlakeCanvas());
    f.wrapS = f.wrapT = THREE.RepeatWrapping;
    f.repeat.set(p.flakeRepeat, p.flakeRepeat);
    f.anisotropy = 8;
    m.normalMap = f;
    m.normalScale = new THREE.Vector2(p.matcapFlake, p.matcapFlake);
  }
  m.userData.paint = p;
  return m;
}

// Paint mode resolution: explicit option, then ?paint=, then localStorage wf:paint, then the default.
export function resolvePaintMode(explicit) {
  if (PAINT_MODES.includes(explicit)) return explicit;
  let fromUrl = null, stored = null;
  try { fromUrl = new URLSearchParams(window.location.search).get('paint'); } catch (err) { /* no location */ }
  if (PAINT_MODES.includes(fromUrl)) return fromUrl;
  try { stored = window.localStorage.getItem('wf:paint'); } catch (err) { /* storage blocked */ }
  return PAINT_MODES.includes(stored) ? stored : DEFAULT_PAINT_MODE;
}

// Both looks for one scene. Meshes carry userData.paintKey ('main' or 'coin') and take the material for
// the active mode, so the mode flips without rebuilding geometry. Matcap materials exist only after the
// texture has loaded (attach); until then get() returns PBR.
function makePaintBank(overrides = {}, mode = DEFAULT_PAINT_MODE) {
  const pbrMain = makeEmeraldPaint(overrides);
  const pbrCoin = pbrMain.clone();
  pbrCoin.normalMap = null;                           // coin: no flake (lathe UVs pinch to the pole)
  const bank = {
    mode,
    pbr: { main: pbrMain, coin: pbrCoin },
    matcap: null,
    attach(tex) {
      if (!tex || bank.matcap) return;
      bank.matcap = {
        main: makeMatcapPaint(tex, overrides, { flake: true }),
        coin: makeMatcapPaint(tex, overrides, { flake: false }),
      };
    },
    get(key) {
      return bank.mode === 'matcap' && bank.matcap ? bank.matcap[key] : bank.pbr[key];
    },
    dispose() {
      for (const set of [bank.pbr, bank.matcap]) if (set) for (const k in set) set[k].dispose();
    },
  };
  return bank;
}

// Mesh with a paint key, so setPaint can swap its material later.
function paintMesh(geo, bank, key) {
  const m = new THREE.Mesh(geo, bank.get(key));
  m.userData.paintKey = key;
  return m;
}

// ---------- studio environment (PMREM from a small custom scene) ----------
export function makeStudioEnv(renderer, overrides = {}) {
  const cfg = { ...ENV_DEFAULTS, ...overrides };
  const s = new THREE.Scene();
  // dark dome, vertex-coloured: top emerald, horizon deep green, floor near black
  const dome = new THREE.SphereGeometry(50, 48, 24);
  const pos = dome.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  const top = new THREE.Color(cfg.top), mid = new THREE.Color(cfg.mid), bot = new THREE.Color(cfg.bottom), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    if (y >= 0) c.copy(mid).lerp(top, Math.pow(y, 0.7));
    else c.copy(mid).lerp(bot, Math.pow(-y, 0.5));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  dome.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  s.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // strip softboxes (HDR values > 1 survive the half-float PMREM target)
  for (const st of cfg.strips) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(st.w, st.h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(st.c).multiplyScalar(st.i), side: THREE.DoubleSide }),
    );
    m.position.set(st.p[0], st.p[1], st.p[2]);
    m.lookAt(0, 0, 0);
    s.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(s, 0, 0.1, 100, { size: 512 });
  pmrem.dispose();
  dome.dispose();
  return rt.texture;
}

// ---------- geometry helpers ----------
// Outline of a polyline stroked with a given full width, round caps, mitred joints.
function strokeOutline(pts, width, seg) {
  const h = width / 2, n = pts.length;
  const dirs = [], nrms = [];
  for (let i = 0; i < n - 1; i++) {
    const d = new THREE.Vector2().subVectors(pts[i + 1], pts[i]).normalize();
    dirs.push(d);
    nrms.push(new THREE.Vector2(-d.y, d.x));
  }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Vector2();
    if (i === 0) m.copy(nrms[0]);
    else if (i === n - 1) m.copy(nrms[n - 2]);
    else {
      m.addVectors(nrms[i - 1], nrms[i]).normalize();
      m.multiplyScalar(1 / Math.max(m.dot(nrms[i - 1]), 0.5));
    }
    L.push(pts[i].clone().addScaledVector(m, h));
    R.push(pts[i].clone().addScaledVector(m, -h));
  }
  const out = [...L];
  const nE = nrms[n - 2], dE = dirs[n - 2], pE = pts[n - 1];
  for (let k = 1; k < seg; k++) {
    const t = (k / seg) * Math.PI;
    out.push(pE.clone().addScaledVector(nE, h * Math.cos(t)).addScaledVector(dE, h * Math.sin(t)));
  }
  for (let i = n - 1; i >= 0; i--) out.push(R[i]);
  const nS = nrms[0], dS = dirs[0], pS = pts[0];
  for (let k = 1; k < seg; k++) {
    const t = (k / seg) * Math.PI;
    out.push(pS.clone().addScaledVector(nS, -h * Math.cos(t)).addScaledVector(dS, -h * Math.sin(t)));
  }
  return out;
}

// The Acquit check tick: centre-line points (unit scale).
// Short arm 45 degrees, long arm about 49 degrees, long to short about 2:1: reads as a check at a glance.
const TICK_PTS = [new THREE.Vector2(-0.7, 0.0), new THREE.Vector2(-0.22, -0.48), new THREE.Vector2(0.74, 0.62)];

// Extruded, rounded-bevel check. width = stroke width of the flat face, bevel = rounding size.
function tickGeometry({ scale = 1, width = 0.28, bevel = 0.14, depth = 0.1, seg = 14 } = {}) {
  const pts = TICK_PTS.map((p) => p.clone().multiplyScalar(scale));
  const shape = new THREE.Shape(strokeOutline(pts, width, seg));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: 0,
    bevelSegments: 12, curveSegments: seg,
  });
  geo.center();
  geo.computeBoundingBox();
  return geo;
}

// Coin profile for LatheGeometry: bottom centre -> rim -> top centre (gives outward normals).
function coinProfile(R, H, r, seg) {
  const pts = [new THREE.Vector2(0, -H), new THREE.Vector2(R - r, -H)];
  for (let i = 1; i <= seg; i++) {
    const a = -Math.PI / 2 + (i / seg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - r + r * Math.cos(a), -H + r + r * Math.sin(a)));
  }
  for (let i = 1; i <= seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - r + r * Math.cos(a), H - r + r * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(0, H));
  return pts;
}

// Escrow token back/front relief: a raised shape sitting on a coin face.
function embossMesh(geo, bank, key, H, protrude) {
  geo.computeBoundingBox();
  const m = paintMesh(geo, bank, key);
  m.position.z = H + protrude - geo.boundingBox.max.z;
  return m;
}

// Speed-shape bulb profile traced from the photo: a two-lobed rounded top (shallow centre dish, so the
// silhouette notches at the middle and the dish reflects the overhead bar as V highlights), the widest
// head near 20 percent down, a pinched waist near 45 percent, the widest base near 68 percent, then a
// rounded tip. Points are [radius, height] with height +1 at the top; the lathe closes on the axis.
export function makeBulbGeometry(segments = 160) {
  const ctrl = [
    [0.0, 0.93], [0.12, 0.955], [0.22, 0.966], [0.32, 0.94], [0.4, 0.87], [0.47, 0.76], [0.52, 0.63],
    [0.548, 0.52], [0.54, 0.36], [0.48, 0.2], [0.44, 0.08], [0.46, -0.04], [0.5, -0.16], [0.54, -0.26],
    [0.555, -0.34], [0.545, -0.46], [0.5, -0.6], [0.42, -0.72], [0.3, -0.85], [0.18, -0.94], [0.08, -0.985], [0.0, -1.0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  // SplineCurve runs bottom to top from (0,-1) to (0,1), which gives outward lathe normals.
  const pts = new THREE.SplineCurve(ctrl.slice().reverse()).getPoints(segments).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  return new THREE.LatheGeometry(pts, 160);
}

function fitMesh(mesh, target) {
  mesh.geometry.computeBoundingSphere();
  const r = mesh.geometry.boundingSphere.radius || 1;
  mesh.scale.setScalar(target / r);
  return mesh;
}

const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- objects ----------
// Tick: a bold rounded check mark held at a three-quarter angle. It sways +/-25 degrees around that
// angle, so it never spins into an edge-on sliver.
const TICK_BASE = 0.5;       // radians (about 29 degrees off face-on)
const TICK_SWAY = 0.436;     // +/-25 degrees
const TICK_PERIOD = 9;       // seconds per sway
function buildTick(bank) {
  const root = new THREE.Group();
  root.add(fitMesh(paintMesh(tickGeometry({ width: 0.3, bevel: 0.1, depth: 0.12 }), bank, 'main'), TARGET_RADIUS));
  return {
    root,
    update(dt, t, reduce) {
      root.rotation.x = reduce ? 0.12 : 0.12 + Math.sin(t * 0.5) * 0.04;
      root.rotation.y = reduce ? TICK_BASE : TICK_BASE + Math.sin((t * TAU) / TICK_PERIOD) * TICK_SWAY;
    },
  };
}

function buildToken(bank) {
  // The coin uses the paint without the flake normal (the bank's 'coin' key): on a lathe cap the flake
  // UVs pinch to the pole and read as fur.
  const root = new THREE.Group();
  const flip = new THREE.Group();
  root.add(flip);
  const H = 0.25;              // thicker coin (0.5 overall) with a fully rounded rim
  const coinGeo = new THREE.LatheGeometry(coinProfile(1, H, 0.2, 24), 180);
  coinGeo.rotateX(Math.PI / 2); // lathe axis Y -> Z so faces point along Z
  flip.add(paintMesh(coinGeo, bank, 'coin'));
  // front face: embossed check
  const checkGeo = tickGeometry({ scale: 0.44, width: 0.2, bevel: 0.05, depth: 0.03, seg: 12 });
  checkGeo.rotateZ(Math.PI); // turn the emboss upright so it reads as a tick on the coin face
  flip.add(embossMesh(checkGeo, bank, 'coin', H, 0.035));
  // back face: embossed ring with a centre dot, reached by the flip
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, 0, 0.5, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.41, 0, TAU, true);
  ringShape.holes.push(hole);
  const ringGeo = new THREE.ExtrudeGeometry(ringShape, {
    depth: 0.012, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelOffset: 0, bevelSegments: 6, curveSegments: 72,
  });
  ringGeo.center();
  const dotShape = new THREE.Shape();
  dotShape.absarc(0, 0, 0.14, 0, TAU, false);
  const dotGeo = new THREE.ExtrudeGeometry(dotShape, {
    depth: 0.012, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelOffset: 0, bevelSegments: 6, curveSegments: 48,
  });
  dotGeo.center();
  const back = new THREE.Group();
  back.rotation.y = Math.PI;
  back.add(embossMesh(ringGeo, bank, 'coin', H, 0.025), embossMesh(dotGeo, bank, 'coin', H, 0.025));
  flip.add(back);
  root.rotation.x = 0.18;
  flip.scale.setScalar(0.96);

  let flipFrom = 0, flipTo = 0, flipStart = -1, nextFlip = 7;
  return {
    root,
    update(dt, t, reduce) {
      root.rotation.y = reduce ? 0.55 : (t * TAU) / 18;
      if (reduce) { flip.rotation.x = 0; return; }
      if (flipStart < 0 && t >= nextFlip) {
        flipFrom = flip.rotation.x;
        flipTo = flipFrom + Math.PI;
        flipStart = t;
        nextFlip = t + 12;
      }
      if (flipStart >= 0) {
        const p = Math.min(1, (t - flipStart) / 1.2);
        flip.rotation.x = flipFrom + (flipTo - flipFrom) * easeInOutCubic(p);
        if (p >= 1) flipStart = -1;
      }
    },
  };
}

// Smooth twisted band (the Optikka ring): a flattened ellipse swept around a ring, turning `twists`
// times per loop. Integer twists close exactly, so the index wrap is seamless.
function twistedRingGeometry({ R = 1, a = 0.36, b = 0.2, twists = 1, segU = 280, segV = 40 } = {}) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < segU; i++) {
    const th = (i / segU) * TAU;
    const cx = Math.cos(th), sx = Math.sin(th);
    const phi = twists * th, cp = Math.cos(phi), sp = Math.sin(phi);
    // u runs across the band and turns with the twist; v runs through the band thickness.
    const ux = cp * cx, uy = cp * sx, uz = sp;
    const vx = -sp * cx, vy = -sp * sx, vz = cp;
    for (let j = 0; j < segV; j++) {
      const s = (j / segV) * TAU;
      const ca = a * Math.cos(s), sb = b * Math.sin(s);
      pos.push(R * cx + ca * ux + sb * vx, R * sx + ca * uy + sb * vy, ca * uz + sb * vz);
      uv.push(i / segU, j / segV);
    }
  }
  for (let i = 0; i < segU; i++) {
    const i1 = (i + 1) % segU;
    for (let j = 0; j < segV; j++) {
      const j1 = (j + 1) % segV;
      const p00 = i * segV + j, p10 = i1 * segV + j, p11 = i1 * segV + j1, p01 = i * segV + j1;
      idx.push(p00, p10, p01, p10, p11, p01);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildRing(bank) {
  const root = new THREE.Group();
  root.add(fitMesh(paintMesh(twistedRingGeometry({ R: 1, a: 0.36, b: 0.2, twists: 1 }), bank, 'main'), TARGET_RADIUS));
  return {
    root,
    update(dt, t, reduce) {
      root.rotation.x = 0.3;
      root.rotation.y = reduce ? 0.7 : (t * TAU) / 16;
    },
  };
}

const BUILDERS = { tick: buildTick, token: buildToken, ring: buildRing };

// ---------- stage: renderer, camera, lights, loop, visibility rules ----------
function createStage(host, opts) {
  const { env = {}, animate = true, update = null, onFirstFrame = null, exposure = 1.0, gate = null } = opts;
  // gate: promise that opens rendering (the matcap texture and its materials). Until then the CSS
  // fallback stays visible and no frame is drawn, so the paint never flashes in the wrong look.
  let gateOpen = !gate;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    return null; // no WebGL: leave the fallback alone
  }
  const canvas = renderer.domElement;
  canvas.className = 'wf-ho-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1;pointer-events:none';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = TONE_MAP[env.tone] ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = env.exposure ?? exposure;
  renderer.setClearColor(0x000000, 0);
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.environment = makeStudioEnv(renderer, env);
  const key = new THREE.DirectionalLight(0xe9fff6, env.keyIntensity ?? ENV_DEFAULTS.keyIntensity);
  key.position.set(-4, 5, 6);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xbfffe6, 0x022019, env.hemiIntensity ?? ENV_DEFAULTS.hemiIntensity));

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);
  const tilt = new THREE.Group();
  scene.add(tilt);

  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const state = {
    w: 0, h: 0, dpr: 0, running: false, raf: 0, last: 0, clock: 0,
    visible: true, eventPaused: false, reduce: reduceMq.matches, first: true, disposed: false,
    px: 0, py: 0, yaw: 0, pitch: 0, rawDpr: 0,
  };

  const size = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    const rawDpr = window.devicePixelRatio || 1;
    const dpr = Math.min(rawDpr, 2);
    state.rawDpr = rawDpr;
    if (w !== state.w || h !== state.h || dpr !== state.dpr) {
      state.w = w; state.h = h; state.dpr = dpr;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      const aspect = w / h;
      camera.aspect = aspect;
      // keep the object's horizontal extent on narrow boxes
      camera.fov = aspect >= 1 ? FOV : (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / aspect) * 180) / Math.PI;
      camera.updateProjectionMatrix();
    }
    return true;
  };

  const firstFrame = () => {
    if (!state.first) return;
    state.first = false;
    host.classList.remove('ho-fallback');
    if (onFirstFrame) onFirstFrame();
  };

  const fail = () => {
    state.disposed = true;
    cancelAnimationFrame(state.raf);
    canvas.remove();
  };

  const shouldRun = () =>
    gateOpen && animate && !state.reduce && state.visible && !document.hidden && !state.eventPaused && !window.WF?.paused && !state.disposed;

  // eased pointer parallax: horizontal pointer -> yaw, vertical pointer -> pitch (max ~8 deg)
  const tickPointer = (dt) => {
    const live = finePointer && !state.reduce;
    const yawTarget = live ? state.px * MAX_TILT : 0;
    const pitchTarget = live ? state.py * MAX_TILT : 0;
    const k = 1 - Math.exp(-dt * 4);
    state.yaw += (yawTarget - state.yaw) * k;
    state.pitch += (pitchTarget - state.pitch) * k;
    tilt.rotation.y = state.yaw;
    tilt.rotation.x = state.pitch;
  };

  const frame = (now) => {
    state.raf = 0;
    if (state.disposed) return;
    if (!shouldRun()) { state.running = false; return; }
    const dt = clamp((now - state.last) / 1000, 0, 0.05);
    state.last = now;
    state.clock += dt;
    if ((window.devicePixelRatio || 1) !== state.rawDpr) size();
    tickPointer(dt);
    try {
      if (update) update(dt, state.clock, state.reduce);
      renderer.render(scene, camera);
    } catch (err) { fail(); return; }
    firstFrame();
    state.raf = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (state.running || !shouldRun()) return;
    state.running = true;
    state.last = performance.now();
    state.raf = requestAnimationFrame(frame);
  };

  const renderOnce = () => {
    if (state.disposed || !gateOpen || !size()) return;
    try {
      if (update) update(0, state.clock, state.reduce);
      renderer.render(scene, camera);
    } catch (err) { fail(); return; }
    firstFrame();
  };

  const io = new IntersectionObserver((entries) => {
    state.visible = entries[entries.length - 1].isIntersecting;
    if (state.visible) kick();
  }, { rootMargin: '120px' });
  io.observe(host);

  const ro = new ResizeObserver(() => {
    if (!size()) return;
    if (!state.running) renderOnce();
  });
  ro.observe(host);

  const onPause = () => { state.eventPaused = true; };
  const onPlay = () => { state.eventPaused = false; kick(); };
  const onVis = () => { if (!document.hidden) kick(); };
  const onPointer = (e) => {
    const r = host.getBoundingClientRect();
    if (!r.width) return;
    state.px = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 1.5), -1, 1);
    state.py = clamp((e.clientY - (r.top + r.height / 2)) / (r.height * 1.5), -1, 1);
  };
  const onReduce = (e) => {
    state.reduce = e.matches;
    if (state.reduce) { cancelAnimationFrame(state.raf); state.running = false; }
    else kick();
    renderOnce();
  };
  document.addEventListener('wf:pause', onPause);
  document.addEventListener('wf:play', onPlay);
  document.addEventListener('visibilitychange', onVis);
  if (finePointer) window.addEventListener('pointermove', onPointer, { passive: true });
  reduceMq.addEventListener('change', onReduce);
  const poll = setInterval(kick, 500); // catches window.WF.paused flips that carry no event
  if (gate) {
    gate.then(() => {
      gateOpen = true;
      if (state.disposed) return;
      renderOnce();
      kick();
    });
  }

  const dispose = () => {
    state.disposed = true;
    cancelAnimationFrame(state.raf);
    clearInterval(poll);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('wf:pause', onPause);
    document.removeEventListener('wf:play', onPlay);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pointermove', onPointer);
    reduceMq.removeEventListener('change', onReduce);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };

  return { renderer, scene, camera, tilt, canvas, state, kick, renderOnce, dispose };
}

function addContactShadow(host, canvas) {
  const el = document.createElement('div');
  el.className = 'ho-shadow';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:absolute', 'left:24%', 'right:24%', 'bottom:6%', 'height:9%', 'border-radius:50%',
    'pointer-events:none', 'z-index:0',
    'background:radial-gradient(closest-side,rgba(3,41,33,.30),rgba(3,41,33,.10) 60%,rgba(3,41,33,0))',
    'filter:blur(4px)',
  ].join(';');
  host.insertBefore(el, canvas);
  return el;
}

// Main hero: one object at a time (tick | token | ring).
// Swap every paintable mesh under root to the active mode's material.
function applyPaint(bank, root) {
  root.traverse((o) => { if (o.isMesh && o.userData.paintKey) o.material = bank.get(o.userData.paintKey); });
}

export function createHeroScene(host, opts = {}) {
  const names = (opts.names || OBJECT_NAMES).filter((n) => OBJECT_NAMES.includes(n));
  let current = names.includes(opts.initial) ? opts.initial : names[0];
  const bank = makePaintBank(opts.paint, resolvePaintMode(opts.mode));
  const rigs = {};
  // The first frame waits for the matcap texture, so the paint never flashes in the wrong look.
  const ready = loadMatcap(opts.matcapUrl || MATCAP_URL).then((tex) => { bank.attach(tex); });
  const stage = createStage(host, {
    env: opts.env,
    exposure: opts.exposure,
    animate: true,
    onFirstFrame: opts.onFirstFrame,
    gate: ready.then(() => applyPaint(bank, stage.tilt)),
    update: (dt, t, reduce) => { const r = rigs[current]; if (r) r.update(dt, t, reduce); },
  });
  if (!stage) return null;
  for (const n of names) {
    const rig = BUILDERS[n](bank);
    rig.root.visible = n === current;
    stage.tilt.add(rig.root);
    rigs[n] = rig;
  }
  // Optikka's ring floats with no contact shadow; opts.shadow brings it back.
  const shadow = opts.shadow ? addContactShadow(host, stage.canvas) : null;
  stage.renderOnce();   // gated until the matcap texture is attached
  return {
    names,
    get current() { return current; },
    get paint() { return bank.mode; },   // requested mode (the matcap may still be loading)
    set(name) {
      if (!names.includes(name) || name === current) return;
      rigs[current].root.visible = false;
      current = name;
      rigs[current].root.visible = true;
      if (opts.onChange) opts.onChange(current);
      if (!stage.state.running) stage.renderOnce();
    },
    setPaint(mode) {
      if (!PAINT_MODES.includes(mode) || mode === bank.mode) return;
      bank.mode = mode;
      applyPaint(bank, stage.tilt);
      if (!stage.state.running) stage.renderOnce();
    },
    dispose() { stage.dispose(); bank.dispose(); if (shadow) shadow.remove(); },
  };
}

// Paint test: the paint on the photo-like bulb, static. opts.mode picks 'matcap' or 'pbr'.
export function createBulbScene(host, opts = {}) {
  const bank = makePaintBank(opts.paint, resolvePaintMode(opts.mode));
  const ready = loadMatcap(opts.matcapUrl || MATCAP_URL).then((tex) => { bank.attach(tex); });
  const stage = createStage(host, {
    env: opts.env,
    exposure: opts.exposure,
    animate: false,
    update: null,
    gate: ready.then(() => applyPaint(bank, stage.tilt)),
  });
  if (!stage) return null;
  const bulb = fitMesh(paintMesh(makeBulbGeometry(), bank, 'main'), opts.bulbRadius ?? 1.2);
  bulb.rotation.y = opts.spin ?? 0;
  bulb.rotation.x = opts.tilt ?? 0.12;  // photo: the head leans slightly toward the camera
  stage.tilt.add(bulb);
  stage.renderOnce();   // gated until the matcap texture is attached
  return {
    bank,
    bulb,
    stage,
    get paint() { return bank.mode; },
    setPaint(mode) {
      if (!PAINT_MODES.includes(mode) || mode === bank.mode) return;
      bank.mode = mode;
      applyPaint(bank, stage.tilt);
      if (!stage.state.running) stage.renderOnce();
    },
  };
}

// ---------- main page: mount + switcher ----------
function injectSwitcherStyle() {
  if (document.getElementById('wf-ho-style')) return;
  const s = document.createElement('style');
  s.id = 'wf-ho-style';
  s.textContent = [
    '.wf-ho-dock{position:absolute;left:16px;bottom:16px;z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.wf-ho-switch{position:relative;display:inline-flex;align-items:center;gap:4px;height:44px;padding:0 14px;border-radius:999px;background:rgba(255,255,255,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 1px 2px rgba(14,17,16,.06),0 8px 24px rgba(14,17,16,.06);font:500 11px/1 "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;color:#5F6662}',
    '.wf-ho-switch .wf-ho-sep{opacity:.45;padding:0 2px}',
    '.wf-ho-switch button{appearance:none;border:0;background:none;height:44px;padding:0 4px;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;cursor:pointer;border-radius:999px}',
    '.wf-ho-switch button[aria-pressed="true"]{color:#0E1110;font-weight:600}',
    '.wf-ho-switch button:focus-visible{outline:2px solid #00674A;outline-offset:2px}',
  ].join('\n');
  document.head.appendChild(s);
}

// Pill of buttons. opts: label text, aria label, tooltip, and display names per value.
function buildSwitcher(parent, names, active, onPick, opts = {}) {
  injectSwitcherStyle();
  const { label: labelText = 'Object:', aria = 'Hero object', title = 'Keys 1 2 3', labels = {} } = opts;
  const bar = document.createElement('div');
  bar.className = 'wf-ho-switch';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', aria);
  bar.title = title;
  const label = document.createElement('span');
  label.textContent = labelText;
  bar.appendChild(label);
  const buttons = {};
  names.forEach((n, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'wf-ho-sep';
      sep.textContent = '·';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = labels[n] || n[0].toUpperCase() + n.slice(1);
    b.dataset.value = n;
    b.dataset.obj = n;
    b.setAttribute('aria-pressed', n === active ? 'true' : 'false');
    b.addEventListener('click', () => onPick(n));
    bar.appendChild(b);
    buttons[n] = b;
  });
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(bar);
  return {
    el: bar,
    sync(name) { for (const n of names) buttons[n].setAttribute('aria-pressed', n === name ? 'true' : 'false'); },
  };
}

function mountHome() {
  const host = document.getElementById('hero-object');
  if (!host) return;
  const q = new URLSearchParams(window.location.search);
  let stored = null;
  try { stored = window.localStorage.getItem('wf:obj'); } catch (err) { /* storage blocked */ }
  const initial = [q.get('obj'), stored].find((n) => OBJECT_NAMES.includes(n)) || 'tick';
  let bar = null;
  let paintBar = null;
  const scene = createHeroScene(host, {
    initial,
    onChange: (name) => { if (bar) bar.sync(name); },
  });
  if (!scene) return; // no WebGL: fallback stays
  const hero = host.closest('#hero') || host.closest('section') || host.parentElement;
  const pick = (name) => {
    scene.set(name);
    try { window.localStorage.setItem('wf:obj', name); } catch (err) { /* storage blocked */ }
  };
  const pickPaint = (mode) => {
    scene.setPaint(mode);
    try { window.localStorage.setItem('wf:paint', mode); } catch (err) { /* storage blocked */ }
    if (paintBar) paintBar.sync(scene.paint);
  };
  // One dock bottom-left: the object pill, then the paint pill beside it.
  const dock = document.createElement('div');
  dock.className = 'wf-ho-dock';
  if (getComputedStyle(hero).position === 'static') hero.style.position = 'relative';
  hero.appendChild(dock);
  bar = buildSwitcher(dock, OBJECT_NAMES, scene.current, pick);
  paintBar = buildSwitcher(dock, PAINT_MODES, scene.paint, pickPaint, {
    label: 'Paint:',
    aria: 'Paint mode',
    title: '?paint=matcap|pbr',
    labels: { matcap: 'Matcap', pbr: 'PBR' },
  });
  window.__heroObj = {
    set: (name) => pick(name),
    get current() { return scene.current; },
  };
  window.__heroPaint = {
    set: (mode) => pickPaint(mode),
    get current() { return scene.paint; },
  };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const i = ['1', '2', '3'].indexOf(e.key);
    if (i >= 0 && i < OBJECT_NAMES.length) pick(OBJECT_NAMES[i]);
  });
}

mountHome();
