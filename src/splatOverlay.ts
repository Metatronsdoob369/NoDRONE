/**
 * Transparent Three.js WebGPU / WebGL2 Gaussian Splat Overlay for NoDRONE.
 *
 * - Stacked directly on top of `#cesium-container` (`pointer-events: none`)
 * - Tracks Cesium's camera every frame in a local East-North-Up (ENU) frame
 *   centered on the active survey's Geo-Box / splat anchor to avoid float jitter
 * - Ports ONLY splat loaders (SPZ / SPLAT / KSPLAT / PLY), downsampling, and
 *   bounds computation from -splatthat (services/assetLoaderService.ts)
 */

import * as THREE from 'three/webgpu';
import { GaussianSplat } from 'three/examples/jsm/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from 'three/examples/jsm/utils/GaussianSplatUtils.js';
import { SPZLoader } from 'three/examples/jsm/loaders/SPZLoader.js';
import { SPLATLoader } from 'three/examples/jsm/loaders/SPLATLoader.js';
import { KSPLATLoader } from 'three/examples/jsm/loaders/KSPLATLoader.js';
import { GaussianSplatPLYLoader } from 'three/examples/jsm/loaders/GaussianSplatPLYLoader.js';
import {
  degToRad,
  dot3,
  enuBasisAtOrigin,
  enuToWgs84,
  normalize3,
  sub3,
  wgs84ToEcef,
  wgs84ToEnuEllipsoidal,
  type Vec3,
} from './geodesy';
import type { LogLevel, SurveySplatAnchor } from './types';

export type OverlaySplatFormat = 'spz' | 'splat' | 'ksplat' | 'ply';

export interface CesiumCameraPose {
  positionWC: Vec3;
  rightWC: Vec3;
  upWC: Vec3;
  directionWC: Vec3;
  fovyDeg: number;
  near: number;
  far: number;
  aspect: number;
}

export interface LocalThreeCameraPose {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  back: Vec3;
  fovyDeg: number;
  near: number;
  far: number;
  aspect: number;
}

export interface SplatPlacement {
  anchor: SurveySplatAnchor;
  verticalOffsetMeters: number;
  headingDeg: number;
  scale: number;
  offsetMeters: number;
}

export interface LoadedSplatResult {
  surveyId: string;
  sourceKey: string;
  format: OverlaySplatFormat;
  splatCount: number;
  originalSplatCount: number;
  wasDownsampled: boolean;
  boundsSizeMeters: Vec3;
  anchor: SurveySplatAnchor;
  backend: 'webgpu' | 'webgl2';
}

export interface ActiveSplatStats {
  hasVisibleSplat: boolean;
  splatCount: number;
  originalSplatCount: number;
  surveyId: string | null;
  sourceKey: string | null;
  backend: 'webgpu' | 'webgl2' | 'uninitialized';
}

export interface SplatOverlayManager {
  getCanvas: () => HTMLCanvasElement | null;
  loadSurveySplatFromUrl: (
    surveyId: string,
    url: string,
    placement: SplatPlacement
  ) => Promise<LoadedSplatResult>;
  loadSurveySplatFromFile: (
    surveyId: string,
    file: File,
    placement: SplatPlacement
  ) => Promise<LoadedSplatResult>;
  setActiveSurvey: (surveyId: string | null) => void;
  hasCachedSplat: (surveyId: string, sourceKey?: string) => boolean;
  updatePlacement: (surveyId: string, placement: Partial<SplatPlacement>) => void;
  renameSurveyId: (oldSurveyId: string, newSurveyId: string) => void;
  removeSurveySplat: (surveyId: string) => void;
  renderFrame: (viewer: any) => void;
  renderForCapture: (viewer: any, targetW: number, targetH: number) => HTMLCanvasElement | null;
  getActiveSplatStats: () => ActiveSplatStats;
  dispose: () => void;
}

// ============================================================================
// Pure ENU Anchor & Camera Synchronization Math (Node/Vitest safe, zero DOM)
// ============================================================================

/**
 * Checks whether a filename or URL ends with a supported Gaussian Splat extension.
 */
export function inferOverlaySplatFormat(nameOrUrl: string): OverlaySplatFormat | null {
  const clean = String(nameOrUrl || '').trim().split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.spz')) return 'spz';
  if (clean.endsWith('.ksplat')) return 'ksplat';
  if (clean.endsWith('.splat')) return 'splat';
  if (clean.endsWith('.ply')) return 'ply';
  return null;
}

