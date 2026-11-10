// The few parts of three.js the inspector uses, typed by hand so the web app takes three as its only new dependency.
declare module "three" {
  export const AdditiveBlending: number;
  export const DoubleSide: number;
  export const SRGBColorSpace: string;

  export class Color {
    constructor(value?: string | number);
    set(value: string | number | Color): this;
    lerpColors(a: Color, b: Color, t: number): this;
    copy(c: Color): this;
  }
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    clone(): Vector3;
    lerp(v: Vector3, t: number): this;
    distanceTo(v: Vector3): number;
  }
  export class Vector2 {
    constructor(x?: number, y?: number);
  }
  export class Object3D {
    position: Vector3;
    rotation: { x: number; y: number; z: number };
    scale: Vector3;
    visible: boolean;
    renderOrder: number;
    children: Object3D[];
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
    lookAt(x: number | Vector3, y?: number, z?: number): void;
    traverse(fn: (o: Object3D) => void): void;
  }
  export class Group extends Object3D {}
  export class Scene extends Object3D {
    background: Color | null;
  }
  export class Material {
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
    side: number;
    blending: number;
    polygonOffset: boolean;
    polygonOffsetFactor: number;
    polygonOffsetUnits: number;
    dispose(): void;
  }
  type MaterialParams = {
    color?: string | number | Color;
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
    side?: number;
    blending?: number;
    roughness?: number;
    metalness?: number;
    emissive?: string | number | Color;
    emissiveIntensity?: number;
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
  };
  export class MeshStandardMaterial extends Material {
    constructor(params?: MaterialParams);
    color: Color;
    emissive: Color;
    emissiveIntensity: number;
  }
  export class MeshBasicMaterial extends Material {
    constructor(params?: MaterialParams);
    color: Color;
  }
  export class LineBasicMaterial extends Material {
    constructor(params?: MaterialParams);
    color: Color;
  }
  export class BufferAttribute {}
  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this;
    setDrawRange(start: number, count: number): void;
    rotateX(angle: number): this;
    translate(x: number, y: number, z: number): this;
    dispose(): void;
  }
  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }
  export class Line extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }
  export class LineSegments extends Line {}
  export class Path {
    constructor(points?: Vector2[]);
  }
  export class Shape extends Path {
    constructor(points?: Vector2[]);
    holes: Path[];
  }
  export class ExtrudeGeometry extends BufferGeometry {
    constructor(shapes: Shape | Shape[], options?: { depth?: number; bevelEnabled?: boolean; curveSegments?: number });
  }
  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }
  export class CylinderGeometry extends BufferGeometry {
    constructor(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number);
  }
  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number);
  }
  export class RingGeometry extends BufferGeometry {
    constructor(innerRadius?: number, outerRadius?: number, thetaSegments?: number);
  }
  export class Light extends Object3D {
    intensity: number;
  }
  export class HemisphereLight extends Light {
    constructor(sky?: string | number, ground?: string | number, intensity?: number);
  }
  export class DirectionalLight extends Light {
    constructor(color?: string | number, intensity?: number);
  }
  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void;
    updateProjectionMatrix(): void;
  }
  export class WebGLRenderer {
    constructor(params?: { antialias?: boolean; alpha?: boolean; powerPreference?: string; canvas?: HTMLCanvasElement });
    domElement: HTMLCanvasElement;
    outputColorSpace: string;
    setPixelRatio(ratio: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setClearColor(color: Color | string, alpha?: number): void;
    render(scene: Scene, camera: PerspectiveCamera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
}