export function isSupportedSplatFileName(nameOrUrl: string): boolean {
  return inferOverlaySplatFormat(nameOrUrl) !== null;
}

/**
 * Converts a WGS84 geodetic point (lat deg, lon deg, ellipsoidal height m)
 * into a local Three.js right-handed Y-up ENU frame centered on `anchor`:
 *   +X = East, +Y = Up, +Z = South (-North)
 *
 * Determinant of [Ev; Uv; -Nv] is +1 (right-handed, orthonormal).
 */
export function wgs84ToLocalThreeEnu(
  lat: number,
  lon: number,
  alt: number,
  anchor: SurveySplatAnchor
): Vec3 {
  const [east, north, up] = wgs84ToEnuEllipsoidal(lat, lon, alt, {
    lat: anchor.lat,
    lon: anchor.lon,
    alt: anchor.baseHeightMeters,
  });
  return [east, up, -north];
}

/**
 * Inverse of `wgs84ToLocalThreeEnu`: converts local Three.js ENU coordinates
 * (+X = East, +Y = Up, +Z = South) back to WGS84 (lat, lon, ellipsoidal height).
 */
export function localThreeEnuToWgs84(
  x: number,
  y: number,
  z: number,
  anchor: SurveySplatAnchor
): SurveySplatAnchor {
  const pt = enuToWgs84(x, -z, y, {
    lat: anchor.lat,
    lon: anchor.lon,
    alt: anchor.baseHeightMeters,
  });
  return {
    lat: pt.lat,
    lon: pt.lon,
    baseHeightMeters: pt.alt,
  };
}

/**
 * Projects a Cesium ECEF camera pose into the active splat's local Three.js ENU frame
 * (+X = East, +Y = Up, +Z = South) so Three.js operates near (0, 0, 0) with zero
 * single-precision float jitter.
 */
export function cesiumCameraToLocalThree(
  pose: CesiumCameraPose,
  anchor: SurveySplatAnchor
): LocalThreeCameraPose {
  const originEcef = wgs84ToEcef(anchor.lat, anchor.lon, anchor.baseHeightMeters);
  const { Ev, Nv, Uv } = enuBasisAtOrigin(anchor.lat, anchor.lon);

  const projectVec = (v: Vec3): Vec3 => [
    dot3(v, Ev),
    dot3(v, Uv),
    -dot3(v, Nv),
  ];

  const deltaEcef = sub3(pose.positionWC, originEcef);
  const position = projectVec(deltaEcef);
  const right = normalize3(projectVec(pose.rightWC));
  const up = normalize3(projectVec(pose.upWC));
  // Three.js camera looks down -Z, so +Z axis is -directionWC
  const back = normalize3(
    projectVec([-pose.directionWC[0], -pose.directionWC[1], -pose.directionWC[2]])
  );

  return {
    position,
    right,
    up,
    back,
    fovyDeg: pose.fovyDeg,
    near: Math.max(0.05, pose.near),
    far: Math.max(pose.far, pose.near + 1000),
    aspect: pose.aspect > 0 ? pose.aspect : 16 / 9,
  };
}

// ============================================================================
// Ported from -splatthat (services/assetLoaderService.ts):
// Downsampling, Bounds Computation & Splat Geometry Loaders
// ============================================================================

const DEFAULT_GPU_SPLAT_BUDGET = 250_000;
const SOFTWARE_GL_SPLAT_BUDGET = 120_000;

export function downsampleGaussianSplatGeometry(
  srcGeo: THREE.BufferGeometry,
  maxSplats: number
): { geometry: THREE.BufferGeometry; originalCount: number; finalCount: number; wasDownsampled: boolean } {
  const centerAttr = srcGeo.getAttribute('center') as THREE.BufferAttribute | undefined;
  const covAttr = srcGeo.getAttribute('covariance') as THREE.BufferAttribute | undefined;
  const colorAttr = srcGeo.getAttribute('color') as THREE.BufferAttribute | undefined;

  if (!centerAttr || !covAttr || !colorAttr) {
    return {
      geometry: srcGeo,
      originalCount: centerAttr?.count ?? 0,
      finalCount: centerAttr?.count ?? 0,
      wasDownsampled: false,
    };
  }

  const originalCount = centerAttr.count;
  if (originalCount <= maxSplats || maxSplats <= 0) {
    return {
      geometry: srcGeo,
      originalCount,
      finalCount: originalCount,
      wasDownsampled: false,
    };
  }

  const targetCount = maxSplats;
  const stride = originalCount / targetCount;
  // Slightly enlarge surviving gaussians so surfaces stay cohesive after downsampling
  const varianceScale = Math.min(2.25, Math.pow(originalCount / targetCount, 0.45));

  const srcCenters = centerAttr.array as Float32Array;
  const srcCovs = covAttr.array as Float32Array;
  const srcColors = colorAttr.array as Uint8Array | Uint8ClampedArray;

  const newCenters = new Float32Array(targetCount * 3);
  const newCovs = new Float32Array(targetCount * 6);
  const newColors = new Uint8Array(targetCount * 4);

  const sh1Attr = srcGeo.getAttribute('sphericalHarmonics1') as THREE.BufferAttribute | undefined;
  const sh2Attr = srcGeo.getAttribute('sphericalHarmonics2') as THREE.BufferAttribute | undefined;
  const sh3Attr = srcGeo.getAttribute('sphericalHarmonics3') as THREE.BufferAttribute | undefined;

  const newSh1 = sh1Attr ? new Uint32Array(targetCount * sh1Attr.itemSize) : undefined;
  const newSh2 = sh2Attr ? new Uint32Array(targetCount * sh2Attr.itemSize) : undefined;
  const newSh3 = sh3Attr ? new Uint32Array(targetCount * sh3Attr.itemSize) : undefined;

  const srcSh1 = sh1Attr?.array as Uint32Array | undefined;
  const srcSh2 = sh2Attr?.array as Uint32Array | undefined;
  const srcSh3 = sh3Attr?.array as Uint32Array | undefined;

  for (let i = 0; i < targetCount; i++) {
    const srcIdx = Math.min(originalCount - 1, Math.floor(i * stride));

    const c3 = i * 3;
    const sc3 = srcIdx * 3;
    newCenters[c3] = srcCenters[sc3];
    newCenters[c3 + 1] = srcCenters[sc3 + 1];
    newCenters[c3 + 2] = srcCenters[sc3 + 2];

    const v6 = i * 6;
    const sv6 = srcIdx * 6;
    newCovs[v6] = srcCovs[sv6] * varianceScale;
    newCovs[v6 + 1] = srcCovs[sv6 + 1] * varianceScale;
    newCovs[v6 + 2] = srcCovs[sv6 + 2] * varianceScale;
    newCovs[v6 + 3] = srcCovs[sv6 + 3] * varianceScale;
    newCovs[v6 + 4] = srcCovs[sv6 + 4] * varianceScale;
    newCovs[v6 + 5] = srcCovs[sv6 + 5] * varianceScale;

    const k4 = i * 4;
    const sk4 = srcIdx * 4;
    newColors[k4] = srcColors[sk4];
    newColors[k4 + 1] = srcColors[sk4 + 1];
    newColors[k4 + 2] = srcColors[sk4 + 2];
    newColors[k4 + 3] = srcColors[sk4 + 3];

    if (newSh1 && srcSh1 && sh1Attr) {
      const sz = sh1Attr.itemSize;
      for (let k = 0; k < sz; k++) newSh1[i * sz + k] = srcSh1[srcIdx * sz + k];
    }
    if (newSh2 && srcSh2 && sh2Attr) {
      const sz = sh2Attr.itemSize;
      for (let k = 0; k < sz; k++) newSh2[i * sz + k] = srcSh2[srcIdx * sz + k];
    }
    if (newSh3 && srcSh3 && sh3Attr) {
      const sz = sh3Attr.itemSize;
      for (let k = 0; k < sz; k++) newSh3[i * sz + k] = srcSh3[srcIdx * sz + k];
    }
  }

  const downsampled = createGaussianSplatGeometry(newCenters, newCovs, newColors, {
    sphericalHarmonics1: newSh1,
    sphericalHarmonics2: newSh2,
    sphericalHarmonics3: newSh3,
  });

  srcGeo.dispose();

  return {
    geometry: downsampled,
    originalCount,
    finalCount: targetCount,
    wasDownsampled: true,
  };
}

/**
 * Computes world-space bounding box & size for an Object3D containing GaussianSplat(s).
 * Ported from -splatthat `computeObjectBounds`.
 */
export function computeObjectBounds(object: THREE.Object3D): {
  box: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
} {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let foundSplat = false;

  object.traverse((child) => {
    const maybeSplat = child as unknown as {
      isGaussianSplat?: boolean;
      boundingBox?: THREE.Box3 | null;
      computeBoundingBox?: () => void;
      matrixWorld: THREE.Matrix4;
    };
    if (maybeSplat.isGaussianSplat) {
      if (!maybeSplat.boundingBox && typeof maybeSplat.computeBoundingBox === 'function') {
        maybeSplat.computeBoundingBox();
      }
      if (maybeSplat.boundingBox && !maybeSplat.boundingBox.isEmpty()) {
        const min = maybeSplat.boundingBox.min;
        const max = maybeSplat.boundingBox.max;
        const corners = [
          new THREE.Vector3(min.x, min.y, min.z),
          new THREE.Vector3(min.x, min.y, max.z),
          new THREE.Vector3(min.x, max.y, min.z),
          new THREE.Vector3(min.x, max.y, max.z),
          new THREE.Vector3(max.x, min.y, min.z),
          new THREE.Vector3(max.x, min.y, max.z),
          new THREE.Vector3(max.x, max.y, min.z),
          new THREE.Vector3(max.x, max.y, max.z),
        ];
        for (const corner of corners) {
          corner.applyMatrix4(maybeSplat.matrixWorld);
          box.expandByPoint(corner);
        }
        foundSplat = true;
      }
    }
  });

  if (!foundSplat || box.isEmpty()) {
    box.setFromObject(object);
  }

  if (box.isEmpty()) {
    box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { box, center, size };
}

async function parseSplatGeometryFromBuffer(
  buffer: ArrayBuffer,
  format: OverlaySplatFormat
): Promise<THREE.BufferGeometry> {
  if (buffer.byteLength === 0) {
    throw new Error('Splat file is empty (0 bytes).');
  }
  switch (format) {
    case 'spz': {
      const loader = new SPZLoader();
      return await Promise.resolve(loader.parse(buffer));
    }
    case 'splat': {
      const loader = new SPLATLoader();
      return await Promise.resolve(loader.parse(buffer));
    }
    case 'ksplat': {
      const loader = new KSPLATLoader();
      return await Promise.resolve(loader.parse(buffer));
    }
    case 'ply': {
      const loader = new GaussianSplatPLYLoader();
      return await Promise.resolve(loader.parse(buffer));
    }
  }
}

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false;
    const rendererStr = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    return /swiftshader|llvmpipe|software|mesa offscreen|basic render/i.test(rendererStr);
  } catch {
    return false;
  }
}

function extractCesiumCameraPose(
  viewer: any,
  overrideAspect?: number
): CesiumCameraPose | null {
  const cam = viewer?.camera;
  const canvas = viewer?.scene?.canvas as HTMLCanvasElement | undefined;
  if (!cam?.positionWC || !cam?.rightWC || !cam?.upWC || !cam?.directionWC || !canvas) {
    return null;
  }

  const frustum = cam.frustum;
  const aspect =
    typeof overrideAspect === 'number' && Number.isFinite(overrideAspect) && overrideAspect > 0
      ? overrideAspect
      : canvas.clientWidth > 0 && canvas.clientHeight > 0
        ? canvas.clientWidth / canvas.clientHeight
        : canvas.width > 0 && canvas.height > 0
          ? canvas.width / canvas.height
          : 16 / 9;

  let fovyRad: number | null = null;
  if (frustum && typeof frustum.fovy === 'number' && Number.isFinite(frustum.fovy) && frustum.fovy > 0) {
    fovyRad = frustum.fovy;
  } else if (frustum && typeof frustum.fov === 'number' && Number.isFinite(frustum.fov) && frustum.fov > 0) {
    // Cesium PerspectiveFrustum.fov is the wider-axis FOV; convert when aspect >= 1
    if (aspect >= 1) {
      fovyRad = 2 * Math.atan(Math.tan(frustum.fov / 2) / aspect);
    } else {
      fovyRad = frustum.fov;
    }
  }

  const fovyDeg = fovyRad ? (fovyRad * 180) / Math.PI : 53.13;
  const near =
    frustum && typeof frustum.near === 'number' && Number.isFinite(frustum.near)
      ? Math.max(0.05, frustum.near)
      : 0.1;
  const far =
    frustum && typeof frustum.far === 'number' && Number.isFinite(frustum.far)
      ? Math.min(Math.max(frustum.far, near + 1000), 1e8)
      : 1e7;

  return {
    positionWC: [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z],
    rightWC: [cam.rightWC.x, cam.rightWC.y, cam.rightWC.z],
    upWC: [cam.upWC.x, cam.upWC.y, cam.upWC.z],
    directionWC: [cam.directionWC.x, cam.directionWC.y, cam.directionWC.z],
    fovyDeg,
    near,
    far,
    aspect,
  };
}

interface CachedSurveySplat {
  surveyId: string;
  sourceKey: string;
  format: OverlaySplatFormat;
  pivot: THREE.Group;
  splat: GaussianSplat;
  splatCount: number;
  originalSplatCount: number;
  wasDownsampled: boolean;
  boundsSizeMeters: Vec3;
  placement: SplatPlacement;
}

// ============================================================================
// Splat Overlay Manager
// ============================================================================

export function createSplatOverlayManager(
  containerEl: HTMLElement,
  options?: { onLog?: (message: string, level?: LogLevel) => void }
): SplatOverlayManager {
  const log = (msg: string, level: LogLevel = 'info') => {
    options?.onLog?.(msg, level);
  };

  let canvas: HTMLCanvasElement | null = null;
  let renderer: THREE.WebGPURenderer | null = null;
  let rendererReady = false;
  let rendererInitPromise: Promise<'webgpu' | 'webgl2'> | null = null;
  let activeBackend: 'webgpu' | 'webgl2' | 'uninitialized' = 'uninitialized';
  let isSoftwareGl = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(53.13, 16 / 9, 0.1, 1e7);
  camera.matrixAutoUpdate = true;

  const entries = new Map<string, CachedSurveySplat>();
  let activeSurveyId: string | null = null;
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  let lastPixelRatio = 0;

  // Reusable math scratch objects (zero per-frame allocations)
  const tmpMat4 = new THREE.Matrix4();
  const tmpRight = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpBack = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();

  function ensureCanvas(): HTMLCanvasElement {
    if (canvas) return canvas;
    const c = document.createElement('canvas');
    c.id = 'splat-overlay-canvas';
    c.setAttribute('aria-hidden', 'true');
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '2';
    c.style.background = 'transparent';
    containerEl.appendChild(c);
    canvas = c;
    return c;
  }

  async function ensureRenderer(): Promise<'webgpu' | 'webgl2'> {
    if (renderer && rendererReady && activeBackend !== 'uninitialized') {
      return activeBackend;
    }
    if (rendererInitPromise) {
      return rendererInitPromise;
    }

    rendererInitPromise = (async () => {
      const overlayCanvas = ensureCanvas();
      isSoftwareGl = detectSoftwareWebGL();
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

      const initWith = async (forceWebGL: boolean): Promise<'webgpu' | 'webgl2'> => {
        const candidate = new THREE.WebGPURenderer({
          canvas: overlayCanvas,
          alpha: true,
          antialias: !isSoftwareGl,
          forceWebGL,
        });
        await candidate.init();
        candidate.setClearColor(0x000000, 0);
        candidate.outputColorSpace = THREE.SRGBColorSpace;
        candidate.toneMapping = THREE.NoToneMapping;
        renderer = candidate;
        rendererReady = true;
        activeBackend = forceWebGL ? 'webgl2' : 'webgpu';
        return activeBackend;
      };

      if (hasWebGPU) {
        try {
          const backend = await initWith(false);
          log('Splat overlay renderer initialized (WebGPU).', 'ok');
          return backend;
        } catch (gpuErr: any) {
          log(
            `WebGPU overlay init unavailable (${gpuErr?.message || 'fallback'}), switching to WebGL2...`,
            'warn'
          );
        }
      }

      const backend = await initWith(true);
      log(
        `Splat overlay renderer initialized (WebGL2 fallback${isSoftwareGl ? ' · software GPU budget' : ''}).`,
        'ok'
      );
      return backend;
    })();

    try {
      return await rendererInitPromise;
    } catch (err) {
      rendererInitPromise = null;
      throw err;
    }
  }

  function applyPivotTransform(entry: CachedSurveySplat): void {
    const p = entry.placement;
    const totalVerticalOffset = (p.verticalOffsetMeters || 0) + (p.offsetMeters || 0);
    const scale = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
    const headingRad = -degToRad(Number.isFinite(p.headingDeg) ? p.headingDeg : 0);

    entry.pivot.position.set(0, totalVerticalOffset, 0);
    entry.pivot.rotation.set(0, headingRad, 0);
    entry.pivot.scale.setScalar(scale);
    entry.pivot.updateMatrixWorld(true);
  }

  function disposeEntry(entry: CachedSurveySplat): void {
    scene.remove(entry.pivot);
    try {
      entry.splat.splatGeometry?.dispose();
    } catch {
      // ignore
    }
    try {
      entry.splat.geometry?.dispose();
    } catch {
      // ignore
    }
    try {
      const mat = entry.splat.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => m.dispose());
      } else {
        mat?.dispose();
      }
    } catch {
      // ignore
    }
  }

  function syncVisibility(): void {
    for (const [id, entry] of entries) {
      entry.pivot.visible = id === activeSurveyId;
    }
    if (canvas) {
      const hasVisible = Boolean(activeSurveyId && entries.has(activeSurveyId));
      canvas.style.opacity = hasVisible ? '1' : '0';
    }
  }

  function syncRendererSize(targetCssW: number, targetCssH: number, dpr: number): void {
    if (!renderer || !rendererReady) return;
    const w = Math.max(1, Math.round(targetCssW));
    const h = Math.max(1, Math.round(targetCssH));
    const clampedDpr = Math.max(1, Math.min(2, dpr));
    if (w !== lastViewportWidth || h !== lastViewportHeight || clampedDpr !== lastPixelRatio) {
      renderer.setPixelRatio(clampedDpr);
      renderer.setSize(w, h, false);
      lastViewportWidth = w;
      lastViewportHeight = h;
      lastPixelRatio = clampedDpr;
    }
  }

  function syncThreeCameraFromCesium(
    viewer: any,
    anchor: SurveySplatAnchor,
    overrideAspect?: number
  ): boolean {
    const pose = extractCesiumCameraPose(viewer, overrideAspect);
    if (!pose) return false;

    const local = cesiumCameraToLocalThree(pose, anchor);
    tmpRight.set(local.right[0], local.right[1], local.right[2]);
    tmpUp.set(local.up[0], local.up[1], local.up[2]);
    tmpBack.set(local.back[0], local.back[1], local.back[2]);
    tmpPos.set(local.position[0], local.position[1], local.position[2]);

    tmpMat4.makeBasis(tmpRight, tmpUp, tmpBack);
    tmpMat4.setPosition(tmpPos);

    camera.position.copy(tmpPos);
    camera.quaternion.setFromRotationMatrix(tmpMat4);
    camera.fov = local.fovyDeg;
    camera.aspect = local.aspect;
    camera.near = local.near;
    camera.far = local.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return true;
  }

  async function installParsedSplat(
    surveyId: string,
    sourceKey: string,
    format: OverlaySplatFormat,
    buffer: ArrayBuffer,
    placement: SplatPlacement
  ): Promise<LoadedSplatResult> {
    const backend = await ensureRenderer();

    const rawGeometry = await parseSplatGeometryFromBuffer(buffer, format);
    const centerAttr = rawGeometry.getAttribute('center') as THREE.BufferAttribute | undefined;
    const rawCount = centerAttr?.count ?? 0;
    if (rawCount <= 0) {
      rawGeometry.dispose();
      throw new Error(`Parsed 0 splats from ${format.toUpperCase()} asset.`);
    }

    const budget = isSoftwareGl ? SOFTWARE_GL_SPLAT_BUDGET : DEFAULT_GPU_SPLAT_BUDGET;
    const { geometry, originalCount, finalCount, wasDownsampled } =
      downsampleGaussianSplatGeometry(rawGeometry, budget);

    if (wasDownsampled) {
      log(
        `GPU budget safeguard: downsampled ${originalCount.toLocaleString()} -> ${finalCount.toLocaleString()} splats (${format.toUpperCase()}).`,
        'warn'
      );
    } else {
      log(
        `Loaded ${finalCount.toLocaleString()} Gaussian splats (${format.toUpperCase()} · ${backend.toUpperCase()}).`,
        'ok'
      );
    }

    const splatMesh = new GaussianSplat(geometry, { autoSort: true });
    splatMesh.frustumCulled = false;
    splatMesh.computeBoundingBox();
    splatMesh.computeBoundingSphere();

    // Ground the splat so its bottom-center rests at local (0, 0, 0) inside the survey pivot
    const splatHolder = new THREE.Group();
    splatHolder.add(splatMesh);
    const bounds = computeObjectBounds(splatHolder);
    splatMesh.position.set(-bounds.center.x, -bounds.box.min.y, -bounds.center.z);

    const pivot = new THREE.Group();
    pivot.name = `survey-splat-${surveyId}`;
    pivot.add(splatHolder);

    // Replace any existing splat for this survey
    const prev = entries.get(surveyId);
    if (prev) {
      disposeEntry(prev);
      entries.delete(surveyId);
    }

    const entry: CachedSurveySplat = {
      surveyId,
      sourceKey,
      format,
      pivot,
      splat: splatMesh,
      splatCount: finalCount,
      originalSplatCount: originalCount,
      wasDownsampled,
      boundsSizeMeters: [
        Number(bounds.size.x.toFixed(2)),
        Number(bounds.size.y.toFixed(2)),
        Number(bounds.size.z.toFixed(2)),
      ],
      placement: {
        anchor: { ...placement.anchor },
        verticalOffsetMeters: placement.verticalOffsetMeters || 0,
        headingDeg: placement.headingDeg || 0,
        scale: placement.scale > 0 ? placement.scale : 1,
        offsetMeters: placement.offsetMeters || 0,
      },
    };

    applyPivotTransform(entry);
    scene.add(pivot);
    entries.set(surveyId, entry);
    activeSurveyId = surveyId;
    syncVisibility();

    return {
      surveyId,
      sourceKey,
      format,
      splatCount: finalCount,
      originalSplatCount: originalCount,
      wasDownsampled,
      boundsSizeMeters: entry.boundsSizeMeters,
      anchor: { ...entry.placement.anchor },
      backend,
    };
  }

  async function loadSurveySplatFromUrl(
    surveyId: string,
    url: string,
    placement: SplatPlacement
  ): Promise<LoadedSplatResult> {
    const trimmed = String(url || '').trim();
    if (!trimmed) {
      throw new Error('Empty splat URL.');
    }
    const format = inferOverlaySplatFormat(trimmed);
    if (!format) {
      throw new Error('Unsupported splat URL format. Expected .spz, .ply, .splat, or .ksplat.');
    }

    // Reuse cached geometry if this exact survey+URL is already loaded
    const existing = entries.get(surveyId);
    if (existing && existing.sourceKey === trimmed) {
      existing.placement = {
        anchor: { ...placement.anchor },
        verticalOffsetMeters: placement.verticalOffsetMeters || 0,
        headingDeg: placement.headingDeg || 0,
        scale: placement.scale > 0 ? placement.scale : 1,
        offsetMeters: placement.offsetMeters || 0,
      };
      applyPivotTransform(existing);
      activeSurveyId = surveyId;
      syncVisibility();
      return {
        surveyId,
        sourceKey: trimmed,
        format: existing.format,
        splatCount: existing.splatCount,
        originalSplatCount: existing.originalSplatCount,
        wasDownsampled: existing.wasDownsampled,
        boundsSizeMeters: existing.boundsSizeMeters,
        anchor: { ...existing.placement.anchor },
        backend: activeBackend === 'webgl2' ? 'webgl2' : 'webgpu',
      };
    }

    let response: Response;
    try {
      response = await fetch(trimmed, { mode: 'cors' });
    } catch (netErr: any) {
      throw new Error(
        `Network or CORS error fetching splat URL: ${netErr?.message || 'request blocked'}`
      );
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || 'Error'} fetching splat URL.`);
    }

    const buffer = await response.arrayBuffer();
    return installParsedSplat(surveyId, trimmed, format, buffer, placement);
  }

  async function loadSurveySplatFromFile(
    surveyId: string,
    file: File,
    placement: SplatPlacement
  ): Promise<LoadedSplatResult> {
    const format = inferOverlaySplatFormat(file.name);
    if (!format) {
      throw new Error(
        `Unsupported file "${file.name}". Drop a .spz, .ply, .splat, or .ksplat file.`
      );
    }
    const buffer = await file.arrayBuffer();
    return installParsedSplat(surveyId, `file:${file.name}`, format, buffer, placement);
  }

  function setActiveSurvey(surveyId: string | null): void {
    activeSurveyId = surveyId;
    syncVisibility();
    if (!activeSurveyId || !entries.has(activeSurveyId)) {
      if (renderer && rendererReady) {
        renderer.clear();
      }
    }
  }

  function hasCachedSplat(surveyId: string, sourceKey?: string): boolean {
    const entry = entries.get(surveyId);
    if (!entry) return false;
    if (sourceKey !== undefined) {
      return entry.sourceKey === sourceKey;
    }
    return true;
  }

  function updatePlacement(surveyId: string, partial: Partial<SplatPlacement>): void {
    const entry = entries.get(surveyId);
    if (!entry) return;
    if (partial.anchor) {
      entry.placement.anchor = { ...partial.anchor };
    }
    if (typeof partial.verticalOffsetMeters === 'number' && Number.isFinite(partial.verticalOffsetMeters)) {
      entry.placement.verticalOffsetMeters = partial.verticalOffsetMeters;
    }
    if (typeof partial.headingDeg === 'number' && Number.isFinite(partial.headingDeg)) {
      entry.placement.headingDeg = partial.headingDeg;
    }
    if (typeof partial.scale === 'number' && Number.isFinite(partial.scale) && partial.scale > 0) {
      entry.placement.scale = partial.scale;
    }
    if (typeof partial.offsetMeters === 'number' && Number.isFinite(partial.offsetMeters)) {
      entry.placement.offsetMeters = partial.offsetMeters;
    }
    applyPivotTransform(entry);
  }

  function renameSurveyId(oldSurveyId: string, newSurveyId: string): void {
    if (!oldSurveyId || !newSurveyId || oldSurveyId === newSurveyId) return;
    const entry = entries.get(oldSurveyId);
    if (entry) {
      entries.delete(oldSurveyId);
      entry.surveyId = newSurveyId;
      entry.pivot.name = `survey-splat-${newSurveyId}`;
      entries.set(newSurveyId, entry);
    }
    if (activeSurveyId === oldSurveyId) {
      activeSurveyId = newSurveyId;
    }
    syncVisibility();
  }

  function removeSurveySplat(surveyId: string): void {
    const existing = entries.get(surveyId);
    if (existing) {
      disposeEntry(existing);
      entries.delete(surveyId);
    }
    syncVisibility();
    if ((!activeSurveyId || !entries.has(activeSurveyId)) && renderer && rendererReady) {
      renderer.clear();
    }
  }

  function renderFrame(viewer: any): void {
    if (!renderer || !rendererReady) return;
    const entry = activeSurveyId ? entries.get(activeSurveyId) : undefined;
    if (!entry || !entry.pivot.visible) {
      return;
    }
    const cesiumCanvas = viewer?.scene?.canvas as HTMLCanvasElement | undefined;
    if (!cesiumCanvas) return;

    const cssW = cesiumCanvas.clientWidth || cesiumCanvas.width;
    const cssH = cesiumCanvas.clientHeight || cesiumCanvas.height;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = cesiumCanvas.clientWidth > 0 ? cesiumCanvas.width / cesiumCanvas.clientWidth : 1;
    syncRendererSize(cssW, cssH, dpr);

    if (!syncThreeCameraFromCesium(viewer, entry.placement.anchor)) return;
    renderer.render(scene, camera);
  }

  function renderForCapture(
    viewer: any,
    targetW: number,
    targetH: number
  ): HTMLCanvasElement | null {
    if (!renderer || !rendererReady || !canvas) return null;
    const entry = activeSurveyId ? entries.get(activeSurveyId) : undefined;
    if (!entry || !entry.pivot.visible || entry.splatCount <= 0) {
      return null;
    }

    const w = Math.max(1, Math.round(targetW));
    const h = Math.max(1, Math.round(targetH));
    // Match exact pixel resolution with pixelRatio = 1 for crisp 1:1 compositing
    syncRendererSize(w, h, 1);

    if (!syncThreeCameraFromCesium(viewer, entry.placement.anchor, w / h)) {
      return null;
    }
    renderer.render(scene, camera);
    return canvas;
  }

  function getActiveSplatStats(): ActiveSplatStats {
    const entry = activeSurveyId ? entries.get(activeSurveyId) : undefined;
    const visible = Boolean(entry && entry.pivot.visible && entry.splatCount > 0 && rendererReady);
    return {
      hasVisibleSplat: visible,
      splatCount: visible && entry ? entry.splatCount : 0,
      originalSplatCount: visible && entry ? entry.originalSplatCount : 0,
      surveyId: activeSurveyId,
      sourceKey: entry?.sourceKey ?? null,
      backend: activeBackend,
    };
  }

  function dispose(): void {
    for (const entry of entries.values()) {
      disposeEntry(entry);
    }
    entries.clear();
    if (renderer) {
      try {
        renderer.dispose();
      } catch {
        // ignore
      }
      renderer = null;
      rendererReady = false;
    }
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
  }

  return {
    getCanvas: () => canvas,
    loadSurveySplatFromUrl,
    loadSurveySplatFromFile,
    setActiveSurvey,
    hasCachedSplat,
    updatePlacement,
    renameSurveyId,
    removeSurveySplat,
    renderFrame,
    renderForCapture,
    getActiveSplatStats,
    dispose,
  };
}
