import type {
  ActiveCard,
  CameraBookmark,
  CameraState,
  CopilotContextSnapshot,
  CopilotToolResult,
  FlightMode,
  GeoDrawBoxSnapshot,
  HealthState,
  HudMode,
  LogLevel,
  MeasureMode,
  NoDroneController,
  RecordedClip,
  SiteManifest,
  SiteWeatherData,
  SurveyRecord,
  SurveyStatus,
  SurveyTilesetRef,
  TilesetEntry,
  UiControlEntry,
  UiStateSnapshot,
  WeatherTileLayer,
  WeatherUnitSystem,
} from './types';
import {
  blenderFocalLengthMm,
  buildLookAtC2W,
  c2wOpenCvToCesiumHPR,
  computePinholeK,
  convertGesTrackingJson,
  extractRotation3x3,
  formatDms,
  isGesTrackingJson,
  openCvToOpenGlC2W,
  rotationMatrixToQuaternion,
  round7,
  roundTo,
  sha256Hex,
  wgs84ToEnuEllipsoidal,
  type BlenderTrajectoryDocument,
  type CameraMatricesDocument,
  type FlyoverAnchor,
  type PinholeIntrinsics,
  type UnitQuaternion,
} from './geodesy';
import { MAJOR_CITIES, US_STATES, WORLD_COUNTRIES } from './placesDataset';
import {
  classifyTilesetRefs,
  createDefaultSurveyRecord,
  createSurveyId,
  normalizeSiteManifest,
  normalizeSurveyStatus,
  resolveSurveySelection,
  sortSurveysNewestFirst,
  toIsoDateOnly,
} from './surveyCatalog';

// Optional: Paste a read-only public Cesium ion token here if embedding publicly
const DEFAULT_ION_TOKEN = '';
const STORAGE_KEY = 'cesium_splatmap_ion_token';
const REDMOND_SPLAT_ASSET_ID = 4547222;

interface RenderPathSample {
  t?: number;
  lat: number;
  lon: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  fovyDeg?: number | null;
}

interface LoadedRenderPath {
  fileName: string;
  site: string;
  fps: number;
  resolution: [number, number];
  samples: RenderPathSample[];
}

interface ZipEntryInput {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

interface RenderZipPart {
  url: string;
  name: string;
  frameStart: number;
  frameEnd: number;
  sizeBytes: number;
}

const RENDER_ZIP_PART_FRAMES = 300;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoreZipBlob(entries: ZipEntryInput[]): Blob {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  const localParts: BlobPart[] = [];
  const centralParts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = computeCrc32(data);
    const size = data.byteLength;

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(new ArrayBuffer(30 + nameBytes.length));
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // Compression method 0 (store-only)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = new Uint8Array(new ArrayBuffer(46 + nameBytes.length));
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 filename flag
    cv.setUint16(10, 0, true); // Compression method 0 (store-only)
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // Extra field length
    cv.setUint16(32, 0, true); // Comment length
    cv.setUint16(34, 0, true); // Disk number start
    cv.setUint16(36, 0, true); // Internal file attributes
    cv.setUint32(38, 0, true); // External file attributes
    cv.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.byteLength + size;
  }

  let centralDirSize = 0;
  for (const ch of centralParts) {
    centralDirSize += ch.byteLength;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(new ArrayBuffer(22));
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

export function initNoDroneCesiumApp(): NoDroneController | null {
  const Cesium = window.Cesium;
  if (!Cesium) {
    console.error('CesiumJS failed to load from CDN.');
    const fallback = document.getElementById('webgl-fallback');
    if (fallback) fallback.classList.remove('hidden');
    return null;
  }

  // Core Viewer & Geospatial State
  let viewer: any = null;
  let builtinCesiumToken = '';
  let ionConnected = false;
  let worldTerrainEnabled = false;
  let google3DTileset: any = null;
  let google3DEnabled = false;
  let activeTilesets: TilesetEntry[] = [];
  let currentSSE = 8;
  let currentHeightOffset = 0;
  let activeClipAssetId: number | null = null;
  let activeClippingCollection: any = null;
  let cameraBookmarks: CameraBookmark[] = [];

  // Survey Catalog State (Schema 2.0 dated epochs + dormant Before/After compare hook)
  let surveyCatalog: SurveyRecord[] = [
    createDefaultSurveyRecord({ label: 'Baseline Survey', status: 'planned' }),
  ];
  let activeSurveyId: string = surveyCatalog[0].surveyId;
  let compareSurveyId: string | null = null;
  let surveyCatalogTouched = false;

  // Chronograph HUD Choreography State (Clean globe on launch; single active card above bottom rail)
  let activeCard: ActiveCard = null;
  let hudMode: HudMode = 'rail';
  let spotlightTimer: number | null = null;
  let spotlightCleanup: (() => void) | null = null;

  // Virtual Drone Flight State
  let flightMode: FlightMode = 'explore';
  let wasdSpeedMps = 35;
  let orbitSpeedDegPerSec = 18;
  let activeLensMm = 24;
  const pressedKeys = new Set<string>();
  let lastPreUpdateTime = performance.now();
  let orbitTargetCartesian: any = null;
  let orbitHeadingRad = 0;
  let orbitPitchRad = -Cesium.Math.toRadians(35);
  let orbitRangeMeters = 250;
  let orbitAccumulatedDeg = 0;
  let orbitAutoStopRec = false;
  let tourCancelled = false;
  let activeFlySeq = 0;
  let pendingCameraTarget: CameraState | null = null;

  // Video Recording State
  let mediaRecorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let isRecording = false;
  let recordingStartMs = 0;
// NoDRONE camera path log: one sample per rendered frame while recording
let cameraPathSamples: any[] = [];
let cameraPathRemove: (() => void) | null = null;
  let recordingTimerHandle: number | null = null;
  let recordingModeLabel = 'Free Flight';
  let recordedClips: RecordedClip[] = [];

  // Offline Render Path State
  let loadedRenderPath: LoadedRenderPath | null = null;
  let isRenderingPath = false;
  let renderPathCancelled = false;
  let renderZipParts: RenderZipPart[] = [];
  let renderPathEntities: any[] = [];
  let isPreviewingRenderPath = false;
  let renderPathPreviewRaf: number | null = null;
  const supportsDirectoryPicker =
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

  // 3D Surface Measurement State
  let measureMode: MeasureMode = 'off';
  let measurePositions: any[] = [];
  let measureEntities: any[] = [];
  let measureHandler: any = null;

  // Geo-Coordinate Draw Box & Splat Studio Capture State
  interface GeoDrawBoxState {
    name: string;
    south: number;
    north: number;
    west: number;
    east: number;
    surfaceBaseMeters: number;
    baseOffsetMeters: number;
    heightMeters: number;
    visible: boolean;
  }
  let geoBox: GeoDrawBoxState | null = null;
  let geoBoxDrawing = false;
  let geoBoxAnchor: { lat: number; lon: number; height: number } | null = null;
  let geoBoxEntities: any[] = [];
  let geoBoxPreviewEntities: any[] = [];
  let geoBoxDrawHandler: any = null;
  let geoBoxDragHandler: any = null;
  let geoBoxDraggingCorner: 'sw' | 'se' | 'ne' | 'nw' | 'top' | 'base' | null = null;
  let geoBoxDragStartY = 0;
  let geoBoxDragStartHeight = 25;
  let geoBoxDragStartBaseOffset = 0;
  let geoBoxVerticalMetersPerPx = 0.25;
  let geoBoxCaptureViews = 12;
  let isCapturingGeoBox = false;
  let geoBoxCaptureCancelled = false;

  // Map Labels Overlay & Live Reverse-Geocode Location State
  let mapLabelsEnabled = true;
  let mapLabelsTempHidden = false;
  let mapLabelsImageryLayer: any = null;
  let mapLabelsImageryLoading = false;
  let mapLabelsImageryGeneration = 0;
  let mapLabelEntities: Array<{ entity: any; position: any }> = [];
  let reverseGeocodeTimer: number | null = null;
  let lastReverseLat = Number.NaN;
  let lastReverseLon = Number.NaN;
  let lastReverseData: {
    city: string | null;
    region: string | null;
    regionCode: string | null;
    country: string | null;
    countryCode: string | null;
    ocean: string | null;
  } | null = null;

  // Telemetry & Chronograph Cluster Gauge State
  let frameCount = 0;
  let lastFpsCheck = performance.now();
  let smoothedFps = 60;
  let clusterUnits: 'imperial' | 'metric' = 'imperial';
  let clusterCollapsed = false;
  let lastClusterSampleMs = 0;
  let prevCamPosCartesian: any = null;
  let prevCamAltMeters: number | null = null;
  let smoothedSpeedMps = 0;
  let smoothedClimbMps = 0;

  // Real-Time Weather Overlay State
  let weatherUnits: WeatherUnitSystem = 'imperial';
  let activeWeatherLayer: WeatherTileLayer = 'off';
  let weatherOpacity = 0.65;
  let weatherImageryLayer: any = null;
  let show3DWeatherOverlay = false;
  let weatherEntities: any[] = [];
  let lastWeatherData: SiteWeatherData | null = null;
  let lastWeatherLat = 33.5021;
  let lastWeatherLon = -82.0226;
  let weatherMoveDebounce: number | null = null;
  let weatherFetchSeq = 0;

  // DOM Element References
  const el = <T extends HTMLElement>(id: string): T | null =>
    document.getElementById(id) as T | null;

  const tokenModal = el<HTMLDivElement>('token-modal');
  const inputIonToken = el<HTMLTextAreaElement>('input-ion-token');
  const ionStatusDot = el<HTMLSpanElement>('ion-status-dot');
  const ionStatusText = el<HTMLSpanElement>('ion-status-text');
  const loadingOverlay = el<HTMLDivElement>('loading-overlay');
  const loadingText = el<HTMLParagraphElement>('loading-text');
  const cardStage = el<HTMLDivElement>('card-stage');
  const summonGrid = el<HTMLElement>('summon-grid');
  const flightClusterGauge = el<HTMLElement>('flight-cluster-gauge');
  const boxDrawBanner = el<HTMLDivElement>('box-draw-banner');
  const boxDrawBannerText = el<HTMLSpanElement>('box-draw-banner-text');
  const spotlightTag = el<HTMLDivElement>('copilot-spotlight-tag');
  const healthLogList = el<HTMLDivElement>('health-log-list');
  const tilesetListEl = el<HTMLDivElement>('tileset-list');
  const bookmarkListEl = el<HTMLDivElement>('bookmark-list');
  const clipListEl = el<HTMLDivElement>('clip-list');
  const manifestFileInput = el<HTMLInputElement>('input-manifest-file');
  const renderPathFileInput = el<HTMLInputElement>('input-render-path-file');
  const renderPathStatusEl = el<HTMLSpanElement>('render-path-status');
  const btnRenderFrames = el<HTMLButtonElement>('btn-render-frames');
  const btnRenderToFolder = el<HTMLButtonElement>('btn-render-to-folder');
  const renderZipPartsList = el<HTMLDivElement>('render-zip-parts-list');
  const renderProgressOverlay = el<HTMLDivElement>('render-progress-overlay');
  const renderProgressText = el<HTMLSpanElement>('render-progress-text');
  const renderProgressBar = el<HTMLDivElement>('render-progress-bar');
  const toastContainer = el<HTMLDivElement>('toast-container');
  const flightHudBanner = el<HTMLDivElement>('flight-hud-banner');
  const flightHudLabel = el<HTMLSpanElement>('flight-hud-label');
  const flightHudHint = el<HTMLSpanElement>('flight-hud-hint');
  const recIndicator = el<HTMLDivElement>('rec-indicator');
  const recModeText = el<HTMLSpanElement>('rec-mode-text');
  const recTimer = el<HTMLSpanElement>('rec-timer');
  const clipModal = el<HTMLDivElement>('clip-modal');
  const clipModalVideo = el<HTMLVideoElement>('clip-modal-video');
  const clipModalTitle = el<HTMLHeadingElement>('clip-modal-title');
  const clipModalMeta = el<HTMLParagraphElement>('clip-modal-meta');
  const clipModalDownload = el<HTMLAnchorElement>('btn-download-clip-modal');
  const webglFallback = el<HTMLDivElement>('webgl-fallback');

  function showToast(message: string, type: 'info' | 'error' = 'info'): void {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    const colorClass =
      type === 'error'
        ? 'bg-red-950/90 border-red-500/40 text-red-200'
        : 'bg-zinc-900/95 border-zinc-700/80 text-zinc-100';
    toast.className = `px-4 py-2.5 rounded-xl border backdrop-blur-md text-xs font-medium shadow-2xl transition-all duration-200 opacity-0 translate-y-2 ${colorClass}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.remove('opacity-0', 'translate-y-2'));
    window.setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      window.setTimeout(() => toast.remove(), 250);
    }, 3400);
  }

  function logEvent(message: string, level: LogLevel = 'info'): void {
    if (!healthLogList) return;
    const ts = new Date().toTimeString().slice(0, 8);
    const styles: Record<LogLevel, string> = {
      ok: 'text-emerald-300',
      info: 'text-zinc-300',
      warn: 'text-amber-300',
      error: 'text-red-400',
    };
    const badges: Record<LogLevel, string> = {
      ok: '[OK]',
      info: '[INFO]',
      warn: '[WARN]',
      error: '[ERR]',
    };
    const div = document.createElement('div');
    div.className = `${styles[level]} break-words`;
    div.textContent = `${ts} ${badges[level]} ${message}`;
    healthLogList.appendChild(div);
    while (healthLogList.children.length > 60) {
      healthLogList.removeChild(healthLogList.firstChild!);
    }
    healthLogList.scrollTop = healthLogList.scrollHeight;
  }

  function setHealthState(state: HealthState): void {
    const dot = el<HTMLSpanElement>('health-dot');
    const dockDot = el<HTMLSpanElement>('dock-health-dot');
    const badge = el<HTMLSpanElement>('health-badge');
    if (!dot || !badge || !dockDot) return;

    if (state === 'critical') {
      dot.className = 'w-2 h-2 rounded-full bg-red-500';
      dockDot.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
      badge.className = 'text-[11px] font-mono text-red-300';
      badge.textContent = 'High Load';
    } else if (state === 'warn') {
      dot.className = 'w-2 h-2 rounded-full bg-amber-400';
      dockDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400';
      badge.className = 'text-[11px] font-mono text-amber-300';
      badge.textContent = 'Moderate';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      dockDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
      badge.className = 'text-[11px] font-mono text-emerald-300';
      badge.textContent = 'Healthy';
    }
  }

  function releaseCameraTransform(): void {
    if (!viewer || !viewer.camera) return;
    try {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch {
      // ignore if already identity
    }
  }

  function applyLensPreset(focalLengthMm: number): void {
    activeLensMm = focalLengthMm;
    // Full-frame 35mm sensor vertical height = 24mm -> vFOV = 2 * atan(24 / (2 * f))
    const vFovRad = 2 * Math.atan(24 / (2 * focalLengthMm));
    const vFovDeg = Cesium.Math.toDegrees(vFovRad);
    if (viewer && viewer.camera && viewer.camera.frustum && 'fov' in viewer.camera.frustum) {
      viewer.camera.frustum.fov = vFovRad;
    }

    const fovLabel = el<HTMLSpanElement>('val-lens-fov');
    if (fovLabel) {
      fovLabel.textContent = `${focalLengthMm}mm · ${vFovDeg.toFixed(1)}°`;
    }

    document.querySelectorAll<HTMLButtonElement>('.lens-btn').forEach((btn) => {
      const mm = Number(btn.dataset.lensMm);
      btn.setAttribute('data-active', String(mm === focalLengthMm));
    });

    logEvent(`Lens set to ${focalLengthMm}mm eq. (${vFovDeg.toFixed(1)}° vFOV).`, 'info');
  }

  function pickViewportTarget(): any {
    if (!viewer) return null;
    const canvas = viewer.scene.canvas;
    const centerScreen = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);

    // 1. Try depth buffer pick (works on 3D Tiles, 3DGS, World Terrain)
    if (viewer.scene.pickPositionSupported) {
      const picked = viewer.scene.pickPosition(centerScreen);
      if (Cesium.defined(picked)) {
        return picked;
      }
    }

    // 2. Fallback to ray intersection on WGS84 ellipsoid
    const ray = viewer.camera.getPickRay(centerScreen);
    if (ray) {
      const hit = viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(centerScreen);
      if (Cesium.defined(hit)) {
        return hit;
      }
    }

    // 3. Fallback to first visible tileset bounding sphere center
    const visibleTs = activeTilesets.find((t) => t.visible && t.tileset?.boundingSphere?.center);
    if (visibleTs) {
      return Cesium.Cartesian3.clone(visibleTs.tileset.boundingSphere.center);
    }

    // 4. Fallback: point directly below camera on surface
    const c = viewer.camera.positionCartographic;
    if (c) {
      return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
    }
    return null;
  }

  function updateFlightModeButtons(): void {
    const statusLabel = el<HTMLSpanElement>('flight-mode-status');
    const names: Record<FlightMode, string> = {
      explore: 'Explore',
      wasd: 'WASD Pilot',
      orbit: '360° Orbit',
      tour: 'Touring',
    };
    if (statusLabel) statusLabel.textContent = names[flightMode];

    document.querySelectorAll<HTMLButtonElement>('.flight-mode-btn').forEach((btn) => {
      const m = btn.dataset.flightMode as FlightMode;
      btn.setAttribute('data-active', String(m === flightMode));
    });

    if (flightHudBanner && flightHudLabel && flightHudHint) {
      if (flightMode === 'wasd') {
        flightHudBanner.classList.remove('hidden');
        flightHudLabel.textContent = `WASD Pilot (${wasdSpeedMps} m/s)`;
        flightHudHint.textContent = 'W/A/S/D Move · Q/E Yaw · Space/Shift Alt · Arrows Tilt';
      } else if (flightMode === 'orbit') {
        flightHudBanner.classList.remove('hidden');
        flightHudLabel.textContent = `360° Survey Orbit (${orbitSpeedDegPerSec}°/s)`;
        flightHudHint.textContent = 'Click Explore or press Esc to release camera lock';
      } else if (flightMode === 'tour') {
        flightHudBanner.classList.remove('hidden');
        flightHudLabel.textContent = 'Bookmark Camera Tour';
        flightHudHint.textContent = 'Press Esc or click Explore to stop tour';
      } else {
        flightHudBanner.classList.add('hidden');
      }
    }
  }

  function setFlightMode(nextMode: FlightMode, autoStopRecOnOrbitLap = false): void {
    // Cleanup previous mode
    if (flightMode === 'orbit') {
      releaseCameraTransform();
    }
    if (flightMode === 'tour') {
      tourCancelled = true;
    }
    pressedKeys.clear();
    orbitAutoStopRec = false;

    if (nextMode === 'tour') {
      if (cameraBookmarks.length === 0) {
        showToast('Save at least 1 camera bookmark in Manifest tab first.', 'error');
        flightMode = 'explore';
        updateFlightModeButtons();
        return;
      }
      flightMode = 'tour';
      tourCancelled = false;
      updateFlightModeButtons();
      runBookmarkTour();
      return;
    }

    if (nextMode === 'orbit') {
      const target = pickViewportTarget();
      if (!target) {
        showToast('Zoom closer to a site or tileset to start a 360° orbit.', 'error');
        flightMode = 'explore';
        updateFlightModeButtons();
        return;
      }
      orbitTargetCartesian = target;
      const dist = Cesium.Cartesian3.distance(viewer.camera.positionWC, orbitTargetCartesian);
      orbitRangeMeters = Math.max(25, Math.min(dist, 25000));
      orbitHeadingRad = viewer.camera.heading;
      orbitPitchRad = Math.min(-Cesium.Math.toRadians(12), Math.max(-Cesium.Math.toRadians(80), viewer.camera.pitch));
      orbitAccumulatedDeg = 0;
      orbitAutoStopRec = autoStopRecOnOrbitLap;
      flightMode = 'orbit';
      updateFlightModeButtons();
      logEvent(`Locked 360° Survey Orbit (radius ${Math.round(orbitRangeMeters)}m).`, 'ok');
      return;
    }

    flightMode = nextMode;
    updateFlightModeButtons();
    if (nextMode === 'wasd') {
      logEvent('WASD Virtual Drone Pilot enabled.', 'info');
    }
  }

  async function runBookmarkTour(): Promise<void> {
    logEvent(`Starting camera tour across ${cameraBookmarks.length} saved views.`, 'info');
    for (let i = 0; i < cameraBookmarks.length; i++) {
      if (tourCancelled || flightMode !== 'tour') break;
      const bm = cameraBookmarks[i];
      await new Promise<void>((resolve) => {
        if (!viewer || tourCancelled) {
          resolve();
          return;
        }
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(bm.lon, bm.lat, bm.alt),
          orientation: {
            heading: Cesium.Math.toRadians(bm.heading || 0),
            pitch: Cesium.Math.toRadians(bm.pitch ?? -30),
            roll: Cesium.Math.toRadians(bm.roll || 0),
          },
          duration: 2.6,
          complete: () => window.setTimeout(resolve, 1200),
          cancel: () => resolve(),
        });
      });
    }
    if (!tourCancelled && flightMode === 'tour') {
      flightMode = 'explore';
      updateFlightModeButtons();
      logEvent('Camera bookmark tour completed.', 'ok');
      showToast('Bookmark tour finished.');
    }
  }

  function handlePreUpdate(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastPreUpdateTime) / 1000);
    lastPreUpdateTime = now;

    if (!viewer || !viewer.camera) return;

    if (flightMode === 'wasd' && pressedKeys.size > 0) {
      const moveStep = wasdSpeedMps * dt;
      const yawStep = Cesium.Math.toRadians(55) * dt;
      const pitchStep = Cesium.Math.toRadians(40) * dt;

      if (pressedKeys.has('KeyW')) viewer.camera.moveForward(moveStep);
      if (pressedKeys.has('KeyS')) viewer.camera.moveBackward(moveStep);
      if (pressedKeys.has('KeyA')) viewer.camera.moveLeft(moveStep);
      if (pressedKeys.has('KeyD')) viewer.camera.moveRight(moveStep);
      if (pressedKeys.has('Space') || pressedKeys.has('KeyR')) viewer.camera.moveUp(moveStep * 0.75);
      if (pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight') || pressedKeys.has('KeyF')) {
        viewer.camera.moveDown(moveStep * 0.75);
      }
      if (pressedKeys.has('KeyQ') || pressedKeys.has('ArrowLeft')) viewer.camera.lookLeft(yawStep);
      if (pressedKeys.has('KeyE') || pressedKeys.has('ArrowRight')) viewer.camera.lookRight(yawStep);
      if (pressedKeys.has('ArrowUp')) viewer.camera.lookUp(pitchStep);
      if (pressedKeys.has('ArrowDown')) viewer.camera.lookDown(pitchStep);
    } else if (flightMode === 'orbit' && orbitTargetCartesian) {
      const deltaDeg = orbitSpeedDegPerSec * dt;
      orbitHeadingRad += Cesium.Math.toRadians(deltaDeg);
      orbitAccumulatedDeg += deltaDeg;

      const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(orbitTargetCartesian);
      viewer.camera.lookAtTransform(
        enuTransform,
        new Cesium.HeadingPitchRange(orbitHeadingRad, orbitPitchRad, orbitRangeMeters)
      );

      if (orbitAutoStopRec && isRecording && orbitAccumulatedDeg >= 360) {
        orbitAutoStopRec = false;
        stopRecording();
        setFlightMode('explore');
        showToast('Completed 360° orbit clip!');
      }
    }
  }

  function formatTimer(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function updateRecordingUI(): void {
    const quickBtn = el<HTMLButtonElement>('btn-quick-record');
    const freeBtn = el<HTMLButtonElement>('btn-rec-free');

    if (recIndicator) recIndicator.classList.toggle('hidden', !isRecording);
    if (recModeText) recModeText.textContent = `REC · ${recordingModeLabel}`;

    if (quickBtn) {
      if (isRecording) {
        quickBtn.textContent = 'Stop Rec';
        quickBtn.className =
          'px-3 py-2 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer whitespace-nowrap';
      } else {
        quickBtn.textContent = 'Record';
        quickBtn.className =
          'px-3 py-2 rounded-xl text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer whitespace-nowrap';
      }
    }

    if (freeBtn) {
      freeBtn.textContent = isRecording ? 'Stop Recording' : 'Record Flight';
    }
  }

  function startRecording(modeLabel = 'Free Flight'): boolean {
    if (!viewer || !viewer.scene || !viewer.scene.canvas) return false;
    if (isRecording) {
      stopRecording();
      return false;
    }

    const canvas = viewer.scene.canvas as HTMLCanvasElement;
    if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      showToast('Browser does not support WebGL MediaRecorder capture.', 'error');
      return false;
    }

    try {
      const stream = canvas.captureStream(30);
      const mimeTypes = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const chosenMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(
        stream,
        chosenMime ? { mimeType: chosenMime, videoBitsPerSecond: 8_000_000 } : undefined
      );

      recordingModeLabel = modeLabel;
      recordingStartMs = performance.now();

      // Start logging the exact camera pose for every rendered frame
      cameraPathSamples = [];
      if (cameraPathRemove) cameraPathRemove();
      cameraPathRemove = viewer.scene.postRender.addEventListener(() => {
        if (!viewer) return;
        const cam = viewer.camera;
        const c = cam.positionCartographic;
        const fr: any = cam.frustum;
        cameraPathSamples.push({
          t: +((performance.now() - recordingStartMs) / 1000).toFixed(4),
          lon: Cesium.Math.toDegrees(c.longitude),
          lat: Cesium.Math.toDegrees(c.latitude),
          height: c.height,
          heading: Cesium.Math.toDegrees(cam.heading),
          pitch: Cesium.Math.toDegrees(cam.pitch),
          roll: Cesium.Math.toDegrees(cam.roll),
          fovyDeg: fr && fr.fovy ? Cesium.Math.toDegrees(fr.fovy) : null,
        });
      });

      mediaRecorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunks.push(ev.data);
        }
      };

      mediaRecorder.onstop = () => {
        // Stop the camera path log and attach it to the clip for download alongside WebM
        if (cameraPathRemove) { cameraPathRemove(); cameraPathRemove = null; }
        let cameraPath: { url: string; name: string } | undefined;
        try {
          const pathTitle = (el<HTMLInputElement>('input-site-title')?.value || 'nodrone').trim();
          const slug = pathTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nodrone';
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const cv = viewer?.scene?.canvas as HTMLCanvasElement | undefined;
          const pathDoc = {
            schema: 'nodrone-camera-path/1',
            site: pathTitle,
            mode: recordingModeLabel,
            recordedAt: new Date().toISOString(),
            canvas: cv ? { width: cv.width, height: cv.height } : null,
            heightReference: 'WGS84 ellipsoid (meters)',
            angleUnits: 'degrees',
            frameCount: cameraPathSamples.length,
            samples: cameraPathSamples,
          };
          const pathBlob = new Blob([JSON.stringify(pathDoc)], { type: 'application/json' });
          cameraPath = {
            url: URL.createObjectURL(pathBlob),
            name: `${slug}_camera-path_${stamp}.json`,
          };
          logEvent(`Camera path ready (${cameraPathSamples.length} frames) — saves with Download WebM.`, 'ok');
        } catch (e: any) {
          logEvent(`Camera path export failed: ${e?.message || e}`, 'error');
        }
        const durationSec = Math.max(1, Math.round((performance.now() - recordingStartMs) / 1000));
        const blob = new Blob(recordedChunks, { type: chosenMime || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const siteTitle = (el<HTMLInputElement>('input-site-title')?.value || 'SplatMap').trim();
        const clip: RecordedClip = {
          id: `clip-${Date.now()}`,
          name: `${siteTitle} · ${recordingModeLabel}`,
          url,
          blob,
          durationSec,
          mode: recordingModeLabel,
          createdAt: new Date().toTimeString().slice(0, 8),
          sizeMb: (blob.size / (1024 * 1024)).toFixed(2),
          ...(cameraPath ? { cameraPath } : {}),
        };
        recordedClips.unshift(clip);
        renderClipList();
        openClipModal(clip);
        logEvent(`Saved aerial clip (${clip.durationSec}s · ${clip.sizeMb} MB).`, 'ok');
      };

      mediaRecorder.start(250);
      isRecording = true;
      updateRecordingUI();

      if (recTimer) recTimer.textContent = '00:00';
      recordingTimerHandle = window.setInterval(() => {
        if (!isRecording) return;
        const elapsedSec = (performance.now() - recordingStartMs) / 1000;
        if (recTimer) recTimer.textContent = formatTimer(elapsedSec);
      }, 250);

      logEvent(`Started aerial WebM capture (${modeLabel}).`, 'info');
      return true;
    } catch (err: any) {
      logEvent(`Recording failed: ${err?.message || err}`, 'error');
      showToast('Could not start video recording.', 'error');
      return false;
    }
  }

  function stopRecording(): void {
    if (!isRecording) return;
    isRecording = false;
    if (recordingTimerHandle !== null) {
      window.clearInterval(recordingTimerHandle);
      recordingTimerHandle = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    updateRecordingUI();
  }

  function openClipModal(clip: RecordedClip): void {
    if (!clipModal || !clipModalVideo || !clipModalTitle || !clipModalMeta || !clipModalDownload) return;
    clipModalTitle.textContent = clip.name;
    clipModalMeta.textContent = `${clip.durationSec}s · ${clip.sizeMb} MB · Captured ${clip.createdAt}`;
    clipModalVideo.src = clip.url;
    clipModalDownload.href = clip.url;
    const safeName = clip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    clipModalDownload.download = `${safeName}.webm`;
    clipModalDownload.onclick = clip.cameraPath
      ? () => {
          const path = clip.cameraPath;
          if (!path) return;
          window.setTimeout(() => {
            const a = document.createElement('a');
            a.href = path.url;
            a.download = path.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, 300);
        }
      : null;
    clipModal.classList.remove('hidden');
  }

  function renderClipList(): void {
    if (!clipListEl) return;
    clipListEl.innerHTML = '';
    const countEl = el<HTMLSpanElement>('rec-clip-count');
    if (countEl) countEl.textContent = `${recordedClips.length} clip${recordedClips.length === 1 ? '' : 's'}`;

    if (recordedClips.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-[11px] text-zinc-500 italic';
      empty.textContent = 'No aerial video clips recorded yet.';
      clipListEl.appendChild(empty);
      return;
    }

    recordedClips.forEach((clip) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl px-2.5 py-2';

      const info = document.createElement('div');
      info.className = 'min-w-0';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'text-xs font-medium text-zinc-200 truncate';
      titleDiv.textContent = clip.name;
      const subDiv = document.createElement('div');
      subDiv.className = 'text-[10px] font-mono text-zinc-500 tabular-nums';
      subDiv.textContent = `${clip.durationSec}s · ${clip.sizeMb} MB · ${clip.createdAt}`;
      info.append(titleDiv, subDiv);

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1 shrink-0';

      const btnPlay = document.createElement('button');
      btnPlay.type = 'button';
      btnPlay.className = 'px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-medium text-zinc-200 transition-colors cursor-pointer';
      btnPlay.textContent = 'Play';
      btnPlay.addEventListener('click', () => openClipModal(clip));

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'px-2 py-1 rounded-lg bg-red-950/60 hover:bg-red-900/70 text-[10px] font-medium text-red-300 transition-colors cursor-pointer';
      btnDel.textContent = '×';
      btnDel.addEventListener('click', () => {
        URL.revokeObjectURL(clip.url);
        if (clip.cameraPath?.url) URL.revokeObjectURL(clip.cameraPath.url);
        recordedClips = recordedClips.filter((c) => c.id !== clip.id);
        renderClipList();
      });

      actions.append(btnPlay, btnDel);
      row.append(info, actions);
      clipListEl.appendChild(row);
    });
  }

  function formatEtaSeconds(totalSec: number): string {
    if (!Number.isFinite(totalSec) || totalSec < 0) return '--:--';
    const sec = Math.ceil(totalSec);
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function formatFileSizeMb(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderZipPartsUI(): void {
    if (!renderZipPartsList) return;
    renderZipPartsList.innerHTML = '';
    if (renderZipParts.length === 0) {
      renderZipPartsList.classList.add('hidden');
      return;
    }
    renderZipPartsList.classList.remove('hidden');

    for (const part of renderZipParts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition-colors cursor-pointer shadow-lg shadow-emerald-600/20';
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent =
        renderZipParts.length === 1
          ? `Download Render (${part.name})`
          : `Download ${part.name}`;
      const meta = document.createElement('span');
      meta.className = 'font-mono text-[10px] text-emerald-100/90 shrink-0 tabular-nums';
      meta.textContent = `f${part.frameStart}–${part.frameEnd} · ${formatFileSizeMb(part.sizeBytes)}`;
      btn.append(label, meta);
      btn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = part.url;
        a.download = part.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      renderZipPartsList.appendChild(btn);
    }
  }

  function clearRenderPathOverlay(): void {
    if (viewer?.entities) {
      for (const ent of renderPathEntities) {
        viewer.entities.remove(ent);
      }
    }
    renderPathEntities = [];
  }

  function renderLoadedPathOverlay(): void {
    clearRenderPathOverlay();
    if (!viewer?.entities || !loadedRenderPath || loadedRenderPath.samples.length === 0) return;

    const samples = loadedRenderPath.samples;
    const positions = samples.map((s) => Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height));
    const goldBright = Cesium.Color.fromCssColorString('#f3dc9f');
    const emerald = Cesium.Color.fromCssColorString('#34d399');

    if (positions.length >= 2) {
      renderPathEntities.push(
        viewer.entities.add({
          polyline: {
            positions,
            width: 2.5,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.18,
              color: goldBright.withAlpha(0.9),
            }),
            depthFailMaterial: goldBright.withAlpha(0.3),
          },
        })
      );
    }

    // Frame 1 START pin
    renderPathEntities.push(
      viewer.entities.add({
        position: positions[0],
        point: {
          pixelSize: 10,
          color: emerald,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `START · F1`,
          font: '600 10px "JetBrains Mono", monospace',
          fillColor: emerald,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    );

    if (positions.length >= 2) {
      renderPathEntities.push(
        viewer.entities.add({
          position: positions[positions.length - 1],
          point: {
            pixelSize: 8,
            color: goldBright,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `END · F${positions.length}`,
            font: '600 10px "JetBrains Mono", monospace',
            fillColor: goldBright,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      );
    }
  }

  function stopRenderPathPreview(): void {
    if (renderPathPreviewRaf !== null) {
      window.cancelAnimationFrame(renderPathPreviewRaf);
      renderPathPreviewRaf = null;
    }
    if (isPreviewingRenderPath) {
      isPreviewingRenderPath = false;
      updateRenderPathButtons();
    }
  }

  function flyToLoadedRenderPathStart(duration = 1.4): void {
    if (!viewer || !loadedRenderPath || loadedRenderPath.samples.length === 0) return;
    stopRenderPathPreview();
    if (flightMode !== 'explore') setFlightMode('explore');
    const first = loadedRenderPath.samples[0];
    const canvas = viewer.scene?.canvas as HTMLCanvasElement | undefined;
    if (
      typeof first.fovyDeg === 'number' &&
      Number.isFinite(first.fovyDeg) &&
      first.fovyDeg > 1 &&
      first.fovyDeg < 175 &&
      viewer.camera.frustum &&
      typeof viewer.camera.frustum.fov === 'number'
    ) {
      const w = canvas?.clientWidth || loadedRenderPath.resolution[0] || 1280;
      const h = canvas?.clientHeight || loadedRenderPath.resolution[1] || 720;
      viewer.camera.frustum.fov = computeAppliedFovRad(first.fovyDeg, w, h);
    }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(first.lon, first.lat, first.height),
      orientation: {
        heading: Cesium.Math.toRadians(first.heading),
        pitch: Cesium.Math.toRadians(first.pitch),
        roll: Cesium.Math.toRadians(first.roll),
      },
      duration,
    });
  }

  function toggleRenderPathPreview(): void {
    if (!viewer || !loadedRenderPath || loadedRenderPath.samples.length === 0 || isRenderingPath) return;
    if (isPreviewingRenderPath) {
      stopRenderPathPreview();
      showToast('Path preview stopped.');
      return;
    }

    const path = loadedRenderPath;
    if (flightMode !== 'explore') setFlightMode('explore');
    isPreviewingRenderPath = true;
    updateRenderPathButtons();

    const samples = path.samples;
    // Play orbital rigs (~8-25 frames) at a comfortable ~1.4 frames/sec so each angle is inspectable;
    // play dense flight/GES trajectories at their native fps.
    const playbackFps = samples.length <= 36 ? 1.5 : Math.max(10, Math.min(60, path.fps));
    const startMs = performance.now();
    const canvas = viewer.scene?.canvas as HTMLCanvasElement | undefined;

    const tick = (now: number) => {
      if (!isPreviewingRenderPath || !loadedRenderPath || loadedRenderPath !== path) {
        stopRenderPathPreview();
        return;
      }
      const elapsedSec = (now - startMs) / 1000;
      const idx = Math.floor(elapsedSec * playbackFps);
      if (idx >= samples.length) {
        stopRenderPathPreview();
        showToast(`Finished previewing ${samples.length} frames.`);
        return;
      }

      const s = samples[idx];
      if (
        typeof s.fovyDeg === 'number' &&
        Number.isFinite(s.fovyDeg) &&
        s.fovyDeg > 1 &&
        s.fovyDeg < 175 &&
        viewer.camera.frustum &&
        typeof viewer.camera.frustum.fov === 'number'
      ) {
        const w = canvas?.clientWidth || path.resolution[0] || 1280;
        const h = canvas?.clientHeight || path.resolution[1] || 720;
        viewer.camera.frustum.fov = computeAppliedFovRad(s.fovyDeg, w, h);
      }

      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height),
        orientation: {
          heading: Cesium.Math.toRadians(s.heading),
          pitch: Cesium.Math.toRadians(s.pitch),
          roll: Cesium.Math.toRadians(s.roll),
        },
      });
      renderPathPreviewRaf = window.requestAnimationFrame(tick);
    };

    showToast(`Previewing "${path.site}" (${samples.length} views)…`);
    renderPathPreviewRaf = window.requestAnimationFrame(tick);
  }

  function updateRenderPathButtons(): void {
    const btnJump = el<HTMLButtonElement>('btn-path-jump');
    const btnPreview = el<HTMLButtonElement>('btn-path-preview');
    if (btnRenderFrames) {
      btnRenderFrames.disabled = !loadedRenderPath || isRenderingPath;
    }
    if (btnJump) {
      btnJump.disabled = !loadedRenderPath || isRenderingPath;
    }
    if (btnPreview) {
      btnPreview.disabled = !loadedRenderPath || isRenderingPath;
      btnPreview.setAttribute('data-active', String(isPreviewingRenderPath));
      btnPreview.textContent = isPreviewingRenderPath ? 'Stop Preview' : 'Preview Path';
    }
    if (btnRenderToFolder) {
      if (supportsDirectoryPicker) {
        btnRenderToFolder.classList.remove('hidden');
        btnRenderToFolder.disabled = !loadedRenderPath || isRenderingPath;
      } else {
        btnRenderToFolder.classList.add('hidden');
      }
    }
    renderZipPartsUI();
  }

  function clearRenderZipParts(): void {
    for (const part of renderZipParts) {
      if (part.url) URL.revokeObjectURL(part.url);
    }
    renderZipParts = [];
    updateRenderPathButtons();
  }

  function finalizeLoadedRenderPath(
    path: LoadedRenderPath,
    badgePrefix: string,
    detailLog: string,
    toastText: string
  ): void {
    stopRenderPathPreview();
    loadedRenderPath = path;
    clearRenderZipParts();
    renderLoadedPathOverlay();

    if (renderPathStatusEl) {
      const prefix = badgePrefix ? `${badgePrefix} ` : '';
      renderPathStatusEl.textContent = `${prefix}${path.samples.length}f · ${path.resolution[0]}×${path.resolution[1]} · ${path.fps}fps`;
      renderPathStatusEl.className = 'font-mono text-emerald-300 tabular-nums truncate max-w-[190px]';
    }
    updateRenderPathButtons();
    flyToLoadedRenderPathStart(1.4);
    logEvent(detailLog, 'ok');
    showToast(toastText);
  }

  async function loadRenderPathFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const raw = JSON.parse(text);

      // Format 1: Google Earth Studio 3D Tracking Data JSON (`cameraFrames[]`)
      if (isGesTrackingJson(raw)) {
        const ges = convertGesTrackingJson(raw as Record<string, unknown>, {
          convention: 'opencv',
          useEllipsoidal: false,
        });
        finalizeLoadedRenderPath(
          {
            fileName: file.name,
            site: ges.name || el<HTMLInputElement>('input-site-title')?.value || 'ges-site',
            fps: ges.fps,
            resolution: [ges.width, ges.height],
            samples: ges.cesiumSamples,
          },
          'GES',
          `Loaded GES 3D Tracking "${file.name}" (${ges.cesiumSamples.length} frames @ ${ges.width}×${ges.height}, ${ges.fps} fps, Blender f=${ges.blenderFocalMm.toFixed(2)}mm) — flying to Frame 1.`,
          `Loaded GES path (${ges.cesiumSamples.length} frames) — flying to start`
        );
        return;
      }

      // Format 2: Splat Studio Bundle Manifest (`splatthat-bundle.json` with `captureRig.poses[]`)
      if (raw && Array.isArray(raw?.captureRig?.poses) && raw.captureRig.poses.length > 0) {
        const poses = raw.captureRig.poses as Array<Record<string, any>>;
        const samples: RenderPathSample[] = poses.map((p, idx) => {
          const lat = Number(p?.lat);
          const lon = Number(p?.lon);
          const height = Number(p?.height);
          const heading = Number(p?.heading ?? 0);
          const pitch = Number(p?.pitch ?? -35);
          const roll = Number(p?.roll ?? 0);
          if (![lat, lon, height, heading, pitch, roll].every((n) => Number.isFinite(n))) {
            throw new Error(`Bundle pose #${idx + 1} has invalid coordinates/angles.`);
          }
          const fovyDeg = Number.isFinite(Number(p?.fovyDeg)) ? Number(p.fovyDeg) : null;
          return { t: Number((idx / 30).toFixed(4)), lat, lon, height, heading, pitch, roll, fovyDeg };
        });
        const resArr = raw?.sceneContext?.resolution;
        const resW = Array.isArray(resArr) && Number(resArr[0]) >= 64 ? Math.round(Number(resArr[0])) : 1280;
        const resH = Array.isArray(resArr) && Number(resArr[1]) >= 64 ? Math.round(Number(resArr[1])) : 720;
        const site = String(raw?.asset?.name || file.name.replace(/\.json$/i, '')).trim();
        finalizeLoadedRenderPath(
          { fileName: file.name, site, fps: 30, resolution: [resW, resH], samples },
          'BUNDLE',
          `Loaded Splat Studio Bundle "${file.name}" (${samples.length} camera poses @ ${resW}×${resH}) — flying to View 1.`,
          `Loaded Studio Bundle (${samples.length} views) — flying to View 1`
        );
        return;
      }

      // Format 3: Flyover `camera_matrices.json` (`frames[]` with `c2w_enu_zup_rowmajor` + lat/lon/alt_asl_m)
      if (
        raw &&
        Array.isArray(raw.frames) &&
        raw.frames.length > 0 &&
        Array.isArray(raw.frames[0]?.c2w_enu_zup_rowmajor) &&
        typeof raw.frames[0]?.lat === 'number'
      ) {
        const frames = raw.frames as Array<Record<string, any>>;
        const samples: RenderPathSample[] = frames.map((fr, idx) => {
          const lat = Number(fr.lat);
          const lon = Number(fr.lon);
          const height = Number(fr.alt_asl_m ?? fr.height ?? 0);
          const hpr = c2wOpenCvToCesiumHPR(fr.c2w_enu_zup_rowmajor as number[]);
          const fovyDeg = Number.isFinite(Number(fr?.K?.fov_vertical_deg))
            ? Number(fr.K.fov_vertical_deg)
            : 40;
          return {
            t: Number.isFinite(Number(fr.time_s)) ? Number(fr.time_s) : Number((idx / 30).toFixed(4)),
            lat,
            lon,
            height,
            heading: hpr.heading,
            pitch: hpr.pitch,
            roll: hpr.roll,
            fovyDeg,
          };
        });
        const firstK = frames[0]?.K;
        const resW = Number.isFinite(Number(firstK?.width)) ? Math.round(Number(firstK.width)) : 1920;
        const resH = Number.isFinite(Number(firstK?.height)) ? Math.round(Number(firstK.height)) : 1080;
        const fps = Number.isFinite(Number(raw.fps)) && Number(raw.fps) > 0 ? Number(raw.fps) : 30;
        const site = String(raw.name || file.name.replace(/\.json$/i, '')).trim();
        finalizeLoadedRenderPath(
          { fileName: file.name, site, fps, resolution: [resW, resH], samples },
          'MAT',
          `Loaded camera_matrices.json "${file.name}" (${samples.length} frames @ ${resW}×${resH}, ${fps} fps) — flying to Frame 1.`,
          `Loaded camera matrices (${samples.length} frames) — flying to start`
        );
        return;
      }

      // Format 4: Native `nodrone-camera-path/1` (`camera-path.json`)
      if (!raw || raw.schema !== 'nodrone-camera-path/1') {
        throw new Error(
          'Unrecognized JSON. Pick camera-path.json, a Google Earth Studio .json, camera_matrices.json, or splatthat-bundle.json.'
        );
      }
      if (!Array.isArray(raw.samples) || raw.samples.length === 0) {
        throw new Error('Render path contains no samples.');
      }

      const samples: RenderPathSample[] = [];
      for (let i = 0; i < raw.samples.length; i++) {
        const s = raw.samples[i];
        const lat = Number(s?.lat);
        const lon = Number(s?.lon);
        const height = Number(s?.height);
        const heading = Number(s?.heading ?? 0);
        const pitch = Number(s?.pitch ?? -35);
        const roll = Number(s?.roll ?? 0);
        if (![lat, lon, height, heading, pitch, roll].every((n) => Number.isFinite(n))) {
          throw new Error(`Sample #${i + 1} has invalid numeric camera coordinates/angles.`);
        }
        const fovyRaw = s?.fovyDeg;
        const fovyDeg =
          fovyRaw !== null && fovyRaw !== undefined && Number.isFinite(Number(fovyRaw))
            ? Number(fovyRaw)
            : null;
        samples.push({
          t: Number.isFinite(Number(s?.t)) ? Number(s.t) : undefined,
          lat,
          lon,
          height,
          heading,
          pitch,
          roll,
          fovyDeg,
        });
      }

      let resW = 1920;
      let resH = 1080;
      const resSource = raw.render?.resolution ?? raw.resolution;
      if (Array.isArray(resSource) && resSource.length >= 2) {
        const w = Math.round(Number(resSource[0]));
        const h = Math.round(Number(resSource[1]));
        if (Number.isFinite(w) && Number.isFinite(h) && w >= 64 && h >= 64 && w <= 7680 && h <= 4320) {
          resW = w;
          resH = h;
        }
      }

      let fps = 30;
      const fpsSource = raw.render?.fps ?? raw.fps;
      if (Number.isFinite(Number(fpsSource)) && Number(fpsSource) > 0) {
        fps = Number(fpsSource);
      } else if (
        samples.length >= 2 &&
        typeof samples[0].t === 'number' &&
        typeof samples[samples.length - 1].t === 'number'
      ) {
        const dt = samples[samples.length - 1].t! - samples[0].t!;
        if (dt > 0) {
          fps = Math.max(1, Math.min(120, Math.round((samples.length - 1) / dt)));
        }
      }

      finalizeLoadedRenderPath(
        {
          fileName: file.name,
          site: String(raw.site || el<HTMLInputElement>('input-site-title')?.value || 'nodrone').trim(),
          fps,
          resolution: [resW, resH],
          samples,
        },
        '',
        `Loaded render path "${file.name}" (${samples.length} frames @ ${resW}×${resH}, ${fps} fps) — flying to Frame 1.`,
        `Path loaded (${samples.length} frames) — flying to start`
      );
    } catch (err: any) {
      logEvent(`Render path load failed: ${err?.message || err}`, 'error');
      showToast(`Invalid path JSON: ${err?.message || 'parse error'}`, 'error');
    }
  }

  function areAllRenderSceneTilesLoaded(): boolean {
    if (!viewer?.scene) return false;
    const globe = viewer.scene.globe;
    if (globe && globe.show !== false && globe.tilesLoaded !== true) {
      return false;
    }

    if (google3DTileset && google3DTileset.show !== false && google3DTileset.tilesLoaded !== true) {
      return false;
    }

    for (const item of activeTilesets) {
      if (item.visible && item.tileset && item.tileset.show !== false && item.tileset.tilesLoaded !== true) {
        return false;
      }
    }

    const primitives = viewer.scene.primitives;
    if (primitives && typeof primitives.length === 'number') {
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (p && p.show !== false && typeof p.tilesLoaded === 'boolean' && p.tilesLoaded !== true) {
          return false;
        }
      }
    }

    return true;
  }

  function waitForRenderFrameSettled(
    timeoutMs = 15000
  ): Promise<{ timedOut: boolean; waitMs: number; cancelled: boolean }> {
    return new Promise((resolve) => {
      const startMs = performance.now();
      let consecutiveReady = 0;

      const step = () => {
        if (renderPathCancelled) {
          resolve({ timedOut: false, waitMs: Math.round(performance.now() - startMs), cancelled: true });
          return;
        }
        try {
          viewer.scene.render();
        } catch {
          // ignore transient render warning and retry next rAF
        }

        if (areAllRenderSceneTilesLoaded()) {
          consecutiveReady += 1;
        } else {
          consecutiveReady = 0;
        }

        const elapsed = performance.now() - startMs;
        if (consecutiveReady >= 2) {
          resolve({ timedOut: false, waitMs: Math.round(elapsed), cancelled: false });
          return;
        }
        if (elapsed >= timeoutMs) {
          resolve({ timedOut: true, waitMs: Math.round(elapsed), cancelled: false });
          return;
        }
        window.requestAnimationFrame(step);
      };

      window.requestAnimationFrame(step);
    });
  }

  function captureCanvasJpegBlob(canvas: HTMLCanvasElement, quality = 0.95): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas JPEG capture returned null blob.'));
        },
        'image/jpeg',
        quality
      );
    });
  }

  function computeAppliedFovRad(fovyDeg: number, width: number, height: number): number {
    const fovyRad = Cesium.Math.toRadians(fovyDeg);
    const fov =
      width >= height
        ? 2 * Math.atan(Math.tan(fovyRad / 2) * (width / height))
        : fovyRad;
    return Math.max(0.01, Math.min(Math.PI - 0.01, fov));
  }

  function isImageCanvasDrawable(
    img: HTMLImageElement,
    cache: Map<string, boolean>
  ): boolean {
    const key = img.currentSrc || img.src;
    if (!key) return false;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      return false;
    }
    try {
      const probe = document.createElement('canvas');
      probe.width = 2;
      probe.height = 2;
      const pctx = probe.getContext('2d');
      if (!pctx) {
        cache.set(key, false);
        return false;
      }
      pctx.drawImage(img, 0, 0, 2, 2);
      probe.toDataURL();
      cache.set(key, true);
      return true;
    } catch {
      cache.set(key, false);
      return false;
    }
  }

  function compositeCreditsOntoFrame(
    ctx: CanvasRenderingContext2D,
    targetW: number,
    targetH: number,
    container: HTMLElement,
    logoSafetyCache: Map<string, boolean>
  ): void {
    const creditRoot =
      (viewer?.cesiumWidget?.creditContainer as HTMLElement | undefined) ||
      (container.querySelector('.cesium-widget-credits') as HTMLElement | null);

    const drawableLogos: HTMLImageElement[] = [];
    const textPieces: string[] = [];
    const seen = new Set<string>();
    const addText = (raw: string | null | undefined) => {
      const clean = (raw || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      if (/^data attribution$/i.test(clean)) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      textPieces.push(clean);
    };

    let hasGoogleLogoDrawn = false;

    if (creditRoot) {
      const imgs = creditRoot.querySelectorAll('img');
      imgs.forEach((img) => {
        const style = window.getComputedStyle(img);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const altOrTitle = (img.alt || img.title || '').trim();
        if (isImageCanvasDrawable(img, logoSafetyCache)) {
          drawableLogos.push(img);
          if (/google/i.test(altOrTitle) || /google/i.test(img.currentSrc || img.src)) {
            hasGoogleLogoDrawn = true;
          }
        } else if (altOrTitle) {
          addText(altOrTitle);
        }
      });

      const textContainer =
        (creditRoot.querySelector('.cesium-credit-textContainer') as HTMLElement | null) || creditRoot;
      const walker = document.createTreeWalker(textContainer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parentEl = node.parentElement;
        if (parentEl) {
          if (parentEl.closest('.cesium-credit-expand-link')) continue;
          const st = window.getComputedStyle(parentEl);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
        }
        const val = (node.textContent || '').replace(/^\s*•\s*|\s*•\s*$/g, '').trim();
        if (val && val !== '•' && val !== '|') {
          addText(val);
        }
      }
    }

    if (google3DTileset && google3DTileset.show !== false && !hasGoogleLogoDrawn) {
      const mentionsGoogle = textPieces.some((t) => /google/i.test(t));
      if (!mentionsGoogle) {
        textPieces.unshift('Google');
      }
    }
    if (drawableLogos.length === 0 && textPieces.length === 0) {
      textPieces.push('Cesium');
    }

    const fontSize = Math.max(11, Math.round(targetH * 0.0135));
    const logoMaxH = Math.max(16, Math.round(targetH * 0.022));
    const padX = Math.max(12, Math.round(targetW * 0.012));
    const padY = Math.max(10, Math.round(targetH * 0.012));
    const innerPadX = Math.max(8, Math.round(fontSize * 0.7));
    const innerPadY = Math.max(5, Math.round(fontSize * 0.4));
    const gap = Math.max(8, Math.round(fontSize * 0.65));

    ctx.save();
    ctx.font = `600 ${fontSize}px "Plus Jakarta Sans", system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';

    const logoDims = drawableLogos.map((img) => {
      const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
      const h = logoMaxH;
      const w = Math.round(h * ratio);
      return { img, w, h };
    });

    let totalLogosW = 0;
    for (const ld of logoDims) {
      totalLogosW += ld.w + gap;
    }

    const maxTextWidth = Math.max(160, targetW - padX * 2 - innerPadX * 2 - totalLogosW);
    let attributionText = textPieces.join(' · ');
    if (attributionText && ctx.measureText(attributionText).width > maxTextWidth) {
      while (attributionText.length > 8 && ctx.measureText(`${attributionText}…`).width > maxTextWidth) {
        attributionText = attributionText.slice(0, -1);
      }
      attributionText = `${attributionText.trimEnd()}…`;
    }

    const textW = attributionText ? Math.ceil(ctx.measureText(attributionText).width) : 0;
    const contentW =
      (totalLogosW > 0 ? totalLogosW - (textW > 0 ? 0 : gap) : 0) + textW;
    const contentH = Math.max(logoDims.length > 0 ? logoMaxH : 0, Math.ceil(fontSize * 1.25));
    const boxW = contentW + innerPadX * 2;
    const boxH = contentH + innerPadY * 2;
    const boxX = padX;
    const boxY = targetH - padY - boxH;

    // Subtle translucent dark backing so Cesium & Google credits remain legible on any terrain/sky
    ctx.fillStyle = 'rgba(9, 9, 11, 0.56)';
    ctx.beginPath();
    const r = Math.min(6, Math.round(boxH * 0.22));
    ctx.roundRect(boxX, boxY, boxW, boxH, r);
    ctx.fill();

    let cursorX = boxX + innerPadX;
    const centerY = boxY + boxH / 2;

    for (const ld of logoDims) {
      ctx.drawImage(ld.img, cursorX, Math.round(centerY - ld.h / 2), ld.w, ld.h);
      cursorX += ld.w + gap;
    }

    if (attributionText) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = 'rgba(244, 244, 245, 0.92)';
      ctx.fillText(attributionText, cursorX, centerY);
    }

    ctx.restore();
  }

  async function renderLoadedPathFrames(dirHandle?: any): Promise<void> {
    if (!viewer?.scene || !loadedRenderPath || isRenderingPath) return;
    if (isRecording) {
      showToast('Stop live recording before starting Render Frames.', 'error');
      return;
    }

    const path = loadedRenderPath;
    const total = path.samples.length;
    const [targetW, targetH] = path.resolution;
    const container = el<HTMLDivElement>('cesium-container');
    if (!container) return;

    stopRenderPathPreview();
    isRenderingPath = true;
    renderPathCancelled = false;
    clearRenderZipParts();
    renderPathEntities.forEach((ent) => {
      ent.show = false;
    });
    setMapLabelsTemporarilyHidden(true);
    updateRenderPathButtons();
    setFlightMode('explore');

    // Save camera, render loop, resolution settings, container/canvas styles, and HUD visibility
    const savedUseDefaultLoop = viewer.useDefaultRenderLoop;
    const savedUseBrowserRecommendedResolution = viewer.useBrowserRecommendedResolution;
    const savedResolutionScale = viewer.resolutionScale;
    const savedCameraPos = viewer.camera.position.clone();
    const savedHeading = viewer.camera.heading;
    const savedPitch = viewer.camera.pitch;
    const savedRoll = viewer.camera.roll;
    const savedFov =
      viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number'
        ? viewer.camera.frustum.fov
        : null;

    const canvas = viewer.scene.canvas as HTMLCanvasElement;
    const savedCanvasStyle = {
      width: canvas.style.width,
      height: canvas.style.height,
    };

    const savedContainerStyle = {
      position: container.style.position,
      top: container.style.top,
      left: container.style.left,
      right: container.style.right,
      bottom: container.style.bottom,
      width: container.style.width,
      height: container.style.height,
      minWidth: container.style.minWidth,
      minHeight: container.style.minHeight,
      maxWidth: container.style.maxWidth,
      maxHeight: container.style.maxHeight,
    };

    // Hide app HUD panels only — explicitly keep Cesium/Google credit container visible
    const hudElements = [
      document.querySelector('header') as HTMLElement | null,
      flightClusterGauge,
      boxDrawBanner,
      cardStage,
      summonGrid,
      spotlightTag,
      el<HTMLElement>('copilot-drawer'),
      flightHudBanner,
      recIndicator,
      document.querySelector('nav') as HTMLElement | null,
      el<HTMLElement>('btn-recall-hud'),
    ].filter((node): node is HTMLElement => Boolean(node));

    const savedHudDisplays = hudElements.map((node) => ({
      node,
      display: node.style.display,
    }));

    const updateProgressUI = (currentFrame: number, timeoutsCount: number, etaText: string) => {
      if (renderProgressText) {
        renderProgressText.textContent = `Rendering frame ${currentFrame} / ${total} · timeouts ${timeoutsCount} · ETA ${etaText}`;
      }
      if (renderProgressBar) {
        const pct = total > 0 ? Math.min(100, Math.round((currentFrame / total) * 100)) : 0;
        renderProgressBar.style.width = `${pct}%`;
      }
    };

    const startedAt = new Date().toISOString();
    const renderStartMs = performance.now();
    const perFrameWaitMs: number[] = [];
    const perFrameFovRad: number[] = [];
    const perFrameFovDeg: number[] = [];
    const chunkEntries: ZipEntryInput[] = [];
    let partIndex = 1;
    let chunkStartFrame = 1;
    let renderedFrames = 0;
    let timeouts = 0;
    let abortedWithError = false;

    const flushZipPart = (frameEnd: number, includeLogBytes?: Uint8Array<ArrayBuffer>) => {
      if (includeLogBytes) {
        chunkEntries.push({
          name: 'render-log.json',
          data: includeLogBytes,
        });
      }
      if (chunkEntries.length === 0) return;
      const partName = `render_part${String(partIndex).padStart(2, '0')}.zip`;
      const partBlob = buildStoreZipBlob(chunkEntries);
      renderZipParts.push({
        url: URL.createObjectURL(partBlob),
        name: partName,
        frameStart: chunkStartFrame,
        frameEnd,
        sizeBytes: partBlob.size,
      });
      // Release all raw frame buffers immediately after packing this part
      chunkEntries.length = 0;
      logEvent(
        `Packed ${partName} (frames ${chunkStartFrame}–${frameEnd}, ${formatFileSizeMb(partBlob.size)}).`,
        'info'
      );
      partIndex += 1;
      chunkStartFrame = frameEnd + 1;
      renderZipPartsUI();
    };

    try {
      // Hide app HUD panels and show floating progress/cancel bar (keep Cesium/Google credits visible)
      for (const { node } of savedHudDisplays) {
        node.style.display = 'none';
      }
      if (renderProgressOverlay) {
        renderProgressOverlay.classList.remove('hidden');
        renderProgressOverlay.classList.add('flex');
      }
      updateProgressUI(0, 0, '--:--');

      // Force output pixels to exact render.resolution regardless of devicePixelRatio
      const dpr = window.devicePixelRatio || 1;
      viewer.useDefaultRenderLoop = false;
      viewer.useBrowserRecommendedResolution = false;
      viewer.resolutionScale = 1 / dpr;

      container.style.position = 'fixed';
      container.style.top = '0px';
      container.style.left = '0px';
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.width = `${targetW}px`;
      container.style.height = `${targetH}px`;
      container.style.minWidth = `${targetW}px`;
      container.style.minHeight = `${targetH}px`;
      container.style.maxWidth = 'none';
      container.style.maxHeight = 'none';
      viewer.resize();

      // Wait one animation frame for DOM layout & Cesium canvas resize to take effect
      await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
      viewer.resize();

      // Explicitly pin canvas CSS and backing store dimensions to eliminate fractional DPR rounding drift
      canvas.style.width = `${targetW}px`;
      canvas.style.height = `${targetH}px`;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      if (viewer.camera.frustum && typeof viewer.camera.frustum.aspectRatio === 'number') {
        viewer.camera.frustum.aspectRatio = targetW / targetH;
      }

      // Assert exact output pixel dimensions before frame 1; abort with a clear error if mismatched
      const gl = viewer.scene?.context?._gl as WebGLRenderingContext | WebGL2RenderingContext | undefined;
      const drawingW = gl ? gl.drawingBufferWidth : canvas.width;
      const drawingH = gl ? gl.drawingBufferHeight : canvas.height;
      if (
        canvas.width !== targetW ||
        canvas.height !== targetH ||
        drawingW !== targetW ||
        drawingH !== targetH
      ) {
        throw new Error(
          `Canvas resolution mismatch before frame 1: expected ${targetW}×${targetH}, got canvas ${canvas.width}×${canvas.height} (WebGL buffer ${drawingW}×${drawingH}, dpr=${dpr}). Aborting render.`
        );
      }

      // Reusable 1:1 offscreen 2D canvas for compositing Cesium/Google attribution onto captured frames
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = targetW;
      outputCanvas.height = targetH;
      const outputCtx = outputCanvas.getContext('2d');
      const logoSafetyCache = new Map<string, boolean>();

      const modeLabel = dirHandle ? 'folder' : `zip parts (${RENDER_ZIP_PART_FRAMES}f/part)`;
      logEvent(
        `Starting offline render (${total} frames @ ${targetW}×${targetH}, ${path.fps} fps, ${modeLabel})...`,
        'info'
      );

      for (let i = 0; i < total; i++) {
        if (renderPathCancelled) break;
        const s = path.samples[i];

        // Exact camera placement: no flyTo, no animation
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height),
          orientation: {
            heading: Cesium.Math.toRadians(s.heading),
            pitch: Cesium.Math.toRadians(s.pitch),
            roll: Cesium.Math.toRadians(s.roll),
          },
        });

        if (viewer.camera.frustum && typeof viewer.camera.frustum.aspectRatio === 'number') {
          viewer.camera.frustum.aspectRatio = targetW / targetH;
        }

        // Cesium PerspectiveFrustum.fovy is read-only; set frustum.fov instead
        if (
          typeof s.fovyDeg === 'number' &&
          Number.isFinite(s.fovyDeg) &&
          s.fovyDeg > 1 &&
          s.fovyDeg < 175 &&
          viewer.camera.frustum &&
          typeof viewer.camera.frustum.fov === 'number'
        ) {
          viewer.camera.frustum.fov = computeAppliedFovRad(s.fovyDeg, targetW, targetH);
        }

        const appliedFov =
          viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number'
            ? Number(viewer.camera.frustum.fov)
            : NaN;

        const avgMs = i > 0 ? (performance.now() - renderStartMs) / i : NaN;
        const etaBefore = Number.isFinite(avgMs) ? formatEtaSeconds(((total - i) * avgMs) / 1000) : '--:--';
        updateProgressUI(i + 1, timeouts, etaBefore);

        const settle = await waitForRenderFrameSettled(15000);
        if (settle.cancelled || renderPathCancelled) break;
        if (settle.timedOut) timeouts += 1;
        perFrameWaitMs.push(settle.waitMs);
        perFrameFovRad.push(Number.isFinite(appliedFov) ? Number(appliedFov.toFixed(6)) : 0);
        perFrameFovDeg.push(
          Number.isFinite(appliedFov) ? Number(Cesium.Math.toDegrees(appliedFov).toFixed(3)) : 0
        );

        // Final render immediately before reading WebGL backbuffer
        viewer.scene.render();

        let jpegBlob: Blob;
        if (outputCtx) {
          outputCtx.clearRect(0, 0, targetW, targetH);
          outputCtx.drawImage(canvas, 0, 0, targetW, targetH);
          compositeCreditsOntoFrame(outputCtx, targetW, targetH, container, logoSafetyCache);
          try {
            jpegBlob = await captureCanvasJpegBlob(outputCanvas, 0.95);
          } catch {
            jpegBlob = await captureCanvasJpegBlob(canvas, 0.95);
          }
        } else {
          jpegBlob = await captureCanvasJpegBlob(canvas, 0.95);
        }

        const frameNum = String(i + 1).padStart(5, '0');
        const frameFileName = `frame_${frameNum}.jpg`;

        if (dirHandle) {
          // Stream each frame straight to disk without holding blobs in memory
          const fileHandle = await dirHandle.getFileHandle(frameFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(jpegBlob);
          await writable.close();
        } else {
          const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
          chunkEntries.push({
            name: frameFileName,
            data: jpegBytes,
          });
          // Flush a zip part every 300 frames and release raw frame buffers
          if (chunkEntries.length >= RENDER_ZIP_PART_FRAMES && i < total - 1) {
            flushZipPart(i + 1);
          }
        }

        renderedFrames += 1;

        const avgAfterMs = (performance.now() - renderStartMs) / renderedFrames;
        const remainingFrames = total - renderedFrames;
        const etaAfter = remainingFrames > 0 ? formatEtaSeconds((remainingFrames * avgAfterMs) / 1000) : '00:00';
        updateProgressUI(renderedFrames, timeouts, etaAfter);
      }
    } catch (err: any) {
      abortedWithError = true;
      chunkEntries.length = 0;
      logEvent(`Render Path error: ${err?.message || err}`, 'error');
      showToast(`Render aborted: ${err?.message || 'unknown error'}`, 'error');
    } finally {
      // Restore canvas & container dimensions, pixel scale, render loop, camera, and HUD panels
      canvas.style.width = savedCanvasStyle.width;
      canvas.style.height = savedCanvasStyle.height;

      container.style.position = savedContainerStyle.position;
      container.style.top = savedContainerStyle.top;
      container.style.left = savedContainerStyle.left;
      container.style.right = savedContainerStyle.right;
      container.style.bottom = savedContainerStyle.bottom;
      container.style.width = savedContainerStyle.width;
      container.style.height = savedContainerStyle.height;
      container.style.minWidth = savedContainerStyle.minWidth;
      container.style.minHeight = savedContainerStyle.minHeight;
      container.style.maxWidth = savedContainerStyle.maxWidth;
      container.style.maxHeight = savedContainerStyle.maxHeight;

      viewer.useBrowserRecommendedResolution = savedUseBrowserRecommendedResolution;
      viewer.resolutionScale = savedResolutionScale;
      viewer.resize();

      viewer.camera.setView({
        destination: savedCameraPos,
        orientation: {
          heading: savedHeading,
          pitch: savedPitch,
          roll: savedRoll,
        },
      });
      if (savedFov !== null && viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number') {
        viewer.camera.frustum.fov = savedFov;
      }

      viewer.useDefaultRenderLoop = savedUseDefaultLoop;
      viewer.scene.render();

      for (const { node, display } of savedHudDisplays) {
        node.style.display = display;
      }
      if (renderProgressOverlay) {
        renderProgressOverlay.classList.add('hidden');
        renderProgressOverlay.classList.remove('flex');
      }
      renderPathEntities.forEach((ent) => {
        ent.show = true;
      });
      setMapLabelsTemporarilyHidden(false);
      isRenderingPath = false;
    }

    if (abortedWithError) {
      updateRenderPathButtons();
      return;
    }

    if (renderPathCancelled) {
      chunkEntries.length = 0;
      updateRenderPathButtons();
      logEvent(`Render cancelled after ${renderedFrames} / ${total} frames.`, 'warn');
      showToast('Render cancelled.');
      return;
    }

    if (renderedFrames > 0) {
      const finishedAt = new Date().toISOString();
      const firstFovRad = perFrameFovRad.length > 0 ? perFrameFovRad[0] : null;
      const firstFovDeg = perFrameFovDeg.length > 0 ? perFrameFovDeg[0] : null;
      const renderLog = {
        frameCount: renderedFrames,
        fps: path.fps,
        resolution: path.resolution,
        timeouts,
        fovRad: firstFovRad,
        fovDeg: firstFovDeg,
        perFrameFovRad,
        perFrameFovDeg,
        perFrameWaitMs,
        startedAt,
        finishedAt,
        outputMode: dirHandle ? 'folder' : 'zip-parts',
      };
      const logJson = JSON.stringify(renderLog, null, 2);

      if (dirHandle) {
        try {
          const logHandle = await dirHandle.getFileHandle('render-log.json', { create: true });
          const writable = await logHandle.createWritable();
          await writable.write(logJson);
          await writable.close();
        } catch (err: any) {
          logEvent(`Failed to write render-log.json to folder: ${err?.message || err}`, 'error');
        }
        updateRenderPathButtons();
        if (renderPathStatusEl) {
          renderPathStatusEl.textContent = `Saved · ${renderedFrames}f · ${timeouts} timeout${timeouts === 1 ? '' : 's'}`;
          renderPathStatusEl.className = 'font-mono text-emerald-300 tabular-nums truncate max-w-[170px]';
        }
        logEvent(`Render complete: ${renderedFrames} frames, ${timeouts} timeouts.`, 'ok');
        showToast(`Render complete (${renderedFrames} frames saved to folder).`);
      } else {
        const logBytes = new TextEncoder().encode(logJson);
        const logBuf = new Uint8Array(new ArrayBuffer(logBytes.byteLength));
        logBuf.set(logBytes);
        flushZipPart(renderedFrames, logBuf);
        updateRenderPathButtons();
        if (renderPathStatusEl) {
          const partsLabel = renderZipParts.length > 1 ? ` · ${renderZipParts.length} parts` : '';
          renderPathStatusEl.textContent = `Ready · ${renderedFrames}f${partsLabel} · ${timeouts}t`;
          renderPathStatusEl.className = 'font-mono text-emerald-300 tabular-nums truncate max-w-[170px]';
        }
        logEvent(`Render complete: ${renderedFrames} frames, ${timeouts} timeouts.`, 'ok');
        showToast(
          renderZipParts.length > 1
            ? `Render complete (${renderedFrames} frames in ${renderZipParts.length} zip parts).`
            : `Render complete (${renderedFrames} frames). Click Download Render.`
        );
      }
    } else {
      updateRenderPathButtons();
    }
  }

  function capturePngSnapshot(): boolean {
    if (!viewer || !viewer.scene) return false;
    try {
      viewer.render();
      const dataUrl = viewer.scene.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const siteTitle = (el<HTMLInputElement>('input-site-title')?.value || 'nodrone-view')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      a.href = dataUrl;
      a.download = `${siteTitle}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      logEvent('Exported high-resolution viewport snapshot (PNG).', 'ok');
      showToast('Snapshot PNG downloaded.');
      return true;
    } catch (err: any) {
      logEvent(`Snapshot failed: ${err?.message || err}`, 'error');
      showToast('Snapshot blocked by cross-origin imagery.', 'error');
      return false;
    }
  }

  // 3D Surface Measurement Tools
  function clearMeasurements(): void {
    if (viewer && viewer.entities) {
      measureEntities.forEach((ent) => viewer.entities.remove(ent));
    }
    measureEntities = [];
    measurePositions = [];
    setMeasureMode('off');
    const readout = el<HTMLDivElement>('measure-readout');
    if (readout) readout.classList.add('hidden');
  }

  function computeLocalPlanarAreaSqMeters(positions: any[]): number {
    if (positions.length < 3) return 0;
    const origin = positions[0];
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const invEnu = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());

    const pts2d = positions.map((p) => {
      const local = Cesium.Matrix4.multiplyByPoint(invEnu, p, new Cesium.Cartesian3());
      return { x: local.x, y: local.y };
    });

    let sum = 0;
    for (let i = 0; i < pts2d.length; i++) {
      const a = pts2d[i];
      const b = pts2d[(i + 1) % pts2d.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) * 0.5;
  }

  function updateMeasurementGraphics(): void {
    if (!viewer) return;
    measureEntities.forEach((ent) => viewer.entities.remove(ent));
    measureEntities = [];

    measurePositions.forEach((pos) => {
      measureEntities.push(
        viewer.entities.add({
          position: pos,
          point: {
            pixelSize: 7,
            color: Cesium.Color.fromCssColorString('#818cf8'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      );
    });

    const primaryEl = el<HTMLDivElement>('measure-primary');
    const secondaryEl = el<HTMLDivElement>('measure-secondary');
    const readout = el<HTMLDivElement>('measure-readout');
    if (readout) readout.classList.remove('hidden');

    if (measureMode === 'distance') {
      if (measurePositions.length >= 2) {
        measureEntities.push(
          viewer.entities.add({
            polyline: {
              positions: measurePositions,
              width: 3,
              material: Cesium.Color.fromCssColorString('#818cf8'),
              depthFailMaterial: Cesium.Color.fromCssColorString('#818cf8').withAlpha(0.5),
            },
          })
        );
        let totalMeters = 0;
        for (let i = 1; i < measurePositions.length; i++) {
          totalMeters += Cesium.Cartesian3.distance(measurePositions[i - 1], measurePositions[i]);
        }
        const totalFeet = totalMeters * 3.28084;
        if (primaryEl) primaryEl.textContent = `${totalMeters.toFixed(2)} m  (${totalFeet.toFixed(1)} ft)`;
        if (secondaryEl) secondaryEl.textContent = `${measurePositions.length} vertices · Right-click to finish`;
      } else {
        if (primaryEl) primaryEl.textContent = 'Select next point...';
        if (secondaryEl) secondaryEl.textContent = 'Click 2+ points on the 3D globe or tileset.';
      }
    } else if (measureMode === 'area') {
      if (measurePositions.length >= 3) {
        measureEntities.push(
          viewer.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(measurePositions),
              material: Cesium.Color.fromCssColorString('#6366f1').withAlpha(0.32),
              outline: true,
              outlineColor: Cesium.Color.fromCssColorString('#a5b4fc'),
              perPositionHeight: true,
            },
          })
        );
        const sqMeters = computeLocalPlanarAreaSqMeters(measurePositions);
        const sqFeet = sqMeters * 10.7639;
        if (primaryEl) {
          primaryEl.textContent = `${sqMeters.toFixed(1)} m²  (${Math.round(sqFeet).toLocaleString()} sq ft)`;
        }
        if (secondaryEl) secondaryEl.textContent = `${measurePositions.length} corners · Right-click to finish`;
      } else {
        if (primaryEl) primaryEl.textContent = `Select ${3 - measurePositions.length} more point(s)...`;
        if (secondaryEl) secondaryEl.textContent = 'Click 3+ corners on a roof, site, or terrain.';
      }
    }
  }

  function setMeasureMode(mode: MeasureMode): void {
    measureMode = mode;
    const statusEl = el<HTMLSpanElement>('measure-status');
    const btnDist = el<HTMLButtonElement>('btn-measure-distance');
    const btnArea = el<HTMLButtonElement>('btn-measure-area');

    if (statusEl) {
      statusEl.textContent = mode === 'off' ? 'Idle' : mode === 'distance' ? 'Distance' : 'Area';
      statusEl.className =
        mode === 'off' ? 'text-[10px] font-mono text-slate-400' : 'text-[10px] font-mono text-[#e7cb88]';
    }

    if (btnDist) btnDist.setAttribute('data-active', String(mode === 'distance'));
    if (btnArea) btnArea.setAttribute('data-active', String(mode === 'area'));

    if (measureHandler) {
      measureHandler.destroy();
      measureHandler = null;
    }

    if (mode !== 'off' && viewer) {
      measurePositions = [];
      measureHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      measureHandler.setInputAction((click: any) => {
        let cartesian = viewer.scene.pickPositionSupported
          ? viewer.scene.pickPosition(click.position)
          : undefined;
        if (!Cesium.defined(cartesian)) {
          const ray = viewer.camera.getPickRay(click.position);
          cartesian =
            (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ||
            viewer.camera.pickEllipsoid(click.position);
        }
        if (Cesium.defined(cartesian)) {
          measurePositions.push(cartesian);
          updateMeasurementGraphics();
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      measureHandler.setInputAction(() => {
        setMeasureMode('off');
        logEvent('3D measurement locked.', 'ok');
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

      const readout = el<HTMLDivElement>('measure-readout');
      const primaryEl = el<HTMLDivElement>('measure-primary');
      const secondaryEl = el<HTMLDivElement>('measure-secondary');
      if (readout) readout.classList.remove('hidden');
      if (primaryEl) primaryEl.textContent = mode === 'distance' ? 'Click start point...' : 'Click first corner...';
      if (secondaryEl) secondaryEl.textContent = 'Left-click points on the 3D scene · Right-click to finish.';
      logEvent(`3D ${mode} measurement tool active.`, 'info');
    }
  }

  // =========================================================================
  // Geo-Coordinate Draw Box & Splat Studio Multi-Angle Capture Engine
  // =========================================================================

  function pickGeoSurfacePoint(windowPos: any): { lat: number; lon: number; height: number } | null {
    if (!viewer) return null;
    let cartesian = viewer.scene.pickPositionSupported
      ? viewer.scene.pickPosition(windowPos)
      : undefined;
    if (!Cesium.defined(cartesian)) {
      const ray = viewer.camera.getPickRay(windowPos);
      cartesian =
        (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ||
        viewer.camera.pickEllipsoid(windowPos);
    }
    if (!Cesium.defined(cartesian)) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      height: Number.isFinite(carto.height) ? carto.height : 0,
    };
  }

  function computeGeoBoxMetrics(box: GeoDrawBoxState): GeoDrawBoxSnapshot {
    const centerLat = (box.south + box.north) * 0.5;
    const centerLon = (box.west + box.east) * 0.5;
    const baseEllipsoidalMeters = box.surfaceBaseMeters + box.baseOffsetMeters;
    const origin = {
      lat: round7(centerLat),
      lon: round7(centerLon),
      alt: baseEllipsoidalMeters,
    };
    const swEnu = wgs84ToEnuEllipsoidal(box.south, box.west, baseEllipsoidalMeters, origin);
    const neEnu = wgs84ToEnuEllipsoidal(box.north, box.east, baseEllipsoidalMeters, origin);
    const widthMeters = Math.max(0.1, Math.abs(neEnu[0] - swEnu[0]));
    const depthMeters = Math.max(0.1, Math.abs(neEnu[1] - swEnu[1]));
    const ceilingEllipsoidalMeters = baseEllipsoidalMeters + box.heightMeters;
    return {
      name: box.name.trim() || 'Site Asset Mesh',
      south: Number(box.south.toFixed(6)),
      north: Number(box.north.toFixed(6)),
      west: Number(box.west.toFixed(6)),
      east: Number(box.east.toFixed(6)),
      centerLat: Number(centerLat.toFixed(6)),
      centerLon: Number(centerLon.toFixed(6)),
      baseEllipsoidalMeters: Number(baseEllipsoidalMeters.toFixed(2)),
      baseOffsetMeters: Number(box.baseOffsetMeters.toFixed(2)),
      heightMeters: Number(box.heightMeters.toFixed(2)),
      ceilingEllipsoidalMeters: Number(ceilingEllipsoidalMeters.toFixed(2)),
      widthMeters: Number(widthMeters.toFixed(2)),
      depthMeters: Number(depthMeters.toFixed(2)),
      areaSqMeters: Number((widthMeters * depthMeters).toFixed(1)),
      captureViews: geoBoxCaptureViews,
      visible: box.visible,
    };
  }

  function clearGeoBoxEntities(list: any[]): void {
    if (viewer?.entities) {
      list.forEach((ent) => viewer.entities.remove(ent));
    }
    list.length = 0;
  }

  function renderGeoBoxVolume(
    south: number,
    north: number,
    west: number,
    east: number,
    baseAlt: number,
    ceilingAlt: number,
    targetList: any[],
    options: { interactive: boolean; show: boolean; labelText?: string }
  ): void {
    clearGeoBoxEntities(targetList);
    if (!viewer?.entities || !options.show) return;

    const goldBright = Cesium.Color.fromCssColorString('#f3dc9f');
    const goldMid = Cesium.Color.fromCssColorString('#d4af63');
    const fillAlpha = options.interactive ? 0.14 : 0.1;

    const baseCorners = [
      Cesium.Cartesian3.fromDegrees(west, south, baseAlt),
      Cesium.Cartesian3.fromDegrees(east, south, baseAlt),
      Cesium.Cartesian3.fromDegrees(east, north, baseAlt),
      Cesium.Cartesian3.fromDegrees(west, north, baseAlt),
    ];
    const topCorners = [
      Cesium.Cartesian3.fromDegrees(west, south, ceilingAlt),
      Cesium.Cartesian3.fromDegrees(east, south, ceilingAlt),
      Cesium.Cartesian3.fromDegrees(east, north, ceilingAlt),
      Cesium.Cartesian3.fromDegrees(west, north, ceilingAlt),
    ];

    // Translucent 3D extruded bounding volume
    targetList.push(
      viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(baseCorners),
          height: baseAlt,
          extrudedHeight: ceilingAlt,
          material: goldMid.withAlpha(fillAlpha),
          outline: true,
          outlineColor: goldBright.withAlpha(0.82),
          outlineWidth: 1.5,
        },
      })
    );

    // Crisp top perimeter ring
    targetList.push(
      viewer.entities.add({
        polyline: {
          positions: [...topCorners, topCorners[0]],
          width: 2.2,
          material: goldBright,
          depthFailMaterial: goldBright.withAlpha(0.35),
        },
      })
    );

    // Crisp base perimeter ring
    targetList.push(
      viewer.entities.add({
        polyline: {
          positions: [...baseCorners, baseCorners[0]],
          width: 1.8,
          material: goldMid.withAlpha(0.85),
          depthFailMaterial: goldMid.withAlpha(0.3),
        },
      })
    );

    // 4 vertical corner pillars
    for (let i = 0; i < 4; i++) {
      targetList.push(
        viewer.entities.add({
          polyline: {
            positions: [baseCorners[i], topCorners[i]],
            width: 1.6,
            material: goldBright.withAlpha(0.75),
            depthFailMaterial: goldMid.withAlpha(0.28),
          },
        })
      );
    }

    // Interactive corner drag handles (SW, SE, NE, NW) + vertical pull handles (TOP, BASE)
    if (options.interactive) {
      const centerLat = (south + north) * 0.5;
      const centerLon = (west + east) * 0.5;
      const baseCenterPos = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, baseAlt);
      const topCenterPos = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, ceilingAlt);
      const skyCyan = Cesium.Color.fromCssColorString('#7dd3fc');
      const warmAmber = Cesium.Color.fromCssColorString('#fbbf24');

      // Subtle vertical elevation spine connecting BASE and TOP handles
      targetList.push(
        viewer.entities.add({
          polyline: {
            positions: [baseCenterPos, topCenterPos],
            width: 1.5,
            material: new Cesium.PolylineDashMaterialProperty({
              color: skyCyan.withAlpha(0.75),
              dashLength: 10,
            }),
            depthFailMaterial: skyCyan.withAlpha(0.25),
          },
        })
      );

      // Vertical Ceiling pull handle (↕ TOP)
      targetList.push(
        viewer.entities.add({
          position: topCenterPos,
          properties: { geoBoxCorner: 'top' },
          point: {
            pixelSize: 13,
            color: skyCyan,
            outlineColor: Cesium.Color.fromCssColorString('#0b0f17'),
            outlineWidth: 2.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: options.labelText ? `↕ TOP · ${options.labelText}` : '↕ TOP',
            font: '600 11px "JetBrains Mono", monospace',
            fillColor: Cesium.Color.fromCssColorString('#e0f2fe'),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0b0f17').withAlpha(0.84),
            backgroundPadding: new Cesium.Cartesian2(8, 4),
            pixelOffset: new Cesium.Cartesian2(0, -18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      );

      // Vertical Base Offset pull handle (↕ BASE)
      targetList.push(
        viewer.entities.add({
          position: baseCenterPos,
          properties: { geoBoxCorner: 'base' },
          point: {
            pixelSize: 11,
            color: warmAmber,
            outlineColor: Cesium.Color.fromCssColorString('#0b0f17'),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: '↕ BASE',
            font: '600 10px "JetBrains Mono", monospace',
            fillColor: warmAmber,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, 16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      );

      const cornerDefs: Array<{ key: 'sw' | 'se' | 'ne' | 'nw'; label: string; pos: any }> = [
        { key: 'sw', label: 'SW', pos: topCorners[0] },
        { key: 'se', label: 'SE', pos: topCorners[1] },
        { key: 'ne', label: 'NE', pos: topCorners[2] },
        { key: 'nw', label: 'NW', pos: topCorners[3] },
      ];
      for (const c of cornerDefs) {
        targetList.push(
          viewer.entities.add({
            position: c.pos,
            properties: { geoBoxCorner: c.key },
            point: {
              pixelSize: 11,
              color: goldBright,
              outlineColor: Cesium.Color.fromCssColorString('#0b0f17'),
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: c.label,
              font: '600 10px "JetBrains Mono", monospace',
              fillColor: goldBright,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          })
        );
      }
    }
  }

  function syncGeoBoxUI(): void {
    const statusEl = el<HTMLSpanElement>('box-status');
    const dimEl = el<HTMLDivElement>('box-dim-readout');
    const areaEl = el<HTMLDivElement>('box-area-readout');
    const altEl = el<HTMLDivElement>('box-alt-readout');
    const centerEl = el<HTMLDivElement>('box-center-readout');
    const inpSouth = el<HTMLInputElement>('input-box-south');
    const inpNorth = el<HTMLInputElement>('input-box-north');
    const inpWest = el<HTMLInputElement>('input-box-west');
    const inpEast = el<HTMLInputElement>('input-box-east');
    const inpName = el<HTMLInputElement>('input-box-name');
    const sliderBase = el<HTMLInputElement>('slider-box-base');
    const sliderHeight = el<HTMLInputElement>('slider-box-height');
    const valBase = el<HTMLSpanElement>('val-box-base');
    const valHeight = el<HTMLSpanElement>('val-box-height');
    const btnDraw = el<HTMLButtonElement>('btn-box-draw');
    const btnVis = el<HTMLButtonElement>('btn-box-visible');
    const btnFrame = el<HTMLButtonElement>('btn-box-frame');
    const btnClear = el<HTMLButtonElement>('btn-box-clear');
    const btnBundle = el<HTMLButtonElement>('btn-box-capture-bundle');
    const btnJson = el<HTMLButtonElement>('btn-box-export-json');
    const btnGeoJson = el<HTMLButtonElement>('btn-box-export-geojson');
    const btnCopy = el<HTMLButtonElement>('btn-box-copy-coords');
    const valViews = el<HTMLSpanElement>('val-box-views');

    if (valViews) valViews.textContent = `${geoBoxCaptureViews} views + nadir`;
    document.querySelectorAll<HTMLButtonElement>('.box-views-btn').forEach((btn) => {
      const v = Number(btn.dataset.boxViews || 12);
      btn.setAttribute('data-active', String(v === geoBoxCaptureViews));
    });

    if (btnDraw) {
      btnDraw.setAttribute('data-active', String(geoBoxDrawing));
      btnDraw.textContent = geoBoxDrawing ? 'Drawing…' : 'Draw on Globe';
    }

    const hasBox = geoBox !== null;
    [btnVis, btnFrame, btnClear, btnJson, btnGeoJson, btnCopy].forEach((b) => {
      if (b) b.disabled = !hasBox;
    });
    if (btnBundle) {
      btnBundle.disabled = !hasBox || isCapturingGeoBox || isRenderingPath || isRecording;
    }

    if (!geoBox) {
      if (statusEl) {
        statusEl.textContent = geoBoxDrawing ? 'Picking corners…' : 'No box';
        statusEl.className = geoBoxDrawing
          ? 'text-[11px] font-mono text-[#e7cb88] truncate'
          : 'text-[11px] font-mono text-slate-400 truncate';
      }
      if (dimEl) dimEl.textContent = '-- × -- m';
      if (areaEl) areaEl.textContent = '-- m²';
      if (altEl) altEl.textContent = '-- → -- m';
      if (centerEl) centerEl.textContent = '--°, --°';
      if (inpSouth && document.activeElement !== inpSouth) inpSouth.value = '';
      if (inpNorth && document.activeElement !== inpNorth) inpNorth.value = '';
      if (inpWest && document.activeElement !== inpWest) inpWest.value = '';
      if (inpEast && document.activeElement !== inpEast) inpEast.value = '';
      if (btnVis) {
        btnVis.textContent = 'Visible';
        btnVis.setAttribute('data-active', 'true');
      }
      return;
    }

    const m = computeGeoBoxMetrics(geoBox);
    if (statusEl) {
      statusEl.textContent = geoBoxDrawing ? 'Redrawing…' : 'Locked';
      statusEl.className = 'text-[11px] font-mono text-emerald-300 truncate';
    }
    if (dimEl) dimEl.textContent = `${m.widthMeters.toFixed(1)} × ${m.depthMeters.toFixed(1)} m`;
    if (areaEl) {
      const sqFt = Math.round(m.areaSqMeters * 10.7639);
      areaEl.textContent = `${Math.round(m.areaSqMeters).toLocaleString()} m² · ${sqFt.toLocaleString()} ft²`;
    }
    if (altEl) {
      altEl.textContent = `${Math.round(m.baseEllipsoidalMeters)} → ${Math.round(m.ceilingEllipsoidalMeters)} m`;
    }
    if (centerEl) centerEl.textContent = `${m.centerLat.toFixed(5)}°, ${m.centerLon.toFixed(5)}°`;

    if (inpSouth && document.activeElement !== inpSouth) inpSouth.value = m.south.toFixed(6);
    if (inpNorth && document.activeElement !== inpNorth) inpNorth.value = m.north.toFixed(6);
    if (inpWest && document.activeElement !== inpWest) inpWest.value = m.west.toFixed(6);
    if (inpEast && document.activeElement !== inpEast) inpEast.value = m.east.toFixed(6);
    if (inpName && document.activeElement !== inpName) inpName.value = geoBox.name;
    if (sliderBase) sliderBase.value = String(Math.round(geoBox.baseOffsetMeters));
    if (sliderHeight) sliderHeight.value = String(Math.round(geoBox.heightMeters));
    if (valBase) {
      valBase.textContent = `${geoBox.baseOffsetMeters >= 0 ? '+' : ''}${Math.round(geoBox.baseOffsetMeters)} m`;
    }
    if (valHeight) valHeight.textContent = `${Math.round(geoBox.heightMeters)} m`;
    if (btnVis) {
      btnVis.textContent = geoBox.visible ? 'Visible' : 'Hidden';
      btnVis.setAttribute('data-active', String(geoBox.visible));
    }
  }

  function refreshGeoBoxGraphics(): void {
    clearGeoBoxEntities(geoBoxPreviewEntities);
    if (!geoBox) {
      clearGeoBoxEntities(geoBoxEntities);
      syncGeoBoxUI();
      notifyUiStateChanged();
      return;
    }
    const m = computeGeoBoxMetrics(geoBox);
    renderGeoBoxVolume(
      geoBox.south,
      geoBox.north,
      geoBox.west,
      geoBox.east,
      m.baseEllipsoidalMeters,
      m.ceilingEllipsoidalMeters,
      geoBoxEntities,
      {
        interactive: true,
        show: geoBox.visible,
        labelText: `${m.widthMeters.toFixed(0)}m × ${m.depthMeters.toFixed(0)}m × ${m.heightMeters.toFixed(0)}m`,
      }
    );
    syncGeoBoxUI();
    ensureGeoBoxDragHandler();
    notifyUiStateChanged();
  }

  function destroyGeoBoxDragHandler(): void {
    if (geoBoxDragHandler) {
      geoBoxDragHandler.destroy();
      geoBoxDragHandler = null;
    }
    geoBoxDraggingCorner = null;
  }

  function ensureGeoBoxDragHandler(): void {
    if (!viewer || !geoBox || geoBoxDragHandler) return;
    geoBoxDragHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    geoBoxDragHandler.setInputAction((evt: any) => {
      if (geoBoxDrawing || measureMode !== 'off' || !geoBox || !geoBox.visible) return;
      const picked = viewer.scene.pick(evt.position);
      const ent = picked?.id;
      const handle = ent?.properties?.geoBoxCorner?.getValue?.();
      if (
        handle === 'sw' ||
        handle === 'se' ||
        handle === 'ne' ||
        handle === 'nw' ||
        handle === 'top' ||
        handle === 'base'
      ) {
        geoBoxDraggingCorner = handle;
        viewer.scene.screenSpaceCameraController.enableRotate = false;
        viewer.scene.screenSpaceCameraController.enableTranslate = false;
        viewer.scene.screenSpaceCameraController.enableZoom = false;

        if (handle === 'top' || handle === 'base') {
          geoBoxDragStartY = evt.position.y;
          geoBoxDragStartHeight = geoBox.heightMeters;
          geoBoxDragStartBaseOffset = geoBox.baseOffsetMeters;
          const m = computeGeoBoxMetrics(geoBox);
          const handleAlt = handle === 'top' ? m.ceilingEllipsoidalMeters : m.baseEllipsoidalMeters;
          const handlePos = Cesium.Cartesian3.fromDegrees(m.centerLon, m.centerLat, handleAlt);
          const dist = Cesium.Cartesian3.distance(viewer.camera.position, handlePos);
          const fov =
            typeof viewer.camera.frustum?.fovy === 'number'
              ? viewer.camera.frustum.fovy
              : Cesium.Math.toRadians(45);
          const canvasH = Math.max(200, viewer.scene.canvas.clientHeight || 720);
          geoBoxVerticalMetersPerPx = Math.max(
            0.04,
            Math.min(8.0, (2 * dist * Math.tan(fov * 0.5)) / canvasH)
          );
          viewer.scene.canvas.style.cursor = 'ns-resize';
        } else {
          viewer.scene.canvas.style.cursor = 'grabbing';
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    geoBoxDragHandler.setInputAction((movement: any) => {
      if (!geoBox) return;

      // Hover cursor affordance when not actively dragging
      if (!geoBoxDraggingCorner) {
        if (geoBoxDrawing || measureMode !== 'off' || !geoBox.visible) return;
        const picked = viewer.scene.pick(movement.endPosition);
        const handle = picked?.id?.properties?.geoBoxCorner?.getValue?.();
        if (handle === 'top' || handle === 'base') {
          viewer.scene.canvas.style.cursor = 'ns-resize';
        } else if (handle === 'sw' || handle === 'se' || handle === 'ne' || handle === 'nw') {
          viewer.scene.canvas.style.cursor = 'grab';
        } else if (viewer.scene.canvas.style.cursor === 'grab' || viewer.scene.canvas.style.cursor === 'ns-resize') {
          viewer.scene.canvas.style.cursor = '';
        }
        return;
      }

      // Vertical drag for TOP ceiling height or BASE elevation offset
      if (geoBoxDraggingCorner === 'top') {
        const deltaMeters = (geoBoxDragStartY - movement.endPosition.y) * geoBoxVerticalMetersPerPx;
        geoBox.heightMeters = Math.max(4, Math.min(500, Math.round((geoBoxDragStartHeight + deltaMeters) * 2) / 2));
        refreshGeoBoxGraphics();
        return;
      }
      if (geoBoxDraggingCorner === 'base') {
        const deltaMeters = (geoBoxDragStartY - movement.endPosition.y) * geoBoxVerticalMetersPerPx;
        geoBox.baseOffsetMeters = Math.max(
          -50,
          Math.min(250, Math.round((geoBoxDragStartBaseOffset + deltaMeters) * 2) / 2)
        );
        refreshGeoBoxGraphics();
        return;
      }

      // Horizontal XY drag for SW/SE/NE/NW footprint corners
      const pt = pickGeoSurfacePoint(movement.endPosition);
      if (!pt) return;
      const minSpan = 0.00002;
      if (geoBoxDraggingCorner === 'sw') {
        geoBox.south = Math.min(pt.lat, geoBox.north - minSpan);
        geoBox.west = Math.min(pt.lon, geoBox.east - minSpan);
      } else if (geoBoxDraggingCorner === 'se') {
        geoBox.south = Math.min(pt.lat, geoBox.north - minSpan);
        geoBox.east = Math.max(pt.lon, geoBox.west + minSpan);
      } else if (geoBoxDraggingCorner === 'ne') {
        geoBox.north = Math.max(pt.lat, geoBox.south + minSpan);
        geoBox.east = Math.max(pt.lon, geoBox.west + minSpan);
      } else if (geoBoxDraggingCorner === 'nw') {
        geoBox.north = Math.max(pt.lat, geoBox.south + minSpan);
        geoBox.west = Math.min(pt.lon, geoBox.east - minSpan);
      }
      refreshGeoBoxGraphics();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    geoBoxDragHandler.setInputAction(() => {
      if (!geoBoxDraggingCorner) return;
      const dragged = geoBoxDraggingCorner;
      geoBoxDraggingCorner = null;
      viewer.scene.screenSpaceCameraController.enableRotate = true;
      viewer.scene.screenSpaceCameraController.enableTranslate = true;
      viewer.scene.screenSpaceCameraController.enableZoom = true;
      viewer.scene.canvas.style.cursor = '';
      if (geoBox && (dragged === 'top' || dragged === 'base')) {
        const m = computeGeoBoxMetrics(geoBox);
        logEvent(
          `Geo-Box vertical envelope updated: base ${m.baseEllipsoidalMeters.toFixed(1)}m → ceiling ${m.ceilingEllipsoidalMeters.toFixed(1)}m (height ${m.heightMeters.toFixed(1)}m).`,
          'ok'
        );
      } else {
        logEvent('Geo-Box corner bounds updated.', 'ok');
      }
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
  }

  function setGeoBoxDrawing(active: boolean): void {
    geoBoxDrawing = active;
    geoBoxAnchor = null;
    clearGeoBoxEntities(geoBoxPreviewEntities);

    if (geoBoxDrawHandler) {
      geoBoxDrawHandler.destroy();
      geoBoxDrawHandler = null;
    }

    if (!active) {
      if (boxDrawBanner) boxDrawBanner.classList.add('hidden');
      if (viewer?.scene?.canvas) viewer.scene.canvas.style.cursor = '';
      syncGeoBoxUI();
      return;
    }

    if (!viewer) {
      geoBoxDrawing = false;
      return;
    }

    if (measureMode !== 'off') setMeasureMode('off');
    if (flightMode !== 'explore') setFlightMode('explore');

    // Tuck active card out of the way so the user has an unobstructed globe while picking corners
    setActiveCard(null);
    if (boxDrawBanner) boxDrawBanner.classList.remove('hidden');
    if (boxDrawBannerText) boxDrawBannerText.textContent = 'Click corner 1 on the 3D globe or tileset';
    viewer.scene.canvas.style.cursor = 'crosshair';

    geoBoxDrawHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    geoBoxDrawHandler.setInputAction((click: any) => {
      const pt = pickGeoSurfacePoint(click.position);
      if (!pt) {
        showToast('Aim over the 3D globe or tileset to pick a corner.', 'error');
        return;
      }

      if (!geoBoxAnchor) {
        geoBoxAnchor = pt;
        if (boxDrawBannerText) {
          boxDrawBannerText.textContent = 'Move pointer and click corner 2 to lock capture box';
        }
        // Drop initial corner pin immediately
        clearGeoBoxEntities(geoBoxPreviewEntities);
        geoBoxPreviewEntities.push(
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.height + 1),
            point: {
              pixelSize: 9,
              color: Cesium.Color.fromCssColorString('#f3dc9f'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          })
        );
        return;
      }

      // Corner 2 clicked — finalize 3D Draw Box
      let south = Math.min(geoBoxAnchor.lat, pt.lat);
      let north = Math.max(geoBoxAnchor.lat, pt.lat);
      let west = Math.min(geoBoxAnchor.lon, pt.lon);
      let east = Math.max(geoBoxAnchor.lon, pt.lon);

      // Guarantee a sensible minimum footprint (~10m) if user double-clicked the same spot
      if (north - south < 0.00008) {
        const mid = (south + north) * 0.5;
        south = mid - 0.00018;
        north = mid + 0.00018;
      }
      if (east - west < 0.00008) {
        const mid = (west + east) * 0.5;
        west = mid - 0.00022;
        east = mid + 0.00022;
      }

      const nameInput = el<HTMLInputElement>('input-box-name')?.value?.trim() || 'Site Asset Mesh';
      const baseSlider = Number(el<HTMLInputElement>('slider-box-base')?.value ?? 0);
      const heightSlider = Number(el<HTMLInputElement>('slider-box-height')?.value ?? 25);
      const baseSurface = Math.min(geoBoxAnchor.height, pt.height);
      const approxOrigin = { lat: round7((south + north) * 0.5), lon: round7((west + east) * 0.5), alt: baseSurface };
      const swEnu = wgs84ToEnuEllipsoidal(south, west, baseSurface, approxOrigin);
      const neEnu = wgs84ToEnuEllipsoidal(north, east, baseSurface, approxOrigin);
      const maxSpan = Math.max(Math.abs(neEnu[0] - swEnu[0]), Math.abs(neEnu[1] - swEnu[1]));
      const smartHeight =
        heightSlider === 25
          ? Math.max(10, Math.min(80, Math.round(maxSpan * 0.45)))
          : Math.max(4, Math.min(500, heightSlider));

      geoBox = {
        name: nameInput,
        south,
        north,
        west,
        east,
        surfaceBaseMeters: Number.isFinite(baseSurface) ? baseSurface : 0,
        baseOffsetMeters: Number.isFinite(baseSlider) ? baseSlider : 0,
        heightMeters: Number.isFinite(smartHeight) ? smartHeight : 25,
        visible: true,
      };

      setGeoBoxDrawing(false);
      refreshGeoBoxGraphics();
      setActiveCard('box');
      const m = computeGeoBoxMetrics(geoBox);
      showToast(
        `Geo-Box locked (${m.widthMeters.toFixed(0)}×${m.depthMeters.toFixed(0)}×${m.heightMeters.toFixed(0)}m) — drag ↕ TOP/BASE or corners`
      );
      logEvent(
        `Geo-Box locked (${m.widthMeters.toFixed(1)}×${m.depthMeters.toFixed(1)}×${m.heightMeters.toFixed(1)}m @ ${m.centerLat.toFixed(5)}°, ${m.centerLon.toFixed(5)}°).`,
        'ok'
      );
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    geoBoxDrawHandler.setInputAction((movement: any) => {
      if (!geoBoxAnchor) return;
      const pt = pickGeoSurfacePoint(movement.endPosition);
      if (!pt) return;
      const south = Math.min(geoBoxAnchor.lat, pt.lat);
      const north = Math.max(geoBoxAnchor.lat, pt.lat);
      const west = Math.min(geoBoxAnchor.lon, pt.lon);
      const east = Math.max(geoBoxAnchor.lon, pt.lon);
      if (north - south < 0.000005 || east - west < 0.000005) return;
      const baseOffset = Number(el<HTMLInputElement>('slider-box-base')?.value ?? 0);
      const boxHeight = Number(el<HTMLInputElement>('slider-box-height')?.value ?? 25);
      const baseAlt = Math.min(geoBoxAnchor.height, pt.height) + (Number.isFinite(baseOffset) ? baseOffset : 0);
      renderGeoBoxVolume(south, north, west, east, baseAlt, baseAlt + boxHeight, geoBoxPreviewEntities, {
        interactive: false,
        show: true,
      });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    geoBoxDrawHandler.setInputAction(() => {
      setGeoBoxDrawing(false);
      setActiveCard('box');
      showToast('Geo-Box drawing canceled.');
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    syncGeoBoxUI();
  }

  function dropGeoBoxAtView(options?: {
    name?: string;
    centerLat?: number;
    centerLon?: number;
    widthMeters?: number;
    depthMeters?: number;
    south?: number;
    north?: number;
    west?: number;
    east?: number;
    heightMeters?: number;
    baseOffsetMeters?: number;
    frame?: boolean;
  }): GeoDrawBoxSnapshot | null {
    if (!viewer) return null;
    setGeoBoxDrawing(false);

    let centerLat = options?.centerLat;
    let centerLon = options?.centerLon;
    let surfaceHeight = 0;

    if (
      typeof options?.south === 'number' &&
      typeof options?.north === 'number' &&
      typeof options?.west === 'number' &&
      typeof options?.east === 'number' &&
      Number.isFinite(options.south) &&
      Number.isFinite(options.north) &&
      Number.isFinite(options.west) &&
      Number.isFinite(options.east)
    ) {
      const south = Math.min(options.south, options.north);
      const north = Math.max(options.south, options.north);
      const west = Math.min(options.west, options.east);
      const east = Math.max(options.west, options.east);
      const carto = viewer.camera?.positionCartographic;
      surfaceHeight = carto ? Math.max(0, Math.min(carto.height - 80, 0)) : 0;
      geoBox = {
        name: options.name?.trim() || el<HTMLInputElement>('input-box-name')?.value?.trim() || 'Site Asset Mesh',
        south,
        north,
        west,
        east,
        surfaceBaseMeters: surfaceHeight,
        baseOffsetMeters:
          typeof options.baseOffsetMeters === 'number' && Number.isFinite(options.baseOffsetMeters)
            ? Math.max(-50, Math.min(250, options.baseOffsetMeters))
            : 0,
        heightMeters:
          typeof options.heightMeters === 'number' && Number.isFinite(options.heightMeters)
            ? Math.max(10, Math.min(500, options.heightMeters))
            : 60,
        visible: true,
      };
      refreshGeoBoxGraphics();
      if (options.frame) frameGeoBox();
      return computeGeoBoxMetrics(geoBox);
    }

    if (centerLat === undefined || centerLon === undefined || !Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
      // Raycast center of the viewport
      const canvas = viewer.scene.canvas;
      const centerPx = new Cesium.Cartesian2(canvas.clientWidth * 0.5, canvas.clientHeight * 0.5);
      const picked = pickGeoSurfacePoint(centerPx);
      if (picked) {
        centerLat = picked.lat;
        centerLon = picked.lon;
        surfaceHeight = picked.height;
      } else if (viewer.camera?.positionCartographic) {
        centerLat = Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude);
        centerLon = Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude);
        surfaceHeight = 0;
      } else {
        return null;
      }
    }

    // Scale default box footprint intelligently based on current camera altitude when width/depth not explicitly provided
    const camAlt = viewer.camera?.positionCartographic?.height ?? 350;
    const autoSpan = Math.max(40, Math.min(320, Math.round((camAlt * 0.28) / 10) * 10));
    const widthM =
      typeof options?.widthMeters === 'number' && Number.isFinite(options.widthMeters)
        ? Math.max(5, Math.min(5000, options.widthMeters))
        : autoSpan;
    const depthM =
      typeof options?.depthMeters === 'number' && Number.isFinite(options.depthMeters)
        ? Math.max(5, Math.min(5000, options.depthMeters))
        : autoSpan;

    const latRad = Cesium.Math.toRadians(centerLat);
    const dLat = (depthM * 0.5) / 111132.92;
    const dLon = (widthM * 0.5) / Math.max(1e-3, 111412.84 * Math.cos(latRad));

    geoBox = {
      name: options?.name?.trim() || el<HTMLInputElement>('input-box-name')?.value?.trim() || 'Site Asset Mesh',
      south: centerLat - dLat,
      north: centerLat + dLat,
      west: centerLon - dLon,
      east: centerLon + dLon,
      surfaceBaseMeters: surfaceHeight,
      baseOffsetMeters:
        typeof options?.baseOffsetMeters === 'number' && Number.isFinite(options.baseOffsetMeters)
          ? Math.max(-50, Math.min(250, options.baseOffsetMeters))
          : 0,
      heightMeters:
        typeof options?.heightMeters === 'number' && Number.isFinite(options.heightMeters)
          ? Math.max(10, Math.min(500, options.heightMeters))
          : Math.max(25, Math.min(180, Math.round(Math.max(widthM, depthM) * 0.55))),
      visible: true,
    };

    refreshGeoBoxGraphics();
    if (options?.frame) frameGeoBox();
    const m = computeGeoBoxMetrics(geoBox);
    showToast(`Geo-Box dropped (${m.widthMeters.toFixed(0)}m × ${m.depthMeters.toFixed(0)}m × ${m.heightMeters.toFixed(0)}m)`);
    logEvent(`Geo-Box created at ${m.centerLat.toFixed(5)}°, ${m.centerLon.toFixed(5)}° (${m.widthMeters.toFixed(0)}×${m.depthMeters.toFixed(0)}m).`, 'ok');
    return m;
  }

  function clearGeoBox(): void {
    setGeoBoxDrawing(false);
    destroyGeoBoxDragHandler();
    clearGeoBoxEntities(geoBoxEntities);
    clearGeoBoxEntities(geoBoxPreviewEntities);
    geoBox = null;
    syncGeoBoxUI();
    notifyUiStateChanged();
    logEvent('Geo-Coordinate Draw Box cleared.', 'info');
  }

  function frameGeoBox(): void {
    if (!viewer || !geoBox) return;
    const m = computeGeoBoxMetrics(geoBox);
    const centerMidAlt = m.baseEllipsoidalMeters + m.heightMeters * 0.5;
    const radius = Math.sqrt(
      Math.pow(m.widthMeters * 0.5, 2) +
        Math.pow(m.depthMeters * 0.5, 2) +
        Math.pow(m.heightMeters * 0.5, 2)
    );
    const range = Math.max(60, radius * 2.8);
    const centerCartesian = Cesium.Cartesian3.fromDegrees(m.centerLon, m.centerLat, centerMidAlt);
    const bs = new Cesium.BoundingSphere(centerCartesian, Math.max(10, radius));
    viewer.camera.flyToBoundingSphere(bs, {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(35),
        Cesium.Math.toRadians(-32),
        range
      ),
      duration: 1.2,
    });
  }

  function buildGeoBoxGeoJson(box: GeoDrawBoxState): Record<string, unknown> {
    const m = computeGeoBoxMetrics(box);
    return {
      type: 'FeatureCollection',
      properties: {
        source: 'NoDRONE',
        quotable: false,
        provenance: 'observed_guide_internal',
      },
      features: [
        {
          type: 'Feature',
          properties: {
            name: m.name,
            source: 'NoDRONE',
            quotable: false,
            provenance: 'observed_guide_internal',
            baseEllipsoidalMeters: m.baseEllipsoidalMeters,
            ceilingEllipsoidalMeters: m.ceilingEllipsoidalMeters,
            heightMeters: m.heightMeters,
            widthMeters: m.widthMeters,
            depthMeters: m.depthMeters,
            areaSqMeters: m.areaSqMeters,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [m.west, m.south, m.baseEllipsoidalMeters],
                [m.east, m.south, m.baseEllipsoidalMeters],
                [m.east, m.north, m.baseEllipsoidalMeters],
                [m.west, m.north, m.baseEllipsoidalMeters],
                [m.west, m.south, m.baseEllipsoidalMeters],
              ],
            ],
          },
        },
      ],
    };
  }

  interface GeoBoxRigPose {
    index: number;
    ring: 'low-oblique' | 'high-oblique' | 'nadir';
    fileName: string;
    lat: number;
    lon: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
    fovyDeg: number;
    enuPositionMeters: [number, number, number];
    c2w_enu_zup_rowmajor: number[];
    c2w_enu_zup_opengl_rowmajor: number[];
    K: PinholeIntrinsics;
    quaternionOpenCv: UnitQuaternion;
    threeJsLocalMeters: {
      position: [number, number, number];
      lookAt: [number, number, number];
    };
  }

  function computeGeoBoxCaptureRig(
    box: GeoDrawBoxState,
    totalOrbitalViews: number,
    resolution: [number, number] = [1280, 720]
  ): GeoBoxRigPose[] {
    const m = computeGeoBoxMetrics(box);
    const originLat = round7(m.centerLat);
    const originLon = round7(m.centerLon);
    const originAlt = m.baseEllipsoidalMeters;
    const centerAlt = originAlt + m.heightMeters * 0.5;
    const centerCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, centerAlt);
    const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(centerCartesian);

    // Compute clean 3D bounding sphere & camera standoff so the entire box fills frame cleanly
    const radius = Math.sqrt(
      Math.pow(m.widthMeters * 0.5, 2) +
        Math.pow(m.depthMeters * 0.5, 2) +
        Math.pow(m.heightMeters * 0.5, 2)
    );
    const fovyDeg = Number(((2 * Math.atan(24 / (2 * activeLensMm)) * 180) / Math.PI).toFixed(2));
    const fovyRad = Cesium.Math.toRadians(fovyDeg);
    const standoff = Math.max(radius * 2.35, radius / Math.max(0.2, Math.sin(fovyRad * 0.36)));
    const K = computePinholeK(resolution[0], resolution[1], fovyDeg);
    const targetEnu: [number, number, number] = [0, 0, roundTo(m.heightMeters * 0.5, 4)];

    const lowCount = Math.max(4, Math.ceil(totalOrbitalViews * 0.55));
    const highCount = Math.max(4, totalOrbitalViews - lowCount);

    const poses: GeoBoxRigPose[] = [];
    let idx = 1;

    const pushPose = (
      ring: GeoBoxRigPose['ring'],
      azimuthDeg: number,
      elevationDeg: number,
      rangeMeters: number
    ) => {
      const azRad = Cesium.Math.toRadians(azimuthDeg);
      const elRad = Cesium.Math.toRadians(elevationDeg);
      const horiz = rangeMeters * Math.cos(elRad);
      // Camera offset in local ENU relative to box center midpoint
      const east = horiz * Math.sin(azRad);
      const north = horiz * Math.cos(azRad);
      const upFromMid = rangeMeters * Math.sin(elRad);
      const upFromBase = m.heightMeters * 0.5 + upFromMid;

      const camCartesian = Cesium.Matrix4.multiplyByPoint(
        enuToFixed,
        new Cesium.Cartesian3(east, north, upFromMid),
        new Cesium.Cartesian3()
      );
      const camCarto = Cesium.Cartographic.fromCartesian(camCartesian);
      const heading = (azimuthDeg + 180) % 360;
      const pitch = -elevationDeg;

      const camEnu: [number, number, number] = [
        roundTo(east, 6),
        roundTo(north, 6),
        roundTo(upFromBase, 6),
      ];
      const c2wOpenCv = buildLookAtC2W(camEnu, targetEnu, 'opencv').map((v) => roundTo(v, 6));
      const c2wOpenGl = openCvToOpenGlC2W(c2wOpenCv).map((v) => roundTo(v, 6));
      const qRaw = rotationMatrixToQuaternion(extractRotation3x3(c2wOpenCv));
      const quaternionOpenCv: UnitQuaternion = {
        qw: roundTo(qRaw.qw, 9),
        qx: roundTo(qRaw.qx, 9),
        qy: roundTo(qRaw.qy, 9),
        qz: roundTo(qRaw.qz, 9),
      };

      poses.push({
        index: idx,
        ring,
        fileName: `frames/view_${String(idx).padStart(3, '0')}.png`,
        lat: Number(Cesium.Math.toDegrees(camCarto.latitude).toFixed(7)),
        lon: Number(Cesium.Math.toDegrees(camCarto.longitude).toFixed(7)),
        height: Number(camCarto.height.toFixed(2)),
        heading: Number(heading.toFixed(2)),
        pitch: Number(pitch.toFixed(2)),
        roll: 0,
        fovyDeg,
        enuPositionMeters: [roundTo(east, 3), roundTo(north, 3), roundTo(upFromBase, 3)],
        c2w_enu_zup_rowmajor: c2wOpenCv,
        c2w_enu_zup_opengl_rowmajor: c2wOpenGl,
        K,
        quaternionOpenCv,
        // Three.js Y-up right-handed metric coordinates (X = East, Y = Up from box base, Z = South = -North)
        threeJsLocalMeters: {
          position: [
            Number(east.toFixed(3)),
            Number(upFromBase.toFixed(3)),
            Number((-north).toFixed(3)),
          ],
          lookAt: [0, Number((m.heightMeters * 0.5).toFixed(3)), 0],
        },
      });
      idx += 1;
    };

    for (let i = 0; i < lowCount; i++) {
      pushPose('low-oblique', (i * 360) / lowCount, 22, standoff);
    }
    const halfStep = 180 / highCount;
    for (let i = 0; i < highCount; i++) {
      pushPose('high-oblique', (i * 360) / highCount + halfStep, 48, standoff * 1.05);
    }
    // Top-down nadir shot directly over box center
    pushPose('nadir', 0, 88, standoff * 1.12);

    return poses;
  }

  function buildGeoBoxAnchorsJson(box: GeoDrawBoxState): FlyoverAnchor[] {
    const m = computeGeoBoxMetrics(box);
    const originLat = round7(m.centerLat);
    const originLon = round7(m.centerLon);
    const baseElev = roundTo(m.baseEllipsoidalMeters, 2);
    return [
      {
        name: 'A1_origin',
        role: 'origin',
        lat: formatDms(originLat, 'lat'),
        lon: formatDms(originLon, 'lon'),
        elev_m: baseElev,
        es_alt: baseElev,
        note: `${m.name} — Geo-Box center ground origin (0,0,0) in local ENU`,
      },
      {
        name: 'A2_box_SW',
        role: 'anchor',
        lat: formatDms(box.south, 'lat'),
        lon: formatDms(box.west, 'lon'),
        elev_m: baseElev,
        note: 'Geo-Box Southwest footprint corner',
      },
      {
        name: 'A3_box_SE',
        role: 'anchor',
        lat: formatDms(box.south, 'lat'),
        lon: formatDms(box.east, 'lon'),
        elev_m: baseElev,
        note: 'Geo-Box Southeast footprint corner',
      },
      {
        name: 'A4_box_NE',
        role: 'anchor',
        lat: formatDms(box.north, 'lat'),
        lon: formatDms(box.east, 'lon'),
        elev_m: baseElev,
        note: 'Geo-Box Northeast footprint corner',
      },
      {
        name: 'A5_box_NW',
        role: 'anchor',
        lat: formatDms(box.north, 'lat'),
        lon: formatDms(box.west, 'lon'),
        elev_m: baseElev,
        note: 'Geo-Box Northwest footprint corner',
      },
    ];
  }

  function buildGeoBoxCameraMatricesJson(
    box: GeoDrawBoxState,
    poses: GeoBoxRigPose[]
  ): CameraMatricesDocument {
    const m = computeGeoBoxMetrics(box);
    const originLat = round7(m.centerLat);
    const originLon = round7(m.centerLon);
    const originAlt = roundTo(m.baseEllipsoidalMeters, 2);
    const origin = { lat: originLat, lon: originLon, alt: originAlt };
    const fps = 30;
    const fmtCoord = (v: number) => v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');

    const corners: Array<{ name: string; lat: number; lon: number }> = [
      { name: 'A1_origin', lat: originLat, lon: originLon },
      { name: 'A2_box_SW', lat: box.south, lon: box.west },
      { name: 'A3_box_SE', lat: box.south, lon: box.east },
      { name: 'A4_box_NE', lat: box.north, lon: box.east },
      { name: 'A5_box_NW', lat: box.north, lon: box.west },
    ];

    const anchorsEnu = corners.map((c) => {
      const enu = wgs84ToEnuEllipsoidal(c.lat, c.lon, originAlt, origin);
      return {
        name: c.name,
        E: roundTo(enu[0], 2),
        N: roundTo(enu[1], 2),
        U: roundTo(enu[2], 2),
      };
    });

    return {
      name: m.name,
      frames_count: poses.length,
      fps,
      quotable: false,
      conventions: {
        world: `ENU metres from A1_origin ground point (${fmtCoord(originLat)}, ${fmtCoord(originLon)}, ${originAlt} m ASL): x=East, y=North, z=Up`,
        camera: 'OpenCV: x=right, y=down, z=forward (up = -y)',
        matrix:
          'camera-to-world, 4x4, row-major, translation in last column; world_point = c2w @ [x_cam, y_cam, z_cam, 1]; invert for world-to-camera',
        intrinsics: 'pinhole, principal point at image centre, fx=fy=(H/2)/tan(fov_v/2); no distortion',
        source:
          'NoDRONE Geo-Coordinate Draw Box orbital rig computed in WGS84 ellipsoidal ECEF->ENU frame',
      },
      verification: {
        max_forward_error_deg_vs_camera_target: 0.0,
        max_roll_deg: 0.0,
        max_position_diff_m_es_vs_latlon: 0.0,
      },
      anchors_enu: anchorsEnu,
      frames: poses.map((p, i) => ({
        frame: i,
        time_s: roundTo(i / fps, 4),
        c2w_enu_zup_rowmajor: p.c2w_enu_zup_rowmajor,
        K: p.K,
        lat: p.lat,
        lon: p.lon,
        alt_asl_m: p.height,
      })),
    };
  }

  function buildGeoBoxTrajectoryJson(
    box: GeoDrawBoxState,
    poses: GeoBoxRigPose[],
    resolution: [number, number]
  ): BlenderTrajectoryDocument {
    const m = computeGeoBoxMetrics(box);
    const originLat = round7(m.centerLat);
    const originLon = round7(m.centerLon);
    const originAlt = roundTo(m.baseEllipsoidalMeters, 2);
    const fmtCoord = (v: number) => v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
    const firstK = poses[0]?.K ?? computePinholeK(resolution[0], resolution[1], 40);
    const fMm = blenderFocalLengthMm(firstK.fx, firstK.width, 36.0);

    return {
      site: m.name,
      convention: 'opencv',
      fps: 30,
      quotable: false,
      world: `ENU metres from A1_origin ground point (${fmtCoord(originLat)}, ${fmtCoord(originLon)}, ${originAlt} m ASL): x=East, y=North, z=Up`,
      camera: 'OpenCV: x=right, y=down, z=forward (Blender G-buffer renderer applies OpenCV->OpenGL flip)',
      blender_focal_mm: fMm,
      sensor_width_mm: 36.0,
      resolution,
      trajectory: poses.map((p, i) => ({
        frame: i,
        x_enu: p.c2w_enu_zup_rowmajor[3],
        y_enu: p.c2w_enu_zup_rowmajor[7],
        z_enu: p.c2w_enu_zup_rowmajor[11],
        qx: p.quaternionOpenCv.qx,
        qy: p.quaternionOpenCv.qy,
        qz: p.quaternionOpenCv.qz,
        qw: p.quaternionOpenCv.qw,
      })),
    };
  }

  async function buildGeoBoxProvenanceJson(
    box: GeoDrawBoxState,
    entries: ZipEntryInput[]
  ): Promise<Record<string, unknown>> {
    const m = computeGeoBoxMetrics(box);
    const artifacts: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
    for (const entry of entries) {
      const digest = await sha256Hex(entry.data);
      artifacts.push({
        path: entry.name,
        sizeBytes: entry.data.byteLength,
        sha256: digest,
      });
    }
    const activeSurvey = getActiveSurvey();
    return {
      schema: 'nodrone-provenance/1.0',
      site: m.name,
      survey: {
        surveyId: activeSurvey.surveyId,
        capturedAt: activeSurvey.capturedAt,
        label: activeSurvey.label,
        status: activeSurvey.status,
        compareSurveyId,
      },
      exportedAt: new Date().toISOString(),
      quotable: false,
      provenanceTag: 'observed_guide_internal',
      complianceBoundary:
        'Visual cinematography and spatial guide registration only; non-quotable (quotable: false).',
      attributionPolicy:
        'CesiumJS / Google 3D Tiles attribution badges composited onto all captured PNG guide frames.',
      artifactCount: artifacts.length,
      artifacts,
    };
  }

  function buildSplatStudioManifest(
    box: GeoDrawBoxState,
    poses: GeoBoxRigPose[],
    resolution: [number, number]
  ): Record<string, unknown> {
    const m = computeGeoBoxMetrics(box);
    const activeSurvey = getActiveSurvey();
    const centerCartesian = Cesium.Cartesian3.fromDegrees(
      m.centerLon,
      m.centerLat,
      m.baseEllipsoidalMeters + m.heightMeters * 0.5
    );
    const firstK = poses[0]?.K ?? computePinholeK(resolution[0], resolution[1], 40);
    const blenderFocalMm = blenderFocalLengthMm(firstK.fx, firstK.width, 36.0);
    return {
      schema: 'nodrone-splat-bundle/1.2',
      targetStudio: 'SplatEarthTheory (-splatthat)',
      exportedAt: new Date().toISOString(),
      quotable: false,
      provenance: 'observed_guide_internal',
      survey: {
        surveyId: activeSurvey.surveyId,
        capturedAt: activeSurvey.capturedAt,
        label: activeSurvey.label,
        status: activeSurvey.status,
        compareSurveyId,
      },
      asset: {
        name: m.name,
        slug: m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site-asset',
      },
      bounds: {
        wgs84: {
          south: m.south,
          north: m.north,
          west: m.west,
          east: m.east,
          centerLat: m.centerLat,
          centerLon: m.centerLon,
          baseEllipsoidalMeters: m.baseEllipsoidalMeters,
          ceilingEllipsoidalMeters: m.ceilingEllipsoidalMeters,
        },
        ecefCenterMeters: [
          Number(centerCartesian.x.toFixed(3)),
          Number(centerCartesian.y.toFixed(3)),
          Number(centerCartesian.z.toFixed(3)),
        ],
        localMetricDimensions: {
          widthMeters: m.widthMeters,
          depthMeters: m.depthMeters,
          heightMeters: m.heightMeters,
          areaSqMeters: m.areaSqMeters,
          coordinateSystem: 'Three.js Y-up right-handed (X=East, Y=Up from box base, Z=South)',
          geodesyMethod: 'WGS84 ellipsoidal ECEF->ENU (a=6378137.0, 1/f=298.257223563)',
        },
      },
      sceneContext: {
        lensMm: activeLensMm,
        blenderFocalMm,
        sensorWidthMm: 36.0,
        pinholeIntrinsics: firstK,
        resolution,
        worldTerrain: worldTerrainEnabled,
        google3DTiles: google3DEnabled,
        sse: currentSSE,
        verticalOffsetMeters: currentHeightOffset,
        tilesets: activeTilesets.map((t) => ({
          ionAssetId: t.id,
          name: t.name,
          visible: t.visible,
        })),
        weather: lastWeatherData
          ? {
              stationName: lastWeatherData.stationName,
              condition: lastWeatherData.condition,
              tempC: lastWeatherData.tempC,
              cloudCoverPct: lastWeatherData.cloudCoverPct,
              windSpeedMps: lastWeatherData.windSpeedMps,
              windDeg: lastWeatherData.windDeg,
            }
          : null,
      },
      captureRig: {
        totalViews: poses.length,
        poses,
      },
    };
  }

  function buildGeoBoxCameraPathJson(
    box: GeoDrawBoxState,
    poses: GeoBoxRigPose[],
    resolution: [number, number]
  ): Record<string, unknown> {
    const m = computeGeoBoxMetrics(box);
    const activeSurvey = getActiveSurvey();
    return {
      schema: 'nodrone-camera-path/1',
      site: m.name,
      surveyId: activeSurvey.surveyId,
      capturedAt: activeSurvey.capturedAt,
      recordedAt: new Date().toISOString(),
      quotable: false,
      mode: 'geo-box-multiview',
      render: {
        fps: 30,
        resolution,
      },
      samples: poses.map((p, idx) => ({
        t: Number((idx / 30).toFixed(4)),
        lat: p.lat,
        lon: p.lon,
        height: p.height,
        heading: p.heading,
        pitch: p.pitch,
        roll: p.roll,
        fovyDeg: p.fovyDeg,
      })),
    };
  }

  function captureCanvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas PNG capture returned null blob.'));
      }, 'image/png');
    });
  }

  async function captureGeoBoxStudioBundle(): Promise<void> {
    if (!viewer?.scene || !geoBox || isCapturingGeoBox || isRenderingPath) return;
    if (isRecording) {
      showToast('Stop live recording before capturing a Studio Bundle.', 'error');
      return;
    }

    const boxSnapshot = { ...geoBox };
    const m = computeGeoBoxMetrics(boxSnapshot);
    const canvas = viewer.scene.canvas as HTMLCanvasElement;
    const container = el<HTMLDivElement>('cesium-container');
    if (!container) return;

    const targetW = Math.max(640, canvas.width || 1280);
    const targetH = Math.max(360, canvas.height || 720);
    const poses = computeGeoBoxCaptureRig(boxSnapshot, geoBoxCaptureViews, [targetW, targetH]);
    const total = poses.length;

    stopRenderPathPreview();
    isCapturingGeoBox = true;
    geoBoxCaptureCancelled = false;
    setGeoBoxDrawing(false);
    setFlightMode('explore');
    syncGeoBoxUI();

    // Save camera, FOV, render loop, HUD visibility, and draw-box visibility
    const savedUseDefaultLoop = viewer.useDefaultRenderLoop;
    const savedCameraPos = viewer.camera.position.clone();
    const savedHeading = viewer.camera.heading;
    const savedPitch = viewer.camera.pitch;
    const savedRoll = viewer.camera.roll;
    const savedFov =
      viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number'
        ? viewer.camera.frustum.fov
        : null;
    const savedBoxVisible = geoBox.visible;

    const hudElements = [
      document.querySelector('header') as HTMLElement | null,
      flightClusterGauge,
      boxDrawBanner,
      cardStage,
      summonGrid,
      spotlightTag,
      el<HTMLElement>('copilot-drawer'),
      flightHudBanner,
      recIndicator,
      document.querySelector('nav') as HTMLElement | null,
      el<HTMLElement>('btn-recall-hud'),
    ].filter((node): node is HTMLElement => Boolean(node));

    const savedHudDisplays = hudElements.map((node) => ({
      node,
      display: node.style.display,
    }));

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = targetW;
    outputCanvas.height = targetH;
    const outputCtx = outputCanvas.getContext('2d');
    const logoSafetyCache = new Map<string, boolean>();
    const zipEntries: ZipEntryInput[] = [];

    const updateProgress = (step: number) => {
      if (renderProgressText) {
        renderProgressText.textContent = `Capturing Studio view ${step} / ${total} (${m.name})…`;
      }
      if (renderProgressBar) {
        const pct = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
        renderProgressBar.style.width = `${pct}%`;
      }
    };

    try {
      // Hide HUD + temporary hide gold wireframe & path overlays so captured PNGs are clean photorealistic views
      for (const { node } of savedHudDisplays) {
        node.style.display = 'none';
      }
      geoBoxEntities.forEach((ent) => {
        ent.show = false;
      });
      renderPathEntities.forEach((ent) => {
        ent.show = false;
      });
      setMapLabelsTemporarilyHidden(true);
      if (renderProgressOverlay) {
        renderProgressOverlay.classList.remove('hidden');
        renderProgressOverlay.classList.add('flex');
      }
      updateProgress(0);

      viewer.useDefaultRenderLoop = false;
      const encoder = new TextEncoder();

      for (let i = 0; i < poses.length; i++) {
        if (geoBoxCaptureCancelled) break;
        const p = poses[i];
        updateProgress(i + 1);

        if (viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number') {
          viewer.camera.frustum.fov = computeAppliedFovRad(p.fovyDeg, targetW, targetH);
        }

        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
          orientation: {
            heading: Cesium.Math.toRadians(p.heading),
            pitch: Cesium.Math.toRadians(p.pitch),
            roll: Cesium.Math.toRadians(p.roll),
          },
        });

        await waitForRenderFrameSettled(12000);
        if (geoBoxCaptureCancelled) break;
        viewer.scene.render();

        let pngBlob: Blob;
        if (outputCtx) {
          outputCtx.clearRect(0, 0, targetW, targetH);
          outputCtx.drawImage(canvas, 0, 0, targetW, targetH);
          compositeCreditsOntoFrame(outputCtx, targetW, targetH, container, logoSafetyCache);
          try {
            pngBlob = await captureCanvasPngBlob(outputCanvas);
          } catch {
            pngBlob = await captureCanvasPngBlob(canvas);
          }
        } else {
          pngBlob = await captureCanvasPngBlob(canvas);
        }

        const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
        zipEntries.push({
          name: p.fileName,
          data: pngBytes,
        });
      }

      if (!geoBoxCaptureCancelled && zipEntries.length > 0) {
        const anchorsJson = buildGeoBoxAnchorsJson(boxSnapshot);
        const cameraMatricesJson = buildGeoBoxCameraMatricesJson(boxSnapshot, poses);
        const trajectoryJson = buildGeoBoxTrajectoryJson(boxSnapshot, poses, [targetW, targetH]);
        const bundleManifest = buildSplatStudioManifest(boxSnapshot, poses, [targetW, targetH]);
        const cameraPathJson = buildGeoBoxCameraPathJson(boxSnapshot, poses, [targetW, targetH]);
        const geoJson = buildGeoBoxGeoJson(boxSnapshot);

        zipEntries.unshift(
          {
            name: 'anchors.json',
            data: encoder.encode(JSON.stringify(anchorsJson, null, 2)),
          },
          {
            name: 'camera_matrices.json',
            data: encoder.encode(JSON.stringify(cameraMatricesJson, null, 2)),
          },
          {
            name: 'trajectory.json',
            data: encoder.encode(JSON.stringify(trajectoryJson, null, 2)),
          },
          {
            name: 'splatthat-bundle.json',
            data: encoder.encode(JSON.stringify(bundleManifest, null, 2)),
          },
          {
            name: 'camera-path.json',
            data: encoder.encode(JSON.stringify(cameraPathJson, null, 2)),
          },
          {
            name: 'box-footprint.geojson',
            data: encoder.encode(JSON.stringify(geoJson, null, 2)),
          }
        );

        // Decoupled Sidecar Provenance Registry with cryptographic SHA-256 hashes of every artifact + PNG frame
        const provenanceJson = await buildGeoBoxProvenanceJson(boxSnapshot, zipEntries);
        const provenanceBytes = encoder.encode(JSON.stringify(provenanceJson, null, 2));
        const provenanceDigest = await sha256Hex(provenanceBytes);
        zipEntries.splice(6, 0, {
          name: 'provenance.json',
          data: provenanceBytes,
        });

        // Stamp capture provenance & path reference onto the active Survey Catalog epoch
        const activeSurvey = getActiveSurvey();
        activeSurvey.assets.bundleProvenanceSha256 = provenanceDigest;
        if (activeSurvey.status === 'planned') {
          activeSurvey.status = 'captured';
        }
        const pathId = `rig-${activeSurvey.surveyId}-${Date.now().toString(36)}`;
        activeSurvey.paths = [
          ...activeSurvey.paths.filter((p) => p.name !== `${m.name} Rig`),
          {
            pathId,
            name: `${m.name} Rig`,
            format: 'splatthat-bundle',
            sampleCount: poses.length,
            smoothMode: 'linear',
          },
        ];
        activeSurvey.provenance.updatedAt = new Date().toISOString();
        surveyCatalogTouched = true;
        renderSurveyCatalogUI();

        const zipBlob = buildStoreZipBlob(zipEntries);
        const slug =
          m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site-asset';
        const fileName = `${slug}-${activeSurvey.surveyId}-splatthat-bundle.zip`;
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);

        showToast(`Studio Bundle ready (${activeSurvey.surveyId}): ${poses.length} views + 7 manifests (${formatFileSizeMb(zipBlob.size)})`);
        logEvent(
          `Exported Splat Studio Bundle "${fileName}" linked to survey "${activeSurvey.surveyId}" (${poses.length} PNG views + 7 manifests).`,
          'ok'
        );
      } else if (geoBoxCaptureCancelled) {
        showToast('Studio Bundle capture canceled.');
        logEvent('Studio Bundle capture canceled by user.', 'warn');
      }
    } catch (err: any) {
      showToast(`Studio Bundle capture failed: ${err?.message || err}`, 'error');
      logEvent(`Studio Bundle capture error: ${err?.message || err}`, 'error');
    } finally {
      // Restore camera, draw-box entities, render loop, and HUD cleanly
      viewer.camera.setView({
        destination: savedCameraPos,
        orientation: {
          heading: savedHeading,
          pitch: savedPitch,
          roll: savedRoll,
        },
      });
      if (savedFov !== null && viewer.camera.frustum && typeof viewer.camera.frustum.fov === 'number') {
        viewer.camera.frustum.fov = savedFov;
      }
      viewer.useDefaultRenderLoop = savedUseDefaultLoop;
      if (geoBox) {
        geoBox.visible = savedBoxVisible;
      }
      geoBoxEntities.forEach((ent) => {
        ent.show = savedBoxVisible;
      });
      renderPathEntities.forEach((ent) => {
        ent.show = true;
      });
      setMapLabelsTemporarilyHidden(false);
      for (const { node, display } of savedHudDisplays) {
        node.style.display = display;
      }
      if (renderProgressOverlay) {
        renderProgressOverlay.classList.add('hidden');
        renderProgressOverlay.classList.remove('flex');
      }
      isCapturingGeoBox = false;
      geoBoxCaptureCancelled = false;
      syncGeoBoxUI();
    }
  }

  // =========================================================================
  // Real-Time Weather Overlay (OpenWeatherMap API + 3D Globe Vectors)
  // =========================================================================

  function formatTemp(tempC: number): string {
    if (weatherUnits === 'imperial') {
      return `${Math.round((tempC * 9) / 5 + 32)}°F`;
    }
    return `${tempC.toFixed(1)}°C`;
  }

  function formatWind(speedMps: number): string {
    if (weatherUnits === 'imperial') {
      return `${(speedMps * 2.23694).toFixed(1)} mph`;
    }
    return `${speedMps.toFixed(1)} m/s`;
  }

  function clear3DWeatherOverlay(): void {
    if (viewer?.entities) {
      weatherEntities.forEach((ent) => viewer.entities.remove(ent));
    }
    weatherEntities = [];
  }

  function render3DWeatherOverlay(data: SiteWeatherData): void {
    clear3DWeatherOverlay();
    if (!viewer || !show3DWeatherOverlay) return;

    const baseHeight = 95;
    const centerPos = Cesium.Cartesian3.fromDegrees(data.lon, data.lat, baseHeight);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(centerPos);

    // Wind direction in meteorology = direction wind comes FROM (0° = from North, 90° = from East).
    // Wind flow arrow points TOWARD (windDeg + 180)°.
    const flowDeg = (data.windDeg + 180) % 360;
    const flowRad = Cesium.Math.toRadians(flowDeg);
    const dirEast = Math.sin(flowRad);
    const dirNorth = Math.cos(flowRad);
    const perpEast = -dirNorth;
    const perpNorth = dirEast;

    // Scale arrow length visually with wind speed (clamped for clean geospatial readability)
    const arrowHalfLen = Math.max(95, Math.min(280, 95 + data.windSpeedMps * 14));
    const laneSpacing = 85;

    const arrowColorCss =
      data.flightAdvisory === 'high-wind'
        ? '#f87171'
        : data.flightAdvisory === 'caution'
          ? '#fbbf24'
          : '#38bdf8';
    const arrowColor = Cesium.Color.fromCssColorString(arrowColorCss);

    // Draw 3 parallel elevated 3D wind vector streamlines over the site
    [-1, 0, 1].forEach((laneIdx) => {
      const lateral = laneIdx * laneSpacing;
      const startLocal = new Cesium.Cartesian3(
        -dirEast * arrowHalfLen + perpEast * lateral,
        -dirNorth * arrowHalfLen + perpNorth * lateral,
        0
      );
      const endLocal = new Cesium.Cartesian3(
        dirEast * arrowHalfLen + perpEast * lateral,
        dirNorth * arrowHalfLen + perpNorth * lateral,
        0
      );
      const startWorld = Cesium.Matrix4.multiplyByPoint(enu, startLocal, new Cesium.Cartesian3());
      const endWorld = Cesium.Matrix4.multiplyByPoint(enu, endLocal, new Cesium.Cartesian3());

      weatherEntities.push(
        viewer.entities.add({
          polyline: {
            positions: [startWorld, endWorld],
            width: laneIdx === 0 ? 11 : 7,
            material: new Cesium.PolylineArrowMaterialProperty(
              laneIdx === 0 ? arrowColor : arrowColor.withAlpha(0.65)
            ),
          },
        })
      );
    });

    // Translucent atmospheric cloud cover canopy hovering above the site
    if (data.cloudCoverPct > 5) {
      const canopyAlpha = Math.max(0.06, Math.min(0.42, (data.cloudCoverPct / 100) * 0.45 * weatherOpacity));
      weatherEntities.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(data.lon, data.lat, baseHeight + 140),
          ellipse: {
            semiMajorAxis: 340,
            semiMinorAxis: 340,
            height: baseHeight + 140,
            material: Cesium.Color.fromCssColorString('#e2e8f0').withAlpha(canopyAlpha),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#94a3b8').withAlpha(Math.min(0.45, canopyAlpha + 0.12)),
          },
        })
      );
    }

    // Floating 3D Site Weather Callout Label directly on the globe
    weatherEntities.push(
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(data.lon, data.lat, baseHeight + 45),
        point: {
          pixelSize: 6,
          color: arrowColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${formatTemp(data.tempC)} · ${formatWind(data.windSpeedMps)} ${data.windCardinal} · ${Math.round(data.cloudCoverPct)}% Clouds`,
          font: '600 11px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#09090b').withAlpha(0.82),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 45000.0),
        },
      })
    );
  }

  function renderWeatherHud(data: SiteWeatherData): void {
    const stationEl = el<HTMLHeadingElement>('weather-station');
    const sourceEl = el<HTMLSpanElement>('weather-source');
    const condEl = el<HTMLParagraphElement>('weather-condition');
    const tempEl = el<HTMLDivElement>('weather-temp');
    const feelsEl = el<HTMLDivElement>('weather-feels');
    const windEl = el<HTMLDivElement>('weather-wind');
    const windDirEl = el<HTMLSpanElement>('weather-wind-dir');
    const windArrowEl = el<HTMLElement>('weather-wind-arrow');
    const cloudsEl = el<HTMLDivElement>('weather-clouds');
    const cloudsBarEl = el<HTMLDivElement>('weather-clouds-bar');
    const atmosEl = el<HTMLSpanElement>('weather-atmos');
    const advEl = el<HTMLSpanElement>('weather-advisory');
    const unitBtn = el<HTMLButtonElement>('btn-weather-units');

    if (stationEl) {
      stationEl.textContent = data.country ? `${data.stationName}, ${data.country}` : data.stationName;
    }
    if (sourceEl) {
      sourceEl.textContent = data.source === 'openweathermap' ? 'OWM Live' : 'Live Meteo';
    }
    if (condEl) {
      condEl.textContent = data.description || data.condition;
    }
    if (tempEl) tempEl.textContent = formatTemp(data.tempC);
    const railTempEl = el<HTMLSpanElement>('rail-weather-temp');
    if (railTempEl) railTempEl.textContent = formatTemp(data.tempC);
    if (feelsEl) feelsEl.textContent = `Feels ${formatTemp(data.feelsLikeC)}`;
    if (windEl) windEl.textContent = formatWind(data.windSpeedMps);
    if (windDirEl) {
      const gustSuffix =
        data.windGustMps && data.windGustMps > data.windSpeedMps + 1
          ? ` · G${weatherUnits === 'imperial' ? Math.round(data.windGustMps * 2.23694) : Math.round(data.windGustMps)}`
          : '';
      windDirEl.textContent = `${data.windCardinal} ${Math.round(data.windDeg)}°${gustSuffix}`;
    }
    if (windArrowEl) {
      const flowDeg = (data.windDeg + 180) % 360;
      windArrowEl.style.transform = `rotate(${flowDeg}deg)`;
    }
    if (cloudsEl) cloudsEl.textContent = `${Math.round(data.cloudCoverPct)}%`;
    if (cloudsBarEl) {
      cloudsBarEl.style.width = `${Math.max(0, Math.min(100, data.cloudCoverPct))}%`;
    }
    if (atmosEl) {
      atmosEl.textContent = `RH ${Math.round(data.humidityPct)}% · ${Math.round(data.pressureHpa)} hPa`;
    }
    if (advEl) {
      advEl.textContent = data.flightAdvisoryLabel;
      advEl.className =
        data.flightAdvisory === 'high-wind'
          ? 'font-mono font-medium text-red-300 whitespace-nowrap shrink-0'
          : data.flightAdvisory === 'caution'
            ? 'font-mono font-medium text-amber-300 whitespace-nowrap shrink-0'
            : 'font-mono font-medium text-emerald-300 whitespace-nowrap shrink-0';
    }
    if (unitBtn) {
      unitBtn.textContent = weatherUnits === 'imperial' ? '°F' : '°C';
    }

    render3DWeatherOverlay(data);
  }

  function setWeatherTileLayer(layer: WeatherTileLayer, silent = false): void {
    activeWeatherLayer = layer;

    if (viewer && weatherImageryLayer) {
      try {
        viewer.imageryLayers.remove(weatherImageryLayer, true);
      } catch {
        // ignore if already removed
      }
      weatherImageryLayer = null;
    }

    document.querySelectorAll<HTMLButtonElement>('.weather-layer-btn').forEach((btn) => {
      const isSelected = btn.dataset.weatherLayer === layer;
      btn.setAttribute('data-active', String(isSelected));
    });

    if (layer === 'off' || !viewer) {
      if (!silent) logEvent('Global weather tile layer disabled.', 'info');
      return;
    }

    if (lastWeatherData && !lastWeatherData.owmTilesAvailable && !silent) {
      logEvent(
        'OpenWeatherMap global raster tiles require OPENWEATHERMAP_API_KEY in Settings -> Secrets. 3D site wind & cloud overlay remains active.',
        'warn'
      );
      showToast('Set OPENWEATHERMAP_API_KEY in Secrets for global OWM raster tiles.');
    }

    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `/api/weather/tile/${layer}/{z}/{x}/{y}.png`,
      maximumLevel: 12,
      credit: 'OpenWeatherMap',
    });
    weatherImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    weatherImageryLayer.alpha = weatherOpacity;

    if (!silent) {
      const labels: Record<WeatherTileLayer, string> = {
        off: 'Off',
        clouds_new: 'Global Clouds',
        wind_new: 'Global Wind',
        precipitation_new: 'Global Precipitation',
        temp_new: 'Global Temperature',
      };
      logEvent(`Enabled OpenWeatherMap layer: ${labels[layer]}.`, 'ok');
    }
  }

  async function fetchAndRenderSiteWeather(
    lat: number,
    lon: number,
    silent = false
  ): Promise<SiteWeatherData | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    lastWeatherLat = lat;
    lastWeatherLon = lon;
    const reqId = ++weatherFetchSeq;

    try {
      const res = await fetch(`/api/weather/current?lat=${encodeURIComponent(lat.toFixed(5))}&lon=${encodeURIComponent(lon.toFixed(5))}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SiteWeatherData;
      if (reqId !== weatherFetchSeq) return lastWeatherData; // stale response guard

      lastWeatherData = data;
      renderWeatherHud(data);

      if (!silent) {
        logEvent(
          `Weather (${data.stationName}): ${formatTemp(data.tempC)}, wind ${formatWind(data.windSpeedMps)} ${data.windCardinal}, clouds ${Math.round(data.cloudCoverPct)}%.`,
          'ok'
        );
      }
      return data;
    } catch (err: any) {
      if (reqId !== weatherFetchSeq) return lastWeatherData;
      const condEl = el<HTMLParagraphElement>('weather-condition');
      if (condEl) condEl.textContent = 'Weather feed temporarily unavailable';
      logEvent(`Weather fetch failed: ${err?.message || err}`, 'warn');
      return null;
    }
  }

  function scheduleCameraWeatherSync(): void {
    if (weatherMoveDebounce !== null) {
      window.clearTimeout(weatherMoveDebounce);
    }
    weatherMoveDebounce = window.setTimeout(() => {
      if (!viewer?.camera?.positionCartographic) return;
      const camAlt = viewer.camera.positionCartographic.height;
      // Only auto-sync weather when viewing regional/site scale (< 350 km)
      if (camAlt > 350000) return;

      const target = pickViewportTarget();
      const carto = target ? Cesium.Cartographic.fromCartesian(target) : viewer.camera.positionCartographic;
      if (!carto) return;

      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const movedDeg = Math.hypot(lat - lastWeatherLat, lon - lastWeatherLon);
      if (movedDeg >= 0.025) {
        fetchAndRenderSiteWeather(lat, lon, true);
      }
    }, 900);
  }

  // =========================================================================
  // Map Labels & Borders Overlay + Live Reverse-Geocoded Location Readout
  // =========================================================================

  async function ensureMapLabelImageryLayer(): Promise<void> {
    if (!viewer) return;
    const shouldShow = mapLabelsEnabled && !mapLabelsTempHidden;
    if (mapLabelsImageryLayer) {
      try {
        if (viewer.imageryLayers.contains(mapLabelsImageryLayer)) {
          mapLabelsImageryLayer.show = shouldShow;
          return;
        }
      } catch {
        mapLabelsImageryLayer = null;
      }
    }
    if (mapLabelsImageryLoading) return;
    mapLabelsImageryLoading = true;
    const gen = mapLabelsImageryGeneration;
    try {
      // Public Esri ArcGIS World Boundaries & Places reference overlay (no API key, transparent RGBA)
      const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer'
      );
      if (!viewer || gen !== mapLabelsImageryGeneration) return;
      mapLabelsImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      mapLabelsImageryLayer.alpha = 0.92;
      mapLabelsImageryLayer.show = mapLabelsEnabled && !mapLabelsTempHidden;
    } catch (err) {
      console.warn('Map labels tile overlay could not be initialized:', err);
    } finally {
      if (gen === mapLabelsImageryGeneration) {
        mapLabelsImageryLoading = false;
      }
    }
  }

  function updateMapLabelHorizonVisibility(): void {
    if (!viewer || mapLabelEntities.length === 0) return;
    if (!mapLabelsEnabled || mapLabelsTempHidden) {
      for (const item of mapLabelEntities) {
        item.entity.show = false;
      }
      return;
    }

    let occluder: any = null;
    try {
      let camPos = viewer.camera.positionWC;
      const carto = viewer.camera.positionCartographic;
      if (carto && carto.height < 15) {
        camPos = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 50);
      }
      occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camPos);
    } catch {
      occluder = null;
    }

    for (const item of mapLabelEntities) {
      item.entity.show = occluder ? occluder.isPointVisible(item.position) : true;
    }
  }

  function ensureMapLabelEntities(): void {
    if (!viewer?.entities || mapLabelEntities.length > 0) return;

    const countryDist = new Cesium.DistanceDisplayCondition(900_000, 28_000_000);
    const stateDist = new Cesium.DistanceDisplayCondition(120_000, 4_200_000);
    const cityDist = new Cesium.DistanceDisplayCondition(1_200, 1_200_000);
    const countryColor = Cesium.Color.fromCssColorString('#f3dc9f').withAlpha(0.92);
    const stateColor = Cesium.Color.fromCssColorString('#cbd5e1').withAlpha(0.88);
    const cityColor = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.95);
    const outlineDark = Cesium.Color.fromCssColorString('#06080d').withAlpha(0.92);

    for (const p of WORLD_COUNTRIES) {
      const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 5000);
      const entity = viewer.entities.add({
        show: false,
        position,
        label: {
          text: p.name,
          font: '600 12px "JetBrains Mono", monospace',
          fillColor: countryColor,
          outlineColor: outlineDark,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          distanceDisplayCondition: countryDist,
          disableDepthTestDistance: 0,
        },
      });
      mapLabelEntities.push({ entity, position });
    }

    for (const p of US_STATES) {
      const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 2500);
      const entity = viewer.entities.add({
        show: false,
        position,
        label: {
          text: p.name.toUpperCase(),
          font: '500 10.5px "JetBrains Mono", monospace',
          fillColor: stateColor,
          outlineColor: outlineDark,
          outlineWidth: 2.5,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          distanceDisplayCondition: stateDist,
          disableDepthTestDistance: 0,
        },
      });
      mapLabelEntities.push({ entity, position });
    }

    for (const p of MAJOR_CITIES) {
      const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 400);
      const entity = viewer.entities.add({
        show: false,
        position,
        point: {
          pixelSize: 4.5,
          color: Cesium.Color.fromCssColorString('#e7cb88'),
          outlineColor: outlineDark,
          outlineWidth: 1.5,
          distanceDisplayCondition: cityDist,
          disableDepthTestDistance: 35_000,
        },
        label: {
          text: p.sub ? `${p.name}, ${p.sub}` : p.name,
          font: '600 11px "Plus Jakarta Sans", system-ui, sans-serif',
          fillColor: cityColor,
          outlineColor: outlineDark,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(7, 0),
          distanceDisplayCondition: cityDist,
          disableDepthTestDistance: 35_000,
        },
      });
      mapLabelEntities.push({ entity, position });
    }
  }

  function setMapLabelsTemporarilyHidden(hidden: boolean): void {
    mapLabelsTempHidden = hidden;
    const visible = !hidden && mapLabelsEnabled;
    if (mapLabelsImageryLayer) {
      mapLabelsImageryLayer.show = visible;
    }
    updateMapLabelHorizonVisibility();
  }

  function setMapLabelsEnabled(enabled: boolean, silent = false): void {
    mapLabelsEnabled = enabled;
    void ensureMapLabelImageryLayer();
    ensureMapLabelEntities();
    if (mapLabelsImageryLayer) {
      mapLabelsImageryLayer.show = enabled && !mapLabelsTempHidden;
    }
    updateMapLabelHorizonVisibility();
    updateLayerButton('btn-toggle-map-labels', 'status-map-labels', enabled);
    const hudBtn = el<HTMLButtonElement>('btn-hud-map-labels');
    if (hudBtn) {
      hudBtn.setAttribute('data-active', String(enabled));
    }
    if (!silent) {
      showToast(enabled ? 'Map Labels & Borders Overlay ON' : 'Map Labels Overlay OFF');
      logEvent(enabled ? 'Map Labels & Borders overlay enabled.' : 'Map Labels overlay hidden.', 'info');
    }
    notifyUiStateChanged();
  }

  function formatLocationForAltitude(
    data: NonNullable<typeof lastReverseData>,
    altMeters: number
  ): string {
    if (data.ocean && !data.country && !data.city) {
      return data.ocean;
    }
    const regionShort = data.regionCode || data.region;
    const countryShort = data.countryCode || data.country;

    // High orbital altitude (> 2,200 km): show Country
    if (altMeters > 2_200_000) {
      return data.country || data.ocean || 'Earth Orbit';
    }
    // Regional altitude (65 km – 2,200 km): show State / Region · Country
    if (altMeters > 65_000) {
      if (data.region && countryShort) return `${data.region} · ${countryShort}`;
      return data.region || data.country || data.ocean || 'Earth View';
    }
    // City / Street / Building altitude (< 65 km): show City, State · Country
    if (data.city && regionShort && countryShort) {
      return `${data.city}, ${regionShort} · ${countryShort}`;
    }
    if (data.city && countryShort) {
      return `${data.city} · ${countryShort}`;
    }
    if (data.region && countryShort) {
      return `${data.region} · ${countryShort}`;
    }
    return data.country || data.ocean || 'Unknown Region';
  }

  function updateHudLocationDisplay(): void {
    const locEl = el<HTMLSpanElement>('hud-location-text');
    if (!locEl || !lastReverseData) return;
    const alt = viewer?.camera?.positionCartographic?.height ?? 500;
    locEl.textContent = formatLocationForAltitude(lastReverseData, alt);
  }

  async function refreshLiveLocationReadout(force = false): Promise<void> {
    if (!viewer?.scene || isRenderingPath || isCapturingGeoBox) return;
    const canvas = viewer.scene.canvas;
    const camCarto = viewer.camera?.positionCartographic;
    const camAlt = camCarto?.height ?? 0;

    let lat: number | null = null;
    let lon: number | null = null;

    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const centerPx = new Cesium.Cartesian2(canvas.clientWidth * 0.5, canvas.clientHeight * 0.5);
      if (camAlt > 50_000) {
        // High altitude / orbital view: intersect WGS84 ellipsoid cleanly without depth-buffer artifacts
        const ellipPos = viewer.camera.pickEllipsoid(centerPx, Cesium.Ellipsoid.WGS84);
        if (ellipPos) {
          const c = Cesium.Cartographic.fromCartesian(ellipPos);
          if (c) {
            lat = Cesium.Math.toDegrees(c.latitude);
            lon = Cesium.Math.toDegrees(c.longitude);
          }
        }
      } else {
        const picked = pickGeoSurfacePoint(centerPx);
        if (picked && Number.isFinite(picked.lat) && Number.isFinite(picked.lon)) {
          lat = picked.lat;
          lon = picked.lon;
        }
      }
    }

    if ((lat === null || lon === null) && camCarto) {
      lat = Cesium.Math.toDegrees(camCarto.latitude);
      lon = Cesium.Math.toDegrees(camCarto.longitude);
    }
    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }

    const movedEnough =
      force ||
      !Number.isFinite(lastReverseLat) ||
      Math.abs(lat - lastReverseLat) > 0.008 ||
      Math.abs(lon - lastReverseLon) > 0.008;

    if (!movedEnough) {
      updateHudLocationDisplay();
      return;
    }

    lastReverseLat = lat;
    lastReverseLon = lon;
    try {
      const resp = await fetch(`/api/maps/reverse?lat=${encodeURIComponent(lat.toFixed(5))}&lon=${encodeURIComponent(lon.toFixed(5))}`);
      if (!resp.ok) return;
      const data = await resp.json();
      lastReverseData = {
        city: data.city ?? null,
        region: data.region ?? null,
        regionCode: data.regionCode ?? null,
        country: data.country ?? null,
        countryCode: data.countryCode ?? null,
        ocean: data.ocean ?? null,
      };
      updateHudLocationDisplay();
    } catch {
      // Keep last known location silently on transient network error
    }
  }

  function scheduleLiveLocationLookup(): void {
    if (reverseGeocodeTimer !== null) {
      window.clearTimeout(reverseGeocodeTimer);
    }
    reverseGeocodeTimer = window.setTimeout(() => {
      reverseGeocodeTimer = null;
      void refreshLiveLocationReadout(false);
    }, 600);
  }

  /**
   * Initializes the CesiumJS 1.147 Viewer on a guaranteed WGS84 Globe with public satellite imagery.
   */
  async function initCesium(): Promise<void> {
    try {
      builtinCesiumToken = Cesium.Ion.defaultAccessToken || '';

      viewer = new Cesium.Viewer('cesium-container', {
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        msaaSamples: 4,
        contextOptions: {
          webgl: {
            preserveDrawingBuffer: true,
          },
        },
      });

      viewer.scene.globe.show = true;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#111827');
      viewer.scene.globe.depthTestAgainstTerrain = false;
      viewer.scene.skyAtmosphere.show = true;

      // WebGL context resilience
      const canvas = viewer.scene.canvas as HTMLCanvasElement;
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        if (webglFallback) webglFallback.classList.remove('hidden');
        logEvent('WebGL context lost.', 'error');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        if (webglFallback) webglFallback.classList.add('hidden');
        logEvent('WebGL context restored.', 'ok');
      });

      // Load CORS-friendly public satellite imagery (works inside iframes without an ion token)
      try {
        const arcgisSatellite = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
        );
        viewer.imageryLayers.addImageryProvider(arcgisSatellite);
        if (ionStatusText) ionStatusText.textContent = 'Satellite Globe (No ion Token)';
      } catch {
        logEvent('ArcGIS imagery blocked; falling back to OpenStreetMap...', 'warn');
        viewer.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
        );
        if (ionStatusText) ionStatusText.textContent = 'OSM Globe (No ion Token)';
      }

      // Initial panel & HUD visibility is already synced synchronously before async globe setup.

      // Scene hooks: Pre-update for Drone Flight, Post-render for Telemetry, Camera listeners for Horizon Culling, Weather & Location Sync
      viewer.camera.percentageChanged = 0.05;
      viewer.scene.preUpdate.addEventListener(handlePreUpdate);
      viewer.scene.postRender.addEventListener(updateTelemetry);
      viewer.camera.changed.addEventListener(updateMapLabelHorizonVisibility);
      viewer.camera.moveEnd.addEventListener(updateMapLabelHorizonVisibility);
      viewer.camera.moveEnd.addEventListener(scheduleCameraWeatherSync);
      viewer.camera.moveEnd.addEventListener(scheduleLiveLocationLookup);

      // Default starting camera over the Continental US
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-96.0, 38.5, 9500000),
        orientation: {
          heading: 0.0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0.0,
        },
      });

      // Enable dual-layer Map Labels (Esri World Boundaries & Places + horizon-culled 3D labels over 3D tiles)
      setMapLabelsEnabled(true, true);
      updateMapLabelHorizonVisibility();
      void refreshLiveLocationReadout(true);

      applyLensPreset(activeLensMm);
      logEvent('CesiumJS 1.147 WGS84 Globe initialized.', 'ok');
      setupUI();

      // Load initial real-time site weather for the default WGS84 coordinates
      fetchAndRenderSiteWeather(lastWeatherLat, lastWeatherLon, true);

      // Check for saved or default Cesium ion token
      const savedToken = DEFAULT_ION_TOKEN || localStorage.getItem(STORAGE_KEY) || '';
      if (savedToken.trim()) {
        if (inputIonToken) inputIonToken.value = savedToken.trim();
        await connectCesiumIon(savedToken.trim(), true);
      } else {
        logEvent('Click "ion Token" to unlock World Terrain & 3DGS Tilesets.', 'info');
      }

      // Render initial Survey Catalog UI and resolve ?manifest=, ?survey=, ?compare= URL parameters
      const params = new URLSearchParams(window.location.search);
      const manifestUrl = params.get('manifest');
      const requestedSurveyId = params.get('survey');
      const requestedCompareId = params.get('compare');

      if (manifestUrl) {
        await loadManifestFromUrl(manifestUrl, {
          requestedSurveyId,
          requestedCompareId,
        });
      } else {
        if (requestedSurveyId) {
          const existing = surveyCatalog.find(
            (s) =>
              s.surveyId.toLowerCase() === requestedSurveyId.trim().toLowerCase() ||
              s.capturedAt === requestedSurveyId.trim()
          );
          if (existing) {
            activeSurveyId = existing.surveyId;
          } else {
            // Preserve deep-linked survey ID on the active epoch until a manifest is loaded
            const active = getActiveSurvey();
            active.surveyId = requestedSurveyId.trim();
            active.capturedAt = toIsoDateOnly(requestedSurveyId.trim());
            activeSurveyId = active.surveyId;
          }
          surveyCatalogTouched = true;
        }
        if (requestedCompareId && requestedCompareId.trim() !== activeSurveyId) {
          compareSurveyId = requestedCompareId.trim();
          surveyCatalogTouched = true;
        }
        renderSurveyCatalogUI();
      }
    } catch (err: any) {
      console.error('Cesium init error:', err);
      logEvent(`Cesium init failed: ${err?.message || err}`, 'error');
      showToast('Failed to initialize CesiumJS WebGL globe.', 'error');
    }
  }

  /**
   * Applies a Cesium ion access token and upgrades the globe to World Terrain + Aerial Imagery.
   */
  async function connectCesiumIon(token: string, silent = false): Promise<void> {
    if (!token || !token.trim()) {
      showToast('Please paste a valid Cesium ion token.', 'error');
      return;
    }

    if (loadingText) loadingText.textContent = 'Connecting to Cesium ion...';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
      Cesium.Ion.defaultAccessToken = token.trim();

      try {
        const aerialProvider = await Cesium.IonImageryProvider.fromAssetId(2);
        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(aerialProvider);
        mapLabelsImageryGeneration += 1;
        mapLabelsImageryLayer = null;
        mapLabelsImageryLoading = false;
        if (activeWeatherLayer !== 'off') {
          setWeatherTileLayer(activeWeatherLayer, true);
        }
        if (mapLabelsEnabled) {
          void ensureMapLabelImageryLayer();
        }
      } catch {
        logEvent('Token does not include Bing Aerial (Asset #2)—keeping satellite base layer.', 'warn');
      }

      try {
        const worldTerrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
        viewer.terrainProvider = worldTerrain;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        worldTerrainEnabled = true;
        updateLayerButton('btn-toggle-terrain', 'status-terrain', true);
      } catch {
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        viewer.scene.globe.depthTestAgainstTerrain = false;
        worldTerrainEnabled = false;
        updateLayerButton('btn-toggle-terrain', 'status-terrain', false);
        logEvent('Token does not include World Terrain (Asset #1)—keeping WGS84 Ellipsoid.', 'warn');
      }

      viewer.scene.globe.show = true;
      ionConnected = true;
      localStorage.setItem(STORAGE_KEY, token.trim());

      if (ionStatusDot) ionStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0';
      if (ionStatusText) ionStatusText.textContent = 'Cesium ion Connected';

      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      if (tokenModal) tokenModal.classList.add('hidden');
      logEvent('Connected to Cesium ion (World Terrain + Aerial active).', 'ok');
      if (!silent) showToast('Cesium ion connected.');
    } catch (err: any) {
      console.error('Cesium ion connection failed:', err);
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      ionConnected = false;
      if (ionStatusDot) ionStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-red-500 shrink-0';
      if (ionStatusText) ionStatusText.textContent = 'Token Invalid';
      logEvent(`Cesium ion auth failed: ${err?.message || err}`, 'error');
      showToast('Cesium ion token failed. Check token scopes.', 'error');
    }
  }

  /**
   * Loads a 3D Tileset (including 3D Gaussian Splats with HLODs) by Cesium ion Asset ID.
   */
  async function loadIonTileset(
    assetId: string | number,
    label = ''
  ): Promise<{ ok: boolean; assetId?: number; name?: string; error?: string; requiresToken?: boolean }> {
    let numericId = parseInt(String(assetId || '').trim(), 10);
    if (isNaN(numericId) || numericId <= 0) {
      showToast('Enter a valid numeric Cesium ion Asset ID.', 'error');
      return { ok: false, error: 'Invalid numeric Cesium ion Asset ID.' };
    }

    if (numericId === 454722) {
      numericId = REDMOND_SPLAT_ASSET_ID;
      const assetInput = el<HTMLInputElement>('input-asset-id');
      if (assetInput) assetInput.value = String(REDMOND_SPLAT_ASSET_ID);
      if (!label) label = 'Redmond 110M Splat';
      logEvent('Auto-corrected Asset ID 454722 -> 4547222 (Redmond 110M Splat).', 'info');
    }

    const isPublicDemo = numericId === REDMOND_SPLAT_ASSET_ID;
    if (!ionConnected && !isPublicDemo) {
      if (tokenModal) tokenModal.classList.remove('hidden');
      showToast('Connect your Cesium ion token first.', 'info');
      return {
        ok: false,
        assetId: numericId,
        requiresToken: true,
        error: 'Cesium ion token not connected. Opened the ion Token modal.',
      };
    }

    const existing = activeTilesets.find((t) => t.id === numericId);
    if (existing) {
      setFlightMode('explore');
      viewer.zoomTo(existing.tileset);
      showToast(`Flying to ${existing.name}`);
      return { ok: true, assetId: existing.id, name: existing.name };
    }

    const displayName = label || `Asset #${numericId}`;
    if (loadingText) loadingText.textContent = `Streaming ${displayName}...`;
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    logEvent(`Requesting Cesium ion 3D Tileset #${numericId}...`, 'info');

    try {
      let tileset: any;
      try {
        if (ionConnected) {
          tileset = await Cesium.Cesium3DTileset.fromIonAssetId(numericId, {
            maximumScreenSpaceError: currentSSE,
          });
        } else if (isPublicDemo && builtinCesiumToken) {
          const resource = await Cesium.IonResource.fromAssetId(numericId, {
            accessToken: builtinCesiumToken,
          });
          tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {
            maximumScreenSpaceError: currentSSE,
          });
        } else {
          throw new Error('No Cesium ion token available.');
        }
      } catch (primaryErr) {
        if (isPublicDemo && builtinCesiumToken && Cesium.Ion.defaultAccessToken !== builtinCesiumToken) {
          logEvent('Token scoped to specific assets—retrying public demo with built-in token...', 'warn');
          const resource = await Cesium.IonResource.fromAssetId(numericId, {
            accessToken: builtinCesiumToken,
          });
          tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {
            maximumScreenSpaceError: currentSSE,
          });
        } else {
          throw primaryErr;
        }
      }

      viewer.scene.primitives.add(tileset);
      const entry: TilesetEntry = {
        id: numericId,
        name: displayName,
        tileset,
        visible: true,
      };
      activeTilesets.push(entry);

      if (currentHeightOffset !== 0) {
        applyHeightOffsetToTileset(tileset, currentHeightOffset);
      }

      renderTilesetList();
      updateTilesetMetric();
      setFlightMode('explore');

      if (isPublicDemo) {
        const seq = ++activeFlySeq;
        pendingCameraTarget = {
          lat: 47.644605,
          lon: -122.141186,
          ellipsoidalHeight: 170.48,
          heading: 100.0,
          pitch: -25.0,
          roll: 0.0,
        };
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(-122.141186, 47.644605, 170.48),
          orientation: {
            heading: Cesium.Math.toRadians(100.0),
            pitch: Cesium.Math.toRadians(-25.0),
            roll: 0.0,
          },
          duration: 2.2,
          complete: () => {
            if (activeFlySeq === seq) pendingCameraTarget = null;
          },
          cancel: () => {
            if (activeFlySeq === seq) pendingCameraTarget = null;
          },
        });
        fetchAndRenderSiteWeather(47.644605, -122.141186, false);
      } else {
        await viewer.zoomTo(tileset);
        if (tileset?.boundingSphere?.center) {
          const carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
          if (carto) {
            fetchAndRenderSiteWeather(
              Cesium.Math.toDegrees(carto.latitude),
              Cesium.Math.toDegrees(carto.longitude),
              false
            );
          }
        }
      }

      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      logEvent(`Streaming "${displayName}" (#${numericId}) with LOD SSE=${currentSSE}px.`, 'ok');
      showToast(`Loaded ${displayName}`);
      return { ok: true, assetId: numericId, name: displayName };
    } catch (err: any) {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      const status = err?.statusCode ?? null;
      const code = status
        ? `HTTP ${status}`
        : err?.message
          ? String(err.message).replace(/access_token=[^&\s"]+/gi, 'access_token=[REDACTED]')
          : 'Unknown error';

      console.warn(`Tileset ${numericId} could not be loaded (${code}).`);
      logEvent(`Asset #${numericId} failed (${code}).`, 'error');

      if (status === 404) {
        showToast(`Asset #${numericId} not found (404). Check the Asset ID.`, 'error');
      } else if (status === 401 || status === 403) {
        showToast(`Access denied (${code}) for Asset #${numericId}. Check token scope.`, 'error');
      } else {
        showToast(`Could not load Asset #${numericId} (${code}).`, 'error');
      }
      return { ok: false, assetId: numericId, error: `Could not load Asset #${numericId} (${code}).` };
    }
  }

  function applyHeightOffsetToTileset(tileset: any, heightMeters: number): void {
    if (!tileset || !tileset.boundingSphere) return;
    const center = tileset.boundingSphere.center;
    if (!center || Cesium.Cartesian3.equals(center, Cesium.Cartesian3.ZERO)) return;

    const cartographic = Cesium.Cartographic.fromCartesian(center);
    if (!cartographic) return;

    const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0.0);
    const offset = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, heightMeters);
    const translation = Cesium.Cartesian3.subtract(offset, surface, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  async function toggleGoogle3DTiles(): Promise<void> {
    if (!ionConnected) {
      if (tokenModal) tokenModal.classList.remove('hidden');
      showToast('Connect your Cesium ion token first.', 'info');
      return;
    }

    if (google3DEnabled && google3DTileset) {
      google3DTileset.show = false;
      viewer.scene.globe.show = true;
      google3DEnabled = false;
      updateLayerButton('btn-toggle-google3d', 'status-google3d', false);
      logEvent('Google Photorealistic 3D Tiles hidden.', 'info');
      return;
    }

    if (google3DTileset) {
      google3DTileset.show = true;
      viewer.scene.globe.show = false;
      google3DEnabled = true;
      updateLayerButton('btn-toggle-google3d', 'status-google3d', true);
      logEvent('Google Photorealistic 3D Tiles enabled.', 'ok');
      return;
    }

    if (loadingText) loadingText.textContent = 'Loading Google Photorealistic 3D Tiles...';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
      google3DTileset = await Cesium.createGooglePhotorealistic3DTileset({
        onlyUsingWithGoogleGeocoder: true,
      });
      if (activeClippingCollection) {
        google3DTileset.clippingPolygons = activeClippingCollection;
      }
      viewer.scene.primitives.add(google3DTileset);
      viewer.scene.globe.show = false;
      google3DEnabled = true;
      updateLayerButton('btn-toggle-google3d', 'status-google3d', true);
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      logEvent('Google Photorealistic 3D Tiles active.', 'ok');
      showToast('Google Photorealistic 3D Tiles enabled.');
    } catch (err: any) {
      console.error('Google 3D Tiles error:', err);
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      logEvent(`Google 3D Tiles error: ${err?.message || err}`, 'error');
      showToast('Could not load Google 3D Tiles (check ion token permissions).', 'error');
    }
  }

  async function toggleWorldTerrain(): Promise<void> {
    if (!ionConnected) {
      if (tokenModal) tokenModal.classList.remove('hidden');
      showToast('Connect your Cesium ion token first.', 'info');
      return;
    }

    if (!worldTerrainEnabled) {
      try {
        const worldTerrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
        viewer.terrainProvider = worldTerrain;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        worldTerrainEnabled = true;
        logEvent('Cesium World Terrain enabled.', 'ok');
      } catch (err: any) {
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        worldTerrainEnabled = false;
        logEvent(`World Terrain unavailable (${err?.statusCode || err?.message}).`, 'warn');
        showToast('Token does not include World Terrain—staying on Ellipsoid.', 'error');
      }
    } else {
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      viewer.scene.globe.depthTestAgainstTerrain = false;
      worldTerrainEnabled = false;
      logEvent('Switched to flat WGS84 Ellipsoid.', 'info');
    }
    updateLayerButton('btn-toggle-terrain', 'status-terrain', worldTerrainEnabled);
  }

  function updateLayerButton(btnId: string, statusId: string, active: boolean): void {
    const btn = el<HTMLButtonElement>(btnId);
    const status = el<HTMLElement>(statusId);
    if (!btn || !status) return;

    btn.setAttribute('data-active', String(active));
    status.className = active ? 'text-[10px] font-mono text-[#e7cb88]' : 'text-[10px] font-mono text-slate-400';
    status.textContent = active ? 'On' : 'Off';
  }

  function renderTilesetList(): void {
    if (!tilesetListEl) return;
    tilesetListEl.innerHTML = '';
    if (activeTilesets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-[11px] text-zinc-500 italic';
      empty.textContent = 'No custom 3DGS / 3D Tilesets loaded yet.';
      tilesetListEl.appendChild(empty);
      renderSurveyCatalogUI();
      return;
    }

    activeTilesets.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl px-2.5 py-2';

      const info = document.createElement('div');
      info.className = 'min-w-0';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'text-xs font-medium text-zinc-200 truncate';
      titleDiv.textContent = item.name;
      const idDiv = document.createElement('div');
      idDiv.className = 'text-[10px] font-mono text-zinc-500';
      idDiv.textContent = `ID: ${item.id}`;
      info.append(titleDiv, idDiv);

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1 shrink-0';

      const btnFly = document.createElement('button');
      btnFly.type = 'button';
      btnFly.className = 'px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-medium text-zinc-200 transition-colors cursor-pointer';
      btnFly.textContent = 'Fly';
      btnFly.addEventListener('click', () => {
        setFlightMode('explore');
        viewer.zoomTo(item.tileset);
      });

      const btnVis = document.createElement('button');
      btnVis.type = 'button';
      btnVis.className = 'px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-medium text-zinc-300 transition-colors cursor-pointer';
      btnVis.textContent = item.visible ? 'Hide' : 'Show';
      btnVis.addEventListener('click', () => {
        setTilesetVisibleById(item.id, !item.visible);
      });

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'px-2 py-1 rounded-lg bg-red-950/60 hover:bg-red-900/70 text-[10px] font-medium text-red-300 transition-colors cursor-pointer';
      btnDel.textContent = '×';
      btnDel.title = 'Remove Tileset';
      btnDel.addEventListener('click', () => {
        removeTilesetById(item.id);
      });

      actions.append(btnFly, btnVis, btnDel);
      row.append(info, actions);
      tilesetListEl.appendChild(row);
    });
    renderSurveyCatalogUI();
  }

  function setTilesetVisibleById(
    assetId: number,
    visible: boolean
  ): { ok: boolean; assetId: number; name?: string; visible?: boolean; error?: string } {
    const item = activeTilesets.find((t) => t.id === assetId);
    if (!item) {
      return { ok: false, assetId, error: `Tileset #${assetId} is not loaded.` };
    }
    item.visible = Boolean(visible);
    item.tileset.show = item.visible;
    renderTilesetList();
    logEvent(`${item.visible ? 'Shown' : 'Hidden'} "${item.name}" (#${item.id}).`, 'info');
    return { ok: true, assetId: item.id, name: item.name, visible: item.visible };
  }

  function removeTilesetById(
    assetId: number
  ): { ok: boolean; assetId: number; name?: string; error?: string } {
    const item = activeTilesets.find((t) => t.id === assetId);
    if (!item) {
      return { ok: false, assetId, error: `Tileset #${assetId} is not loaded.` };
    }
    if (viewer?.scene?.primitives) {
      viewer.scene.primitives.remove(item.tileset);
    }
    activeTilesets = activeTilesets.filter((t) => t.id !== item.id);
    renderTilesetList();
    updateTilesetMetric();
    logEvent(`Removed "${item.name}" (#${item.id}).`, 'info');
    return { ok: true, assetId: item.id, name: item.name };
  }

  function applySSE(value: number): number {
    const clamped = Math.max(1, Math.min(32, Math.round(value)));
    currentSSE = clamped;
    const sliderSSE = el<HTMLInputElement>('slider-sse');
    const valSSE = el<HTMLSpanElement>('val-sse');
    if (sliderSSE) sliderSSE.value = String(currentSSE);
    if (valSSE) valSSE.textContent = `${currentSSE} px`;
    activeTilesets.forEach((item) => {
      item.tileset.maximumScreenSpaceError = currentSSE;
    });
    return currentSSE;
  }

  function applyHeightNudge(meters: number): number {
    const clamped = Math.max(-60, Math.min(60, Number(meters)));
    currentHeightOffset = Math.round(clamped * 10) / 10;
    const sliderH = el<HTMLInputElement>('slider-height-offset');
    const valH = el<HTMLSpanElement>('val-height-offset');
    if (sliderH) sliderH.value = String(currentHeightOffset);
    if (valH) valH.textContent = `${currentHeightOffset >= 0 ? '+' : ''}${currentHeightOffset.toFixed(1)} m`;
    activeTilesets.forEach((item) => {
      applyHeightOffsetToTileset(item.tileset, currentHeightOffset);
    });
    return currentHeightOffset;
  }

  function applyAirspeed(mps: number): number {
    const clamped = Math.max(5, Math.min(150, Math.round(mps)));
    wasdSpeedMps = clamped;
    const sliderSpeed = el<HTMLInputElement>('slider-flight-speed');
    const valSpeed = el<HTMLSpanElement>('val-flight-speed');
    if (sliderSpeed) sliderSpeed.value = String(wasdSpeedMps);
    if (valSpeed) valSpeed.textContent = `${wasdSpeedMps} m/s`;
    if (flightMode === 'wasd') updateFlightModeButtons();
    return wasdSpeedMps;
  }

  function startRecord360Lap(): { ok: boolean; mode: FlightMode; recording: boolean; orbitRadiusMeters?: number; orbitSpeedDegPerSec?: number; error?: string } {
    if (isRecording) stopRecording();
    setFlightMode('orbit', true);
    if (flightMode === 'orbit') {
      const started = startRecording('360° Survey Orbit');
      return {
        ok: started,
        mode: flightMode,
        recording: isRecording,
        orbitRadiusMeters: Math.round(orbitRangeMeters),
        orbitSpeedDegPerSec,
        error: started ? undefined : 'Could not start WebM recording in this browser.',
      };
    }
    return {
      ok: false,
      mode: flightMode,
      recording: isRecording,
      error: 'Could not lock an orbit target.',
    };
  }

  function updateTilesetMetric(): void {
    const metricEl = el<HTMLDivElement>('metric-tilesets');
    if (metricEl) metricEl.textContent = `${activeTilesets.length}`;
  }

  async function applyClippingGeoJson(assetId: string | number): Promise<void> {
    const numericId = parseInt(String(assetId || '').trim(), 10);
    if (isNaN(numericId) || numericId <= 0) {
      showToast('Enter a valid numeric GeoJSON Asset ID.', 'error');
      return;
    }
    if (!ionConnected) {
      if (tokenModal) tokenModal.classList.remove('hidden');
      showToast('Connect your Cesium ion token first.', 'info');
      return;
    }

    if (loadingText) loadingText.textContent = `Loading Clipping GeoJSON #${numericId}...`;
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
      const resource = await Cesium.IonResource.fromAssetId(numericId);
      const dataSource = await Cesium.GeoJsonDataSource.load(resource);
      const now = Cesium.JulianDate.now();
      const polygons: any[] = [];

      dataSource.entities.values.forEach((entity: any) => {
        if (entity.polygon && entity.polygon.hierarchy) {
          const hierarchy = entity.polygon.hierarchy.getValue(now);
          if (hierarchy && hierarchy.positions && hierarchy.positions.length >= 3) {
            polygons.push(new Cesium.ClippingPolygon({ positions: hierarchy.positions }));
          }
        }
      });

      if (polygons.length === 0) {
        throw new Error('GeoJSON contains no valid polygon geometries.');
      }

      activeClippingCollection = new Cesium.ClippingPolygonCollection({ polygons });
      activeClipAssetId = numericId;

      if (viewer?.scene?.globe) {
        viewer.scene.globe.clippingPolygons = activeClippingCollection;
      }
      if (google3DTileset) {
        google3DTileset.clippingPolygons = activeClippingCollection;
      }

      const statusEl = el<HTMLSpanElement>('clip-status');
      if (statusEl) {
        statusEl.textContent = `#${numericId} (${polygons.length} poly)`;
        statusEl.className = 'text-[11px] font-mono text-emerald-300 font-medium';
      }

      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      logEvent(`Applied Clipping Polygon #${numericId} (${polygons.length} polygon${polygons.length > 1 ? 's' : ''}).`, 'ok');
      showToast(`Clipping cutout #${numericId} applied.`);
    } catch (err: any) {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      const msg = String(err?.message || 'Unknown error').replace(/access_token=[^&\s"]+/gi, 'access_token=[REDACTED]');
      logEvent(`Clipping GeoJSON #${numericId} failed: ${msg}`, 'error');
      showToast(`Could not load Clipping GeoJSON #${numericId}.`, 'error');
    }
  }

  function clearClippingGeoJson(): void {
    activeClipAssetId = null;
    activeClippingCollection = null;
    if (viewer?.scene?.globe) {
      viewer.scene.globe.clippingPolygons = undefined;
    }
    if (google3DTileset) {
      google3DTileset.clippingPolygons = undefined;
    }
    const input = el<HTMLInputElement>('input-clip-asset-id');
    if (input) input.value = '';
    const statusEl = el<HTMLSpanElement>('clip-status');
    if (statusEl) {
      statusEl.textContent = 'None';
      statusEl.className = 'text-[11px] font-mono text-zinc-500';
    }
    logEvent('Cleared clipping polygon cutout.', 'info');
  }

  function saveCurrentCameraBookmark(nameOverride?: string): CameraBookmark | null {
    if (!viewer?.camera) return null;
    const carto = viewer.camera.positionCartographic;
    if (!carto) return null;

    const nameInput = el<HTMLInputElement>('input-bookmark-name');
    const customName = (nameOverride?.trim()) || (nameInput?.value.trim()) || `View ${cameraBookmarks.length + 1}`;

    const bookmark: CameraBookmark = {
      name: customName,
      lat: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
      lon: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)),
      alt: Number(carto.height.toFixed(2)),
      heading: Number(Cesium.Math.toDegrees(viewer.camera.heading).toFixed(2)),
      pitch: Number(Cesium.Math.toDegrees(viewer.camera.pitch).toFixed(2)),
      roll: Number(Cesium.Math.toDegrees(viewer.camera.roll).toFixed(2)),
    };

    cameraBookmarks.push(bookmark);
    if (!nameOverride && nameInput) nameInput.value = '';
    renderBookmarkList();
    logEvent(`Saved camera bookmark "${bookmark.name}".`, 'ok');
    showToast(`Saved bookmark: ${bookmark.name}`);
    return bookmark;
  }

  function flyToBookmark(bm: CameraBookmark): void {
    if (!viewer || !bm) return;
    setFlightMode('explore');
    const headingDeg = bm.heading || 0;
    const pitchDeg = bm.pitch ?? -30;
    const rollDeg = bm.roll || 0;
    const seq = ++activeFlySeq;
    pendingCameraTarget = {
      lat: Number(bm.lat.toFixed(6)),
      lon: Number(bm.lon.toFixed(6)),
      ellipsoidalHeight: Number(bm.alt.toFixed(2)),
      heading: Number(headingDeg.toFixed(2)),
      pitch: Number(pitchDeg.toFixed(2)),
      roll: Number(rollDeg.toFixed(2)),
    };
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(bm.lon, bm.lat, bm.alt),
      orientation: {
        heading: Cesium.Math.toRadians(headingDeg),
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: Cesium.Math.toRadians(rollDeg),
      },
      duration: 1.8,
      complete: () => {
        if (activeFlySeq === seq) pendingCameraTarget = null;
      },
      cancel: () => {
        if (activeFlySeq === seq) pendingCameraTarget = null;
      },
    });
    fetchAndRenderSiteWeather(bm.lat, bm.lon, true);
    logEvent(`Flying to bookmark "${bm.name}".`, 'info');
  }

  function renderBookmarkList(): void {
    if (!bookmarkListEl) return;
    bookmarkListEl.innerHTML = '';
    const countEl = el<HTMLSpanElement>('bookmark-count');
    if (countEl) countEl.textContent = `${cameraBookmarks.length} saved`;

    if (cameraBookmarks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-[11px] text-zinc-500 italic';
      empty.textContent = 'No camera views saved yet.';
      bookmarkListEl.appendChild(empty);
      renderSurveyCatalogUI();
      return;
    }

    cameraBookmarks.forEach((bm, idx) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl px-2.5 py-1.5';

      const info = document.createElement('div');
      info.className = 'min-w-0';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'text-xs font-medium text-zinc-200 truncate';
      titleDiv.textContent = bm.name;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'text-[10px] font-mono text-zinc-500 tabular-nums';
      metaDiv.textContent = `${bm.lat.toFixed(4)}°, ${bm.lon.toFixed(4)}° · ${Math.round(bm.alt)}m`;
      info.append(titleDiv, metaDiv);

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1 shrink-0';

      const btnFly = document.createElement('button');
      btnFly.type = 'button';
      btnFly.className = 'chrono-pusher px-2 py-1 rounded-md text-[10px] font-medium cursor-pointer';
      btnFly.textContent = 'Fly';
      btnFly.addEventListener('click', () => {
        flyToBookmark(bm);
        setActiveCard(null);
      });

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'px-2 py-1 rounded-lg bg-red-950/60 hover:bg-red-900/70 text-[10px] font-medium text-red-300 transition-colors cursor-pointer';
      btnDel.textContent = '×';
      btnDel.title = 'Delete Bookmark';
      btnDel.addEventListener('click', () => {
        cameraBookmarks.splice(idx, 1);
        renderBookmarkList();
      });

      actions.append(btnFly, btnDel);
      row.append(info, actions);
      bookmarkListEl.appendChild(row);
    });
    renderSurveyCatalogUI();
  }

  // =========================================================================
  // Survey Catalog (Schema 2.0) — Dated Epochs, URL Routing & B/A Hook
  // =========================================================================

  function getActiveSurvey(): SurveyRecord {
    let found = surveyCatalog.find((s) => s.surveyId === activeSurveyId);
    if (!found) {
      if (surveyCatalog.length === 0) {
        surveyCatalog = [createDefaultSurveyRecord({ label: 'Baseline Survey', status: 'planned' })];
      }
      found = surveyCatalog[0];
      activeSurveyId = found.surveyId;
    }
    return found;
  }

  function parseSplatReferenceInput(raw: string, label: string): SurveyRecord['assets']['splat'] {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const id = Number(trimmed);
      if (Number.isFinite(id) && id > 0) {
        return {
          name: `${label} 3DGS`,
          ionAssetId: id,
          url: null,
          format: '3dtiles-3dgs',
        };
      }
    }
    const lower = trimmed.toLowerCase();
    const format = lower.endsWith('.ply')
      ? 'ply'
      : lower.endsWith('.spz')
        ? 'spz'
        : lower.endsWith('.splat')
          ? 'splat'
          : 'url';
    return {
      name: `${label} Splat`,
      ionAssetId: null,
      url: trimmed,
      format,
    };
  }

  function formatSplatReferenceInput(splat: SurveyRecord['assets']['splat']): string {
    if (!splat) return '';
    if (splat.url) return splat.url;
    if (typeof splat.ionAssetId === 'number' && splat.ionAssetId > 0) {
      return String(splat.ionAssetId);
    }
    return '';
  }

  function syncSurveyUrlParams(forceWrite = false): void {
    try {
      const url = new URL(window.location.href);
      const hadSurveyParam = url.searchParams.has('survey') || url.searchParams.has('compare');
      if (!forceWrite && !hadSurveyParam && !surveyCatalogTouched && surveyCatalog.length <= 1) {
        return;
      }
      url.searchParams.set('survey', activeSurveyId);
      if (compareSurveyId && compareSurveyId !== activeSurveyId) {
        url.searchParams.set('compare', compareSurveyId);
      } else {
        url.searchParams.delete('compare');
      }
      window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore history restrictions inside sandboxed iframes
    }
  }

  function syncLiveSceneIntoActiveSurvey(): void {
    const active = getActiveSurvey();
    const liveTilesets: SurveyTilesetRef[] = activeTilesets.map((t) => {
      const lower = t.name.toLowerCase();
      const inferredType =
        lower.includes('splat') || lower.includes('3dgs') || lower.includes('gaussian')
          ? '3dgs'
          : '3dtiles';
      return {
        name: t.name,
        ionAssetId: t.id,
        type: inferredType,
        visible: t.visible,
        clippingGeoJsonAssetId: activeClipAssetId,
      };
    });

    // Preserve explicit offline/unconnected tileset refs if live scene hasn't loaded ion tiles yet
    const effectiveTilesets =
      liveTilesets.length > 0 || ionConnected ? liveTilesets : active.assets.tilesets;
    const classified = classifyTilesetRefs(effectiveTilesets);

    active.verticalOffsetMeters = Number(currentHeightOffset.toFixed(2));
    active.assets.tilesets = effectiveTilesets;
    active.assets.mesh = classified.mesh;
    if (classified.splat && !active.assets.splat?.url) {
      active.assets.splat = classified.splat;
    }
    active.assets.clippingGeoJsonAssetId = activeClipAssetId;
    active.assets.imagery = {
      provider: google3DEnabled
        ? 'Google Photorealistic 3D Tiles'
        : ionConnected
          ? 'Cesium ion Bing Aerial'
          : 'Esri World Imagery',
      capturedAt: active.capturedAt,
    };
    active.bookmarks = cameraBookmarks.map((b) => ({ ...b }));
    active.provenance.updatedAt = new Date().toISOString();
  }

  function clearAllLoadedTilesets(): void {
    if (viewer?.scene?.primitives) {
      for (const item of activeTilesets) {
        try {
          viewer.scene.primitives.remove(item.tileset);
        } catch {
          // Ignore already-removed primitive
        }
      }
    }
    activeTilesets = [];
    renderTilesetList();
    updateTilesetMetric();
  }

  function renderSurveyCatalogUI(): void {
    const active = getActiveSurvey();
    const ordered = sortSurveysNewestFirst(surveyCatalog);

    const countEl = el<HTMLSpanElement>('survey-count');
    if (countEl) {
      countEl.textContent = `${ordered.length} ${ordered.length === 1 ? 'epoch' : 'epochs'}`;
    }

    const activeIdEl = el<HTMLSpanElement>('survey-active-id');
    if (activeIdEl) {
      activeIdEl.textContent = active.surveyId;
      activeIdEl.title = `Active Survey ID: ${active.surveyId}`;
    }

    // Subtle header badge appears once multiple epochs exist, a compare hook is armed, or a manifest/survey was activated
    const hudSurveyBtn = el<HTMLButtonElement>('btn-hud-survey');
    const hudSurveyLabel = el<HTMLSpanElement>('hud-survey-label');
    if (hudSurveyBtn && hudSurveyLabel) {
      const showBadge = surveyCatalogTouched || ordered.length > 1 || Boolean(compareSurveyId);
      hudSurveyBtn.classList.toggle('hidden', !showBadge);
      hudSurveyBtn.classList.toggle('flex', showBadge);
      hudSurveyLabel.textContent = compareSurveyId
        ? `${active.capturedAt} ↔ B/A`
        : `${active.capturedAt} · ${active.label}`;
    }

    // Populate active survey inline metadata editor (avoid clobbering focused input)
    const dateInput = el<HTMLInputElement>('input-active-survey-date');
    const labelInput = el<HTMLInputElement>('input-active-survey-label');
    const statusSelect = el<HTMLSelectElement>('select-active-survey-status');
    const splatInput = el<HTMLInputElement>('input-active-survey-splat');
    if (dateInput && document.activeElement !== dateInput) {
      dateInput.value = active.capturedAt;
    }
    if (labelInput && document.activeElement !== labelInput) {
      labelInput.value = active.label;
    }
    if (statusSelect && document.activeElement !== statusSelect) {
      statusSelect.value = active.status;
    }
    if (splatInput && document.activeElement !== splatInput) {
      splatInput.value = formatSplatReferenceInput(active.assets.splat);
    }

    // Dormant Before/After Compare Hook banner
    const compareBanner = el<HTMLDivElement>('survey-compare-banner');
    const compareText = el<HTMLSpanElement>('survey-compare-text');
    if (compareBanner && compareText) {
      const compareTarget = compareSurveyId
        ? ordered.find((s) => s.surveyId === compareSurveyId)
        : null;
      if (compareTarget && compareTarget.surveyId !== active.surveyId) {
        compareBanner.classList.remove('hidden');
        compareText.textContent = `B/A Hook: ${active.capturedAt} (${active.label}) ↔ ${compareTarget.capturedAt} (${compareTarget.label}) · ready for split/swipe`;
      } else {
        compareBanner.classList.add('hidden');
      }
    }

    const listEl = el<HTMLDivElement>('survey-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const item of ordered) {
      const isActive = item.surveyId === active.surveyId;
      const isCompare = item.surveyId === compareSurveyId && !isActive;

      const row = document.createElement('div');
      row.className = isActive
        ? 'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 bg-[#d4af63]/14 border border-[#d4af63]/50 transition-colors'
        : 'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 bg-black/40 border border-white/8 hover:border-white/20 transition-colors';

      const mainBtn = document.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'flex-1 min-w-0 text-left flex items-center gap-2 cursor-pointer';
      mainBtn.title = `Switch to survey "${item.surveyId}"`;
      mainBtn.addEventListener('click', () => {
        if (!isActive) {
          void selectSurvey(item.surveyId, { flyToFirst: true });
        }
      });

      const dot = document.createElement('span');
      dot.className = isActive
        ? 'w-1.5 h-1.5 rounded-full bg-[#e7cb88] shrink-0'
        : 'w-1.5 h-1.5 rounded-full bg-slate-600 shrink-0';

      const textCol = document.createElement('div');
      textCol.className = 'min-w-0 flex-1';

      const topLine = document.createElement('div');
      topLine.className = 'flex items-center gap-1.5 min-w-0';

      const dateSpan = document.createElement('span');
      dateSpan.className = isActive
        ? 'text-[10px] font-mono font-semibold text-[#e7cb88] shrink-0 tabular-nums'
        : 'text-[10px] font-mono text-slate-300 shrink-0 tabular-nums';
      dateSpan.textContent = item.capturedAt;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'text-[11px] font-medium text-slate-100 truncate';
      labelSpan.textContent = item.label;

      const statusSpan = document.createElement('span');
      const statusColor =
        item.status === 'processed'
          ? 'text-emerald-300'
          : item.status === 'captured'
            ? 'text-sky-300'
            : 'text-slate-400';
      statusSpan.className = `text-[9px] font-mono uppercase tracking-[0.06em] shrink-0 ${statusColor}`;
      statusSpan.textContent = item.status;

      topLine.append(dateSpan, labelSpan, statusSpan);

      const metaLine = document.createElement('div');
      metaLine.className = 'text-[9px] font-mono text-slate-400 truncate';
      const tileCount = isActive ? activeTilesets.length : item.assets.tilesets.length;
      const bmCount = isActive ? cameraBookmarks.length : item.bookmarks.length;
      const parts: string[] = [item.surveyId];
      if (tileCount > 0) parts.push(`${tileCount} ${tileCount === 1 ? 'tileset' : 'tilesets'}`);
      if (item.assets.splat) parts.push('splat');
      if (bmCount > 0) parts.push(`${bmCount} ${bmCount === 1 ? 'view' : 'views'}`);
      if (item.paths.length > 0) parts.push(`${item.paths.length} ${item.paths.length === 1 ? 'path' : 'paths'}`);
      metaLine.textContent = parts.join(' · ');

      textCol.append(topLine, metaLine);
      mainBtn.append(dot, textCol);

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1 shrink-0';

      if (!isActive) {
        const btnCompare = document.createElement('button');
        btnCompare.type = 'button';
        btnCompare.className = isCompare
          ? 'px-1.5 py-0.5 rounded bg-[#d4af63]/25 border border-[#d4af63]/60 text-[9px] font-mono font-semibold text-[#e7cb88] cursor-pointer'
          : 'px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/12 border border-white/10 text-[9px] font-mono text-slate-300 cursor-pointer';
        btnCompare.textContent = isCompare ? 'B/A ✓' : 'B/A';
        btnCompare.title = isCompare
          ? 'Clear Before/After comparison hook'
          : 'Arm this survey as Before/After comparison target (?compare=)';
        btnCompare.addEventListener('click', (e) => {
          e.stopPropagation();
          setCompareSurvey(isCompare ? null : item.surveyId);
        });
        actions.appendChild(btnCompare);
      }

      if (ordered.length > 1) {
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className =
          'px-1.5 py-0.5 rounded bg-red-950/50 hover:bg-red-900/70 text-[10px] font-mono text-red-300 cursor-pointer';
        btnDel.textContent = '×';
        btnDel.title = `Remove survey "${item.label}"`;
        btnDel.addEventListener('click', (e) => {
          e.stopPropagation();
          void deleteSurveyEpoch(item.surveyId);
        });
        actions.appendChild(btnDel);
      }

      row.append(mainBtn, actions);
      listEl.appendChild(row);
    }
  }

  function setCompareSurvey(targetId: string | null, silent = false): void {
    if (!targetId || targetId === activeSurveyId) {
      compareSurveyId = null;
    } else {
      const exists = surveyCatalog.find((s) => s.surveyId === targetId);
      compareSurveyId = exists ? exists.surveyId : null;
    }
    surveyCatalogTouched = true;
    syncSurveyUrlParams(true);
    renderSurveyCatalogUI();
    notifyUiStateChanged();
    if (!silent) {
      if (compareSurveyId) {
        logEvent(`Armed Before/After comparison hook: ${activeSurveyId} ↔ ${compareSurveyId}.`, 'info');
        showToast(`B/A hook armed: ${compareSurveyId}`);
      } else {
        logEvent('Cleared Before/After comparison hook.', 'info');
        showToast('Cleared B/A comparison hook');
      }
    }
  }

  async function selectSurvey(
    targetId: string,
    options?: {
      skipSnapshot?: boolean;
      flyToFirst?: boolean;
      silent?: boolean;
      syncUrl?: boolean;
    }
  ): Promise<boolean> {
    const target =
      surveyCatalog.find((s) => s.surveyId === targetId) ||
      surveyCatalog.find((s) => s.capturedAt === targetId);
    if (!target) {
      if (!options?.silent) {
        showToast(`Survey "${targetId}" not found in catalog.`, 'error');
      }
      return false;
    }

    if (!options?.skipSnapshot && target.surveyId !== activeSurveyId) {
      syncLiveSceneIntoActiveSurvey();
    }

    activeSurveyId = target.surveyId;
    if (compareSurveyId === activeSurveyId) {
      compareSurveyId = null;
    }
    surveyCatalogTouched = true;

    // Swap live scene tilesets & clipping polygon to the target survey's assets
    clearAllLoadedTilesets();

    if (typeof target.verticalOffsetMeters === 'number' && Number.isFinite(target.verticalOffsetMeters)) {
      applyHeightNudge(target.verticalOffsetMeters);
    }

    const clipId = target.assets.clippingGeoJsonAssetId ?? null;
    const clipInput = el<HTMLInputElement>('input-clip-asset-id');
    if (clipId) {
      if (clipInput) clipInput.value = String(clipId);
      if (ionConnected) {
        await applyClippingGeoJson(clipId);
      }
    } else {
      if (clipInput) clipInput.value = '';
      if (activeClipAssetId !== null) {
        clearClippingGeoJson();
      }
    }

    const tilesetsToLoad = [...target.assets.tilesets];
    // If survey specifies a numeric splat ionAssetId not already in tilesets, include it
    if (
      target.assets.splat?.ionAssetId &&
      !tilesetsToLoad.some((t) => t.ionAssetId === target.assets.splat!.ionAssetId)
    ) {
      tilesetsToLoad.push({
        name: target.assets.splat.name || `${target.label} 3DGS`,
        ionAssetId: target.assets.splat.ionAssetId,
        type: '3dgs',
        visible: true,
        clippingGeoJsonAssetId: clipId,
      });
    }

    if (tilesetsToLoad.length > 0) {
      if (ionConnected) {
        for (const ts of tilesetsToLoad) {
          if (ts?.ionAssetId) {
            await loadIonTileset(ts.ionAssetId, ts.name || `Asset #${ts.ionAssetId}`);
            if (ts.visible === false) {
              setTilesetVisibleById(ts.ionAssetId, false);
            }
          }
        }
      } else if (!options?.silent) {
        logEvent(
          `Survey "${target.surveyId}" references ${tilesetsToLoad.length} Cesium ion asset(s) — connect ion Token to stream them.`,
          'info'
        );
      }
    }

    cameraBookmarks = target.bookmarks.map((b) => ({ ...b }));
    renderBookmarkList();

    if (options?.flyToFirst && cameraBookmarks.length > 0) {
      flyToBookmark(cameraBookmarks[0]);
    }

    if (options?.syncUrl !== false) {
      syncSurveyUrlParams(true);
    }
    renderSurveyCatalogUI();
    notifyUiStateChanged();

    if (!options?.silent) {
      logEvent(`Active survey switched to "${target.label}" (${target.capturedAt} · ${target.surveyId}).`, 'ok');
      showToast(`Survey: ${target.capturedAt} · ${target.label}`);
    }
    return true;
  }

  async function createNewSurveyEpoch(input: {
    capturedAt?: string;
    label?: string;
    status?: SurveyStatus;
    splatInput?: string;
    cloneBookmarks?: boolean;
  }): Promise<SurveyRecord> {
    syncLiveSceneIntoActiveSurvey();
    const prevActive = getActiveSurvey();
    const capturedAt = toIsoDateOnly(input.capturedAt);
    const label = (input.label || '').trim() || `Survey ${capturedAt}`;
    const splat = parseSplatReferenceInput(input.splatInput || '', label);

    const record = createDefaultSurveyRecord({
      capturedAt,
      label,
      status: input.status ? normalizeSurveyStatus(input.status) : splat ? 'processed' : 'planned',
      verticalOffsetMeters: currentHeightOffset,
      clippingGeoJsonAssetId: activeClipAssetId,
      bookmarks: input.cloneBookmarks !== false ? prevActive.bookmarks : [],
      splatUrl: splat?.url ?? null,
      splatAssetId: splat?.ionAssetId ?? null,
      existingIds: surveyCatalog.map((s) => s.surveyId),
    });

    surveyCatalog = sortSurveysNewestFirst([...surveyCatalog, record]);
    surveyCatalogTouched = true;
    await selectSurvey(record.surveyId, { skipSnapshot: true, flyToFirst: false, silent: true });
    logEvent(`Created survey epoch "${record.label}" (${record.surveyId}).`, 'ok');
    showToast(`Created survey: ${record.capturedAt} · ${record.label}`);
    return record;
  }

  async function deleteSurveyEpoch(surveyId: string): Promise<void> {
    if (surveyCatalog.length <= 1) {
      showToast('Site manifest must keep at least one survey epoch.', 'info');
      return;
    }
    const target = surveyCatalog.find((s) => s.surveyId === surveyId);
    if (!target) return;
    surveyCatalog = surveyCatalog.filter((s) => s.surveyId !== surveyId);
    if (compareSurveyId === surveyId) {
      compareSurveyId = null;
    }
    if (activeSurveyId === surveyId) {
      const next = sortSurveysNewestFirst(surveyCatalog)[0];
      await selectSurvey(next.surveyId, { skipSnapshot: true, flyToFirst: false, silent: true });
    } else {
      syncSurveyUrlParams(true);
      renderSurveyCatalogUI();
      notifyUiStateChanged();
    }
    logEvent(`Removed survey epoch "${target.label}" (${target.surveyId}).`, 'info');
    showToast(`Removed survey: ${target.label}`);
  }

  function copyActiveSurveyUrl(): void {
    syncSurveyUrlParams(true);
    const urlStr = window.location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(urlStr)
        .then(() => {
          showToast(`Copied survey link (?survey=${activeSurveyId})`);
          logEvent(`Copied survey URL: ${urlStr}`, 'ok');
        })
        .catch(() => {
          showToast('Could not copy URL to clipboard.', 'error');
        });
    } else {
      const ta = document.createElement('textarea');
      ta.value = urlStr;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(`Copied survey link (?survey=${activeSurveyId})`);
      } catch {
        showToast('Could not copy URL to clipboard.', 'error');
      }
      ta.remove();
    }
  }

  function buildSiteManifest(): SiteManifest {
    syncLiveSceneIntoActiveSurvey();
    const active = getActiveSurvey();
    const orderedSurveys = sortSurveysNewestFirst(surveyCatalog);
    const title = (el<HTMLInputElement>('input-site-title')?.value || 'SplatMap Site').trim();
    const siteId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'splatmap-site';
    const sourceCRS = (el<HTMLInputElement>('input-source-crs')?.value || 'NAD83 / NAVD88').trim();

    let origin = {
      lat: parseFloat(el<HTMLInputElement>('input-lat')?.value || '0') || 0,
      lon: parseFloat(el<HTMLInputElement>('input-lon')?.value || '0') || 0,
      ellipsoidalHeight: parseFloat(el<HTMLInputElement>('input-alt')?.value || '0') || 0,
    };

    if (cameraBookmarks.length > 0) {
      origin = {
        lat: cameraBookmarks[0].lat,
        lon: cameraBookmarks[0].lon,
        ellipsoidalHeight: cameraBookmarks[0].alt,
      };
    } else if (viewer?.camera?.positionCartographic) {
      const c = viewer.camera.positionCartographic;
      origin = {
        lat: Number(Cesium.Math.toDegrees(c.latitude).toFixed(6)),
        lon: Number(Cesium.Math.toDegrees(c.longitude).toFixed(6)),
        ellipsoidalHeight: Number(c.height.toFixed(2)),
      };
    }

    const validCompare =
      compareSurveyId &&
      compareSurveyId !== active.surveyId &&
      orderedSurveys.some((s) => s.surveyId === compareSurveyId)
        ? compareSurveyId
        : null;

    return {
      schemaVersion: '2.0',
      siteId,
      title,
      exportedAt: new Date().toISOString(),
      activeSurveyId: active.surveyId,
      compareSurveyId: validCompare,
      comparisonHook: {
        baselineSurveyId: active.surveyId,
        targetSurveyId: validCompare,
        mode: 'off',
      },
      geodesy: {
        sourceCRS,
        convertedBy: 'MSP GEOTRANS',
        wgs84Origin: origin,
        verticalOffsetMeters: Number(currentHeightOffset.toFixed(2)),
      },
      layers: {
        worldTerrain: worldTerrainEnabled,
        google3DTiles: google3DEnabled,
        defaultSSE: currentSSE,
        clippingGeoJsonAssetId: activeClipAssetId,
      },
      surveys: orderedSurveys,
      tilesets: active.assets.tilesets.map((t) => ({ ...t })),
      bookmarks: active.bookmarks.map((b) => ({ ...b })),
    };
  }

  function exportSiteManifest(): void {
    const manifest = buildSiteManifest();
    const json = JSON.stringify(manifest, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${manifest.siteId}_manifest.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    logEvent(
      `Exported "${manifest.siteId}_manifest.json" (Schema 2.0 · ${manifest.surveys.length} survey epoch(s), active: ${manifest.activeSurveyId}).`,
      'ok'
    );
    showToast(`Exported ${manifest.siteId}_manifest.json (${manifest.surveys.length} surveys)`);
  }

  function copySiteManifestToClipboard(): void {
    const manifest = buildSiteManifest();
    const json = JSON.stringify(manifest, null, 2);
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      logEvent(`Copied Schema 2.0 site_manifest.json (${manifest.surveys.length} surveys) to clipboard.`, 'ok');
      showToast('Copied Schema 2.0 manifest to clipboard.');
    } catch {
      logEvent('Clipboard copy blocked—use Export JSON instead.', 'warn');
      showToast('Copy blocked—click Export JSON instead.', 'error');
    }
    ta.remove();
  }

  async function applySiteManifest(
    rawManifest: any,
    options?: {
      requestedSurveyId?: string | null;
      requestedCompareId?: string | null;
    }
  ): Promise<void> {
    const { manifest, upgradedFromV1 } = normalizeSiteManifest(rawManifest);

    logEvent(
      `Applying site manifest "${manifest.title}" (Schema 2.0${upgradedFromV1 ? ', upgraded from v1.0' : ''} · ${manifest.surveys.length} survey epoch(s))...`,
      'info'
    );

    const titleInput = el<HTMLInputElement>('input-site-title');
    if (titleInput) titleInput.value = manifest.title;
    const crsInput = el<HTMLInputElement>('input-source-crs');
    if (crsInput) crsInput.value = manifest.geodesy.sourceCRS;

    applySSE(manifest.layers.defaultSSE);
    applyHeightNudge(manifest.geodesy.verticalOffsetMeters);

    if (ionConnected) {
      if (manifest.layers.worldTerrain !== worldTerrainEnabled) {
        await toggleWorldTerrain();
      }
      if (manifest.layers.google3DTiles !== google3DEnabled) {
        await toggleGoogle3DTiles();
      }
    }

    surveyCatalog = manifest.surveys;
    surveyCatalogTouched = true;

    const urlParams = new URLSearchParams(window.location.search);
    const desiredSurvey = options?.requestedSurveyId ?? urlParams.get('survey');
    const desiredCompare =
      options?.requestedCompareId ?? urlParams.get('compare') ?? manifest.compareSurveyId;

    const resolved = resolveSurveySelection(
      surveyCatalog,
      desiredSurvey,
      desiredCompare,
      manifest.activeSurveyId
    );
    compareSurveyId = resolved.compareSurveyId;

    await selectSurvey(resolved.activeSurveyId, {
      skipSnapshot: true,
      flyToFirst: true,
      silent: true,
      syncUrl: true,
    });

    if (cameraBookmarks.length === 0 && manifest.geodesy?.wgs84Origin) {
      const o = manifest.geodesy.wgs84Origin;
      if (typeof o.lat === 'number' && typeof o.lon === 'number') {
        const latInput = el<HTMLInputElement>('input-lat');
        const lonInput = el<HTMLInputElement>('input-lon');
        const altInput = el<HTMLInputElement>('input-alt');
        if (latInput) latInput.value = String(o.lat);
        if (lonInput) lonInput.value = String(o.lon);
        if (altInput) altInput.value = String(o.ellipsoidalHeight || 300);
        flyToWGS84(o.lat, o.lon, o.ellipsoidalHeight || 300, -35);
      }
    }

    const active = getActiveSurvey();
    logEvent(
      `Loaded "${manifest.title}" · ${surveyCatalog.length} survey(s) · active: ${active.capturedAt} "${active.label}"${compareSurveyId ? ` · B/A hook: ${compareSurveyId}` : ''}.`,
      'ok'
    );
    showToast(`Loaded "${manifest.title}" · ${active.capturedAt} (${active.label})`);
  }

  async function loadManifestFromUrl(
    url: string,
    options?: {
      requestedSurveyId?: string | null;
      requestedCompareId?: string | null;
    }
  ): Promise<void> {
    try {
      logEvent(`Fetching manifest from ${url}...`, 'info');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await applySiteManifest(json, options);
    } catch (err: any) {
      logEvent(`Failed to load manifest URL: ${err?.message || err}`, 'error');
      showToast('Could not load manifest from URL.', 'error');
    }
  }

  function flyToWGS84(
    lat: number,
    lon: number,
    alt: number,
    pitchDeg = -35,
    headingDeg = 0,
    rollDeg = 0,
    options?: { keepAltitudeFlat?: boolean; preserveExactPosition?: boolean; duration?: number }
  ): boolean {
    if (isNaN(lat) || isNaN(lon) || isNaN(alt) || !viewer?.camera) {
      showToast('Enter valid numeric Lat, Lon, and Alt values.', 'error');
      return false;
    }
    const latInput = el<HTMLInputElement>('input-lat');
    const lonInput = el<HTMLInputElement>('input-lon');
    const altInput = el<HTMLInputElement>('input-alt');
    if (latInput) latInput.value = lat.toFixed(5);
    if (lonInput) lonInput.value = lon.toFixed(5);
    if (altInput) altInput.value = String(Math.round(alt));

    setFlightMode('explore');

    const wasMidFlight = pendingCameraTarget !== null;
    const exactDest =
      options?.preserveExactPosition && !wasMidFlight
        ? viewer.camera.position.clone()
        : Cesium.Cartesian3.fromDegrees(lon, lat, alt);

    const seq = ++activeFlySeq;
    pendingCameraTarget = {
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      ellipsoidalHeight: Number(alt.toFixed(2)),
      heading: Number(headingDeg.toFixed(2)),
      pitch: Number(pitchDeg.toFixed(2)),
      roll: Number(rollDeg.toFixed(2)),
    };

    const currentAlt = viewer.camera.positionCartographic?.height ?? alt;
    const isShortLocalMove = Boolean(options?.keepAltitudeFlat);
    const flyOptions: Record<string, unknown> = {
      destination: exactDest,
      orientation: {
        heading: Cesium.Math.toRadians(headingDeg),
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: Cesium.Math.toRadians(rollDeg),
      },
      duration: options?.duration ?? (isShortLocalMove ? 0.8 : 2.0),
      complete: () => {
        if (activeFlySeq === seq) pendingCameraTarget = null;
      },
      cancel: () => {
        if (activeFlySeq === seq) pendingCameraTarget = null;
      },
    };
    if (isShortLocalMove && Math.abs(currentAlt - alt) < 250) {
      flyOptions.maximumHeight = Math.max(currentAlt, alt);
    }

    viewer.camera.flyTo(flyOptions);
    fetchAndRenderSiteWeather(lat, lon, false);
    logEvent(`Flying to ${lat.toFixed(4)}°, ${lon.toFixed(4)}° (${Math.round(alt)}m WGS84).`, 'info');
    return true;
  }

  async function searchGlobalAddress(
    query: string
  ): Promise<{
    ok: boolean;
    name?: string;
    formattedAddress?: string;
    lat?: number;
    lon?: number;
    height?: number;
    error?: string;
  }> {
    const trimmed = query.trim();
    if (!trimmed) return { ok: false, error: 'Empty search query.' };
    logEvent(`Geocoding "${trimmed}"...`, 'info');
    try {
      const res = await fetch('/api/maps/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const lat = Number(data?.location?.lat);
      const lng = Number(data?.location?.lng);
      if (isNaN(lat) || isNaN(lng)) throw new Error('No coordinates returned');

      const defaultAlt = 650;
      flyToWGS84(lat, lng, defaultAlt, -38);
      showToast(`Flying to ${data.name || trimmed}`);
      return {
        ok: true,
        name: data.name || trimmed,
        formattedAddress: data.formattedAddress || trimmed,
        lat: Number(lat.toFixed(6)),
        lon: Number(lng.toFixed(6)),
        height: defaultAlt,
      };
    } catch (err: any) {
      logEvent(`Address lookup failed: ${err?.message || err}`, 'error');
      showToast('Could not locate address.', 'error');
      return { ok: false, error: err?.message || 'Address lookup failed.' };
    }
  }

  function updateTelemetry(): void {
    frameCount++;
    const now = performance.now();
    updateFlightClusterGauge(now);

    if (now - lastFpsCheck < 500) return;

    const elapsed = now - lastFpsCheck;
    const fps = (frameCount * 1000) / elapsed;
    smoothedFps = smoothedFps * 0.6 + fps * 0.4;
    frameCount = 0;
    lastFpsCheck = now;

    const fpsEl = el<HTMLDivElement>('metric-fps');
    const railFpsEl = el<HTMLSpanElement>('rail-fps-val');
    const altEl = el<HTMLDivElement>('metric-alt');
    const latLonEl = el<HTMLSpanElement>('metric-latlon');
    const hdgPitchEl = el<HTMLSpanElement>('metric-hdg-pitch');

    const roundedFps = Math.round(smoothedFps);
    if (fpsEl) fpsEl.textContent = `${roundedFps}`;
    if (railFpsEl) railFpsEl.textContent = `${roundedFps} fps`;

    if (viewer?.camera?.positionCartographic) {
      const carto = viewer.camera.positionCartographic;
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const alt = carto.height;
      const hdg = Math.round(Cesium.Math.toDegrees(viewer.camera.heading));
      const pitch = Math.round(Cesium.Math.toDegrees(viewer.camera.pitch));

      if (latLonEl) latLonEl.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
      if (hdgPitchEl) hdgPitchEl.textContent = `H ${hdg}° · P ${pitch}°`;
      if (altEl) {
        altEl.textContent = alt >= 10000 ? `${(alt / 1000).toFixed(1)} km` : `${Math.round(alt)} m`;
      }
    }

    if (smoothedFps < 18) setHealthState('critical');
    else if (smoothedFps < 32) setHealthState('warn');
    else setHealthState('ok');
  }

  function applyClusterUnitLabels(): void {
    const btn = el<HTMLButtonElement>('btn-cluster-units');
    const altUnitEl = el<HTMLSpanElement>('gauge-alt-unit');
    const spdUnitEl = el<HTMLSpanElement>('gauge-spd-unit');
    const l1 = el<HTMLElement>('gauge-spd-lbl-1');
    const l2 = el<HTMLElement>('gauge-spd-lbl-2');
    const l3 = el<HTMLElement>('gauge-spd-lbl-3');
    const l4 = el<HTMLElement>('gauge-spd-lbl-4');

    const isImp = clusterUnits === 'imperial';
    if (btn) btn.textContent = isImp ? 'FT·KT' : 'M·M/S';
    if (altUnitEl) altUnitEl.textContent = isImp ? 'FT' : 'M';
    if (spdUnitEl) spdUnitEl.textContent = isImp ? 'KT' : 'M/S';
    if (l1) l1.textContent = isImp ? '40' : '20';
    if (l2) l2.textContent = isImp ? '80' : '40';
    if (l3) l3.textContent = isImp ? '120' : '60';
    if (l4) l4.textContent = isImp ? '160' : '80';
  }

  function updateFlightClusterGauge(nowMs: number): void {
    if (!viewer?.camera?.positionWC || !viewer?.camera?.positionCartographic) return;
    if (nowMs - lastClusterSampleMs < 55) return;

    const dtSec = lastClusterSampleMs > 0 ? Math.max(0.016, (nowMs - lastClusterSampleMs) / 1000) : 0.055;
    lastClusterSampleMs = nowMs;

    const currPos = viewer.camera.positionWC;
    const carto = viewer.camera.positionCartographic;
    const altMeters = Math.max(0, carto.height);
    const hdgDeg = ((Math.round(Cesium.Math.toDegrees(viewer.camera.heading)) % 360) + 360) % 360;

    if (prevCamPosCartesian) {
      const distMeters = Cesium.Cartesian3.distance(prevCamPosCartesian, currPos);
      // Clamp huge jump spikes (e.g. instant teleport) while staying responsive to flights
      const instSpeedMps = distMeters / dtSec;
      const clampedInst = instSpeedMps > 2000 ? 0 : instSpeedMps;
      smoothedSpeedMps = smoothedSpeedMps * 0.72 + clampedInst * 0.28;
      if (smoothedSpeedMps < 0.08) smoothedSpeedMps = 0;
    }
    prevCamPosCartesian = Cesium.Cartesian3.clone(currPos, prevCamPosCartesian || new Cesium.Cartesian3());

    if (prevCamAltMeters !== null) {
      const instClimb = (altMeters - prevCamAltMeters) / dtSec;
      const clampedClimb = Math.abs(instClimb) > 2000 ? 0 : instClimb;
      smoothedClimbMps = smoothedClimbMps * 0.75 + clampedClimb * 0.25;
    }
    prevCamAltMeters = altMeters;

    const hdgEl = el<HTMLSpanElement>('cluster-hdg');
    if (hdgEl) hdgEl.textContent = `HDG ${String(hdgDeg).padStart(3, '0')}°`;

    if (clusterCollapsed) return;

    const isImp = clusterUnits === 'imperial';
    const altVal = isImp ? altMeters * 3.28084 : altMeters;
    const spdVal = isImp ? smoothedSpeedMps * 1.94384 : smoothedSpeedMps; // knots or m/s
    const spdMax = isImp ? 160 : 80;

    // Dual-hand barometric altimeter rotation:
    // Long gold hand = 1 full revolution per 1,000 units; short silver hand = 1 revolution per 10,000 units
    const alt100Deg = ((altVal % 1000) / 1000) * 360;
    const alt1000Deg = ((altVal % 10000) / 10000) * 360;

    const altNeedle100 = el<HTMLElement>('gauge-alt-needle-100');
    const altNeedle1000 = el<HTMLElement>('gauge-alt-needle-1000');
    if (altNeedle100) altNeedle100.style.transform = `rotate(${alt100Deg.toFixed(1)}deg)`;
    if (altNeedle1000) altNeedle1000.style.transform = `rotate(${alt1000Deg.toFixed(1)}deg)`;

    // Altimeter digital drum readout
    const altReadoutEl = el<HTMLSpanElement>('gauge-alt-readout');
    const altUnitEl = el<HTMLSpanElement>('gauge-alt-unit');
    if (altReadoutEl && altUnitEl) {
      if (isImp) {
        if (altVal >= 100000) {
          altReadoutEl.textContent = `${(altVal / 1000).toFixed(0)}k`;
          altUnitEl.textContent = 'FT';
        } else if (altVal >= 10000) {
          altReadoutEl.textContent = `${(altVal / 1000).toFixed(1)}k`;
          altUnitEl.textContent = 'FT';
        } else {
          altReadoutEl.textContent = `${Math.round(altVal)}`;
          altUnitEl.textContent = 'FT';
        }
      } else {
        if (altVal >= 10000) {
          altReadoutEl.textContent = `${(altVal / 1000).toFixed(1)}`;
          altUnitEl.textContent = 'KM';
        } else {
          altReadoutEl.textContent = `${Math.round(altVal)}`;
          altUnitEl.textContent = 'M';
        }
      }
    }

    // Climb / Descent vertical speed chevron
    const vsiEl = el<HTMLSpanElement>('gauge-vsi-badge');
    if (vsiEl) {
      if (smoothedClimbMps > 0.6) {
        vsiEl.textContent = '▲';
        vsiEl.className = 'text-[8px] font-mono text-emerald-400 leading-none';
      } else if (smoothedClimbMps < -0.6) {
        vsiEl.textContent = '▼';
        vsiEl.className = 'text-[8px] font-mono text-red-400 leading-none';
      } else {
        vsiEl.textContent = '·';
        vsiEl.className = 'text-[8px] font-mono text-slate-500 leading-none';
      }
    }

    // Airspeed needle: -135° (0) to +135° (max), clamped gracefully at redline
    const spdRatio = Math.max(0, Math.min(1, spdVal / spdMax));
    const spdDeg = -135 + spdRatio * 270;
    const spdNeedle = el<HTMLElement>('gauge-spd-needle');
    if (spdNeedle) spdNeedle.style.transform = `rotate(${spdDeg.toFixed(1)}deg)`;

    const spdReadoutEl = el<HTMLSpanElement>('gauge-spd-readout');
    if (spdReadoutEl) {
      spdReadoutEl.textContent = spdVal >= 999 ? '999+' : `${Math.round(spdVal)}`;
    }

    const spdModeEl = el<HTMLElement>('gauge-spd-mode');
    if (spdModeEl) {
      const modeCode =
        flightMode === 'wasd'
          ? 'WASD'
          : flightMode === 'orbit'
            ? 'ORB'
            : flightMode === 'tour'
              ? 'TOUR'
              : smoothedSpeedMps > 0.5
                ? 'FLY'
                : 'HVR';
      spdModeEl.textContent = modeCode;
    }
  }

  function setupUI(): void {
    renderTilesetList();
    renderBookmarkList();
    renderClipList();

    // WebGL Reload Fallback
    el<HTMLButtonElement>('btn-reload-webgl')?.addEventListener('click', () => {
      window.location.reload();
    });

    // Token Modal Controls
    el<HTMLButtonElement>('btn-open-token')?.addEventListener('click', () => {
      tokenModal?.classList.remove('hidden');
    });
    const closeTokenModal = () => tokenModal?.classList.add('hidden');
    el<HTMLButtonElement>('btn-close-token-modal')?.addEventListener('click', closeTokenModal);
    el<HTMLButtonElement>('btn-cancel-token')?.addEventListener('click', closeTokenModal);
    el<HTMLButtonElement>('btn-apply-token')?.addEventListener('click', () => {
      connectCesiumIon(inputIonToken?.value || '');
    });
    el<HTMLButtonElement>('btn-clear-token')?.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      if (inputIonToken) inputIonToken.value = '';
      showToast('Cleared saved Cesium ion token.');
    });

    // Featured 110M Splat Button
    el<HTMLButtonElement>('btn-load-redmond')?.addEventListener('click', () => {
      loadIonTileset(REDMOND_SPLAT_ASSET_ID, 'Redmond 110M Splat');
    });

    // Custom Asset ID Loader
    const inputAssetId = el<HTMLInputElement>('input-asset-id');
    el<HTMLButtonElement>('btn-load-asset')?.addEventListener('click', () => {
      loadIonTileset(inputAssetId?.value || '');
    });
    inputAssetId?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadIonTileset(inputAssetId.value);
    });

    // Global Layers
    el<HTMLButtonElement>('btn-toggle-terrain')?.addEventListener('click', toggleWorldTerrain);
    el<HTMLButtonElement>('btn-toggle-google3d')?.addEventListener('click', toggleGoogle3DTiles);
    el<HTMLButtonElement>('btn-toggle-map-labels')?.addEventListener('click', () => {
      setMapLabelsEnabled(!mapLabelsEnabled);
    });
    el<HTMLButtonElement>('btn-hud-map-labels')?.addEventListener('click', () => {
      setMapLabelsEnabled(!mapLabelsEnabled);
    });

    // Real-Time Weather Overlay Controls
    document.querySelectorAll<HTMLButtonElement>('.weather-layer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.weatherLayer as WeatherTileLayer;
        if (layer) setWeatherTileLayer(layer);
      });
    });

    const sliderWeatherOpacity = el<HTMLInputElement>('slider-weather-opacity');
    const valWeatherOpacity = el<HTMLSpanElement>('val-weather-opacity');
    sliderWeatherOpacity?.addEventListener('input', () => {
      const pct = parseInt(sliderWeatherOpacity.value, 10);
      weatherOpacity = pct / 100;
      if (valWeatherOpacity) valWeatherOpacity.textContent = `${pct}%`;
      if (weatherImageryLayer) weatherImageryLayer.alpha = weatherOpacity;
      if (lastWeatherData && show3DWeatherOverlay) {
        render3DWeatherOverlay(lastWeatherData);
      }
    });

    const btnToggle3DWeather = el<HTMLButtonElement>('btn-toggle-3d-weather');
    btnToggle3DWeather?.addEventListener('click', () => {
      show3DWeatherOverlay = !show3DWeatherOverlay;
      btnToggle3DWeather.textContent = show3DWeatherOverlay ? '3D Wind: On' : '3D Wind: Off';
      btnToggle3DWeather.setAttribute('data-active', String(show3DWeatherOverlay));
      if (show3DWeatherOverlay && lastWeatherData) {
        render3DWeatherOverlay(lastWeatherData);
      } else {
        clear3DWeatherOverlay();
      }
    });

    el<HTMLButtonElement>('btn-weather-units')?.addEventListener('click', () => {
      weatherUnits = weatherUnits === 'imperial' ? 'metric' : 'imperial';
      if (lastWeatherData) renderWeatherHud(lastWeatherData);
    });

    el<HTMLButtonElement>('btn-weather-refresh')?.addEventListener('click', () => {
      const target = pickViewportTarget();
      if (target) {
        const carto = Cesium.Cartographic.fromCartesian(target);
        if (carto) {
          fetchAndRenderSiteWeather(
            Cesium.Math.toDegrees(carto.latitude),
            Cesium.Math.toDegrees(carto.longitude),
            false
          );
          return;
        }
      }
      fetchAndRenderSiteWeather(lastWeatherLat, lastWeatherLon, false);
    });

    // Clipping Polygon GeoJSON Controls
    const inputClipAssetId = el<HTMLInputElement>('input-clip-asset-id');
    el<HTMLButtonElement>('btn-apply-clip')?.addEventListener('click', () => {
      applyClippingGeoJson(inputClipAssetId?.value || '');
    });
    inputClipAssetId?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyClippingGeoJson(inputClipAssetId.value);
    });
    el<HTMLButtonElement>('btn-clear-clip')?.addEventListener('click', clearClippingGeoJson);

    // LOD SSE Slider
    const sliderSSE = el<HTMLInputElement>('slider-sse');
    sliderSSE?.addEventListener('input', () => {
      applySSE(parseInt(sliderSSE.value, 10));
    });

    // Geotrans Ellipsoidal Height Offset Slider
    const sliderHeight = el<HTMLInputElement>('slider-height-offset');
    sliderHeight?.addEventListener('input', () => {
      applyHeightNudge(parseFloat(sliderHeight.value));
    });

    // Global Address Search
    const inputAddress = el<HTMLInputElement>('input-address-search');
    el<HTMLButtonElement>('btn-address-search')?.addEventListener('click', () => {
      searchGlobalAddress(inputAddress?.value || '');
    });
    inputAddress?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchGlobalAddress(inputAddress.value);
    });

    // WGS84 Coordinate Jumper
    el<HTMLButtonElement>('btn-fly-coords')?.addEventListener('click', () => {
      const lat = parseFloat(el<HTMLInputElement>('input-lat')?.value || '');
      const lon = parseFloat(el<HTMLInputElement>('input-lon')?.value || '');
      const alt = parseFloat(el<HTMLInputElement>('input-alt')?.value || '');
      flyToWGS84(lat, lon, alt);
    });

    document.querySelectorAll<HTMLButtonElement>('.preset-loc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lat = parseFloat(btn.getAttribute('data-lat') || '0');
        const lon = parseFloat(btn.getAttribute('data-lon') || '0');
        const alt = parseFloat(btn.getAttribute('data-alt') || '400');
        const pitch = parseFloat(btn.getAttribute('data-pitch') || '-35');
        const latInput = el<HTMLInputElement>('input-lat');
        const lonInput = el<HTMLInputElement>('input-lon');
        const altInput = el<HTMLInputElement>('input-alt');
        if (latInput) latInput.value = String(lat);
        if (lonInput) lonInput.value = String(lon);
        if (altInput) altInput.value = String(alt);
        flyToWGS84(lat, lon, alt, pitch);
        setActiveCard(null);
      });
    });

    // Virtual Drone Flight Controls
    document.querySelectorAll<HTMLButtonElement>('.flight-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.flightMode as FlightMode;
        if (mode) setFlightMode(mode);
      });
    });

    const sliderSpeed = el<HTMLInputElement>('slider-flight-speed');
    sliderSpeed?.addEventListener('input', () => {
      applyAirspeed(parseInt(sliderSpeed.value, 10));
    });

    const sliderOrbit = el<HTMLInputElement>('slider-orbit-speed');
    const valOrbit = el<HTMLSpanElement>('val-orbit-speed');
    sliderOrbit?.addEventListener('input', () => {
      orbitSpeedDegPerSec = parseInt(sliderOrbit.value, 10);
      if (valOrbit) valOrbit.textContent = `${orbitSpeedDegPerSec} °/s`;
      if (flightMode === 'orbit') updateFlightModeButtons();
    });

    document.querySelectorAll<HTMLButtonElement>('.lens-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mm = Number(btn.dataset.lensMm);
        if (!isNaN(mm)) applyLensPreset(mm);
      });
    });

    // Video Recording & Snapshot Controls (auto-tuck capture card when live recording begins)
    el<HTMLButtonElement>('btn-rec-free')?.addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else if (startRecording(flightMode === 'wasd' ? 'WASD Pilot' : 'Free Flight')) {
        setActiveCard(null);
      }
    });
    el<HTMLButtonElement>('btn-rec-orbit')?.addEventListener('click', () => {
      const res = startRecord360Lap();
      if (res.ok) setActiveCard(null);
    });
    el<HTMLButtonElement>('btn-snapshot-png')?.addEventListener('click', capturePngSnapshot);
    el<HTMLButtonElement>('btn-stop-rec-banner')?.addEventListener('click', stopRecording);

    // Offline Render Path Controls
    updateRenderPathButtons();
    el<HTMLButtonElement>('btn-load-render-path')?.addEventListener('click', () => {
      if (!renderPathFileInput || isRenderingPath) return;
      renderPathFileInput.value = '';
      renderPathFileInput.click();
    });
    renderPathFileInput?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;
      await loadRenderPathFile(file);
    });
    btnRenderFrames?.addEventListener('click', () => {
      renderLoadedPathFrames();
    });
    el<HTMLButtonElement>('btn-path-jump')?.addEventListener('click', () => {
      flyToLoadedRenderPathStart(1.2);
    });
    el<HTMLButtonElement>('btn-path-preview')?.addEventListener('click', () => {
      toggleRenderPathPreview();
    });
    btnRenderToFolder?.addEventListener('click', async () => {
      if (!loadedRenderPath || isRenderingPath || !supportsDirectoryPicker) return;
      if (isRecording) {
        showToast('Stop live recording before starting Render to folder.', 'error');
        return;
      }
      let dirHandle: any;
      try {
        dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        const msg =
          err?.name === 'SecurityError'
            ? 'Folder picker blocked in this frame — use Render Frames (.zip parts) instead.'
            : `Folder picker failed: ${err?.message || err}`;
        logEvent(msg, 'error');
        showToast(msg, 'error');
        return;
      }
      await renderLoadedPathFrames(dirHandle);
    });
    el<HTMLButtonElement>('btn-cancel-render')?.addEventListener('click', () => {
      if (isRenderingPath) {
        renderPathCancelled = true;
      }
      if (isCapturingGeoBox) {
        geoBoxCaptureCancelled = true;
      }
    });

    // Clip Playback Modal Controls
    const closeClipModal = () => {
      if (clipModalVideo) {
        clipModalVideo.pause();
        clipModalVideo.removeAttribute('src');
      }
      clipModal?.classList.add('hidden');
    };
    el<HTMLButtonElement>('btn-close-clip-modal')?.addEventListener('click', closeClipModal);
    el<HTMLButtonElement>('btn-close-clip-modal-footer')?.addEventListener('click', closeClipModal);

    // Site Manifest Builder & Survey Catalog Controls
    el<HTMLButtonElement>('btn-hud-survey')?.addEventListener('click', () => {
      setActiveCard('site');
    });

    const newSurveyForm = el<HTMLDivElement>('new-survey-form');
    const newSurveyDateInput = el<HTMLInputElement>('input-new-survey-date');
    const newSurveyLabelInput = el<HTMLInputElement>('input-new-survey-label');
    const newSurveyStatusSelect = el<HTMLSelectElement>('select-new-survey-status');
    const newSurveySplatInput = el<HTMLInputElement>('input-new-survey-splat');

    el<HTMLButtonElement>('btn-toggle-new-survey')?.addEventListener('click', () => {
      if (!newSurveyForm) return;
      const opening = newSurveyForm.classList.contains('hidden');
      newSurveyForm.classList.toggle('hidden', !opening);
      if (opening) {
        if (newSurveyDateInput && !newSurveyDateInput.value) {
          newSurveyDateInput.value = toIsoDateOnly();
        }
        newSurveyLabelInput?.focus();
      }
    });
    el<HTMLButtonElement>('btn-cancel-new-survey')?.addEventListener('click', () => {
      newSurveyForm?.classList.add('hidden');
    });
    el<HTMLButtonElement>('btn-create-survey')?.addEventListener('click', async () => {
      const capturedAt = newSurveyDateInput?.value || toIsoDateOnly();
      const label = newSurveyLabelInput?.value || '';
      const status = normalizeSurveyStatus(newSurveyStatusSelect?.value);
      const splatInput = newSurveySplatInput?.value || '';
      await createNewSurveyEpoch({ capturedAt, label, status, splatInput });
      if (newSurveyLabelInput) newSurveyLabelInput.value = '';
      if (newSurveySplatInput) newSurveySplatInput.value = '';
      newSurveyForm?.classList.add('hidden');
    });
    el<HTMLButtonElement>('btn-copy-survey-url')?.addEventListener('click', copyActiveSurveyUrl);
    el<HTMLButtonElement>('btn-clear-compare-survey')?.addEventListener('click', () => {
      setCompareSurvey(null);
    });

    // Active Survey inline metadata editing
    el<HTMLInputElement>('input-active-survey-date')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLInputElement).value;
      if (!val) return;
      const active = getActiveSurvey();
      const otherIds = surveyCatalog.filter((s) => s.surveyId !== active.surveyId).map((s) => s.surveyId);
      const prevId = active.surveyId;
      active.capturedAt = toIsoDateOnly(val);
      active.surveyId = createSurveyId(active.capturedAt, active.label, otherIds);
      active.provenance.updatedAt = new Date().toISOString();
      activeSurveyId = active.surveyId;
      if (compareSurveyId === prevId) compareSurveyId = null;
      surveyCatalogTouched = true;
      syncSurveyUrlParams(true);
      renderSurveyCatalogUI();
    });
    el<HTMLInputElement>('input-active-survey-label')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLInputElement).value.trim();
      if (!val) return;
      const active = getActiveSurvey();
      const otherIds = surveyCatalog.filter((s) => s.surveyId !== active.surveyId).map((s) => s.surveyId);
      active.label = val;
      active.surveyId = createSurveyId(active.capturedAt, active.label, otherIds);
      active.provenance.updatedAt = new Date().toISOString();
      activeSurveyId = active.surveyId;
      surveyCatalogTouched = true;
      syncSurveyUrlParams(true);
      renderSurveyCatalogUI();
    });
    el<HTMLSelectElement>('select-active-survey-status')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      const active = getActiveSurvey();
      active.status = normalizeSurveyStatus(val);
      active.provenance.updatedAt = new Date().toISOString();
      surveyCatalogTouched = true;
      renderSurveyCatalogUI();
    });
    el<HTMLInputElement>('input-active-survey-splat')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLInputElement).value;
      const active = getActiveSurvey();
      active.assets.splat = parseSplatReferenceInput(val, active.label);
      if (active.assets.splat && active.status === 'planned') {
        active.status = 'processed';
      }
      active.provenance.updatedAt = new Date().toISOString();
      surveyCatalogTouched = true;
      renderSurveyCatalogUI();
    });

    el<HTMLButtonElement>('btn-load-manifest')?.addEventListener('click', () => {
      if (!manifestFileInput) return;
      manifestFileInput.value = '';
      manifestFileInput.click();
    });
    manifestFileInput?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const manifest = JSON.parse(text);
        await applySiteManifest(manifest);
      } catch (err: any) {
        logEvent(`Manifest parse error: ${err?.message || err}`, 'error');
        showToast('Invalid site_manifest.json file.', 'error');
      }
    });
    el<HTMLButtonElement>('btn-export-manifest')?.addEventListener('click', exportSiteManifest);
    el<HTMLButtonElement>('btn-copy-manifest')?.addEventListener('click', copySiteManifestToClipboard);

    // Camera Bookmark Controls
    const inputBookmarkName = el<HTMLInputElement>('input-bookmark-name');
    el<HTMLButtonElement>('btn-save-bookmark')?.addEventListener('click', () => {
      saveCurrentCameraBookmark();
    });
    inputBookmarkName?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveCurrentCameraBookmark();
    });

    // 3D Surface Measurement Controls
    el<HTMLButtonElement>('btn-measure-distance')?.addEventListener('click', () => {
      setMeasureMode(measureMode === 'distance' ? 'off' : 'distance');
    });
    el<HTMLButtonElement>('btn-measure-area')?.addEventListener('click', () => {
      setMeasureMode(measureMode === 'area' ? 'off' : 'area');
    });
    el<HTMLButtonElement>('btn-measure-clear')?.addEventListener('click', clearMeasurements);

    // Geo-Coordinate Draw Box Controls
    el<HTMLButtonElement>('btn-box-draw')?.addEventListener('click', () => {
      setGeoBoxDrawing(!geoBoxDrawing);
    });
    el<HTMLButtonElement>('btn-box-cancel-draw')?.addEventListener('click', () => {
      setGeoBoxDrawing(false);
      setActiveCard('box');
    });
    el<HTMLButtonElement>('btn-box-from-view')?.addEventListener('click', () => {
      dropGeoBoxAtView();
    });
    el<HTMLButtonElement>('btn-box-frame')?.addEventListener('click', () => {
      frameGeoBox();
    });
    el<HTMLButtonElement>('btn-box-clear')?.addEventListener('click', () => {
      clearGeoBox();
    });
    el<HTMLButtonElement>('btn-box-visible')?.addEventListener('click', () => {
      if (!geoBox) return;
      geoBox.visible = !geoBox.visible;
      refreshGeoBoxGraphics();
    });

    el<HTMLInputElement>('input-box-name')?.addEventListener('input', (e) => {
      if (!geoBox) return;
      geoBox.name = (e.target as HTMLInputElement).value;
      notifyUiStateChanged();
    });

    const handleManualBoxBoundsEdit = () => {
      const s = parseFloat(el<HTMLInputElement>('input-box-south')?.value ?? '');
      const n = parseFloat(el<HTMLInputElement>('input-box-north')?.value ?? '');
      const w = parseFloat(el<HTMLInputElement>('input-box-west')?.value ?? '');
      const eastVal = parseFloat(el<HTMLInputElement>('input-box-east')?.value ?? '');
      if (!Number.isFinite(s) || !Number.isFinite(n) || !Number.isFinite(w) || !Number.isFinite(eastVal)) {
        return;
      }
      if (Math.abs(n - s) < 0.00001 || Math.abs(eastVal - w) < 0.00001) return;
      if (!geoBox) {
        dropGeoBoxAtView({ south: s, north: n, west: w, east: eastVal });
      } else {
        geoBox.south = Math.min(s, n);
        geoBox.north = Math.max(s, n);
        geoBox.west = Math.min(w, eastVal);
        geoBox.east = Math.max(w, eastVal);
        refreshGeoBoxGraphics();
      }
    };
    ['input-box-south', 'input-box-north', 'input-box-west', 'input-box-east'].forEach((id) => {
      el<HTMLInputElement>(id)?.addEventListener('change', handleManualBoxBoundsEdit);
    });

    el<HTMLInputElement>('slider-box-base')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      const valEl = el<HTMLSpanElement>('val-box-base');
      if (valEl) valEl.textContent = `${v >= 0 ? '+' : ''}${Math.round(v)} m`;
      if (!geoBox) return;
      geoBox.baseOffsetMeters = v;
      refreshGeoBoxGraphics();
    });

    el<HTMLInputElement>('slider-box-height')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      const valEl = el<HTMLSpanElement>('val-box-height');
      if (valEl) valEl.textContent = `${Math.round(v)} m`;
      if (!geoBox) return;
      geoBox.heightMeters = Math.max(4, v);
      refreshGeoBoxGraphics();
    });

    document.querySelectorAll<HTMLButtonElement>('.box-views-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const count = Number(btn.dataset.boxViews || 12);
        if (Number.isFinite(count) && count >= 4) {
          geoBoxCaptureViews = count;
          syncGeoBoxUI();
        }
      });
    });

    el<HTMLButtonElement>('btn-box-capture-bundle')?.addEventListener('click', () => {
      void captureGeoBoxStudioBundle();
    });

    el<HTMLButtonElement>('btn-box-export-json')?.addEventListener('click', () => {
      if (!geoBox) return;
      const canvas = viewer?.scene?.canvas as HTMLCanvasElement | undefined;
      const res: [number, number] = [canvas?.width || 1280, canvas?.height || 720];
      const poses = computeGeoBoxCaptureRig(geoBox, geoBoxCaptureViews, res);
      const manifest = buildSplatStudioManifest(geoBox, poses, res);
      const slug =
        geoBox.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site-asset';
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-splatthat-bundle.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Exported Splat Studio Bundle JSON (OpenCV/OpenGL c2w + K + Quat).');
    });

    el<HTMLButtonElement>('btn-box-export-geojson')?.addEventListener('click', () => {
      if (!geoBox) return;
      const geoJson = buildGeoBoxGeoJson(geoBox);
      const slug =
        geoBox.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site-asset';
      const blob = new Blob([JSON.stringify(geoJson, null, 2)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-footprint.geojson`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Exported WGS84 GeoJSON footprint.');
    });

    el<HTMLButtonElement>('btn-box-copy-coords')?.addEventListener('click', async () => {
      if (!geoBox) return;
      const m = computeGeoBoxMetrics(geoBox);
      const payload = JSON.stringify(
        {
          name: m.name,
          south: m.south,
          north: m.north,
          west: m.west,
          east: m.east,
          center: [m.centerLat, m.centerLon],
          baseEllipsoidalMeters: m.baseEllipsoidalMeters,
          ceilingEllipsoidalMeters: m.ceilingEllipsoidalMeters,
          dimensionsMeters: [m.widthMeters, m.depthMeters, m.heightMeters],
        },
        null,
        2
      );
      try {
        await navigator.clipboard.writeText(payload);
        showToast('Geo-Box WGS84 coordinates copied.');
      } catch {
        showToast('Clipboard blocked by browser permissions.', 'error');
      }
    });

    // Home / Globe View
    el<HTMLButtonElement>('btn-home')?.addEventListener('click', () => {
      setFlightMode('explore');
      viewer.scene.globe.show = true;
      if (google3DTileset && !google3DEnabled) google3DTileset.show = false;
      const seq = ++activeFlySeq;
      pendingCameraTarget = {
        lat: 38.5,
        lon: -96.0,
        ellipsoidalHeight: 9500000,
        heading: 0,
        pitch: -90,
        roll: 0,
      };
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-96.0, 38.5, 9500000),
        orientation: {
          heading: 0.0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0.0,
        },
        duration: 1.8,
        complete: () => {
          if (activeFlySeq === seq) pendingCameraTarget = null;
        },
        cancel: () => {
          if (activeFlySeq === seq) pendingCameraTarget = null;
        },
      });
      setActiveCard(null);
    });

    // Keyboard Listeners for WASD Pilot, Escape Auto-Tuck & Zen Mode (H)
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isTyping) return;

      if (e.key === 'Escape') {
        clearSpotlight();
        const modalWasOpen =
          (tokenModal && !tokenModal.classList.contains('hidden')) ||
          (clipModal && !clipModal.classList.contains('hidden'));
        const modeWasActive = flightMode !== 'explore' || measureMode !== 'off' || geoBoxDrawing;
        if (flightMode !== 'explore') setFlightMode('explore');
        if (measureMode !== 'off') setMeasureMode('off');
        if (geoBoxDrawing) {
          setGeoBoxDrawing(false);
          setActiveCard('box');
        }
        closeTokenModal();
        closeClipModal();
        if (!modalWasOpen && !modeWasActive && (activeCard !== null || hudMode === 'summon')) {
          setActiveCard(null);
        }
        return;
      }

      if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setHudTucked(hudMode !== 'zen');
        return;
      }

      if (flightMode === 'wasd') {
        if (
          [
            'KeyW',
            'KeyA',
            'KeyS',
            'KeyD',
            'KeyQ',
            'KeyE',
            'KeyR',
            'KeyF',
            'Space',
            'ShiftLeft',
            'ShiftRight',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
          ].includes(e.code)
        ) {
          e.preventDefault();
          pressedKeys.add(e.code);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      pressedKeys.delete(e.code);
    });
    window.addEventListener('blur', () => {
      pressedKeys.clear();
    });
  }

  const ALL_CARDS: Array<Exclude<ActiveCard, null>> = [
    'world',
    'flight',
    'capture',
    'box',
    'site',
    'weather',
    'telemetry',
  ];

  // Declarative Control-to-Card Registry for Co-Pilot Real-Time UI Awareness & Spotlighting
  const CONTROL_CARD_MAP: Record<string, Exclude<ActiveCard, null>> = {
    'btn-load-redmond': 'world',
    'input-asset-id': 'world',
    'btn-load-asset': 'world',
    'btn-toggle-terrain': 'world',
    'btn-toggle-google3d': 'world',
    'input-clip-asset-id': 'world',
    'btn-apply-clip': 'world',
    'btn-clear-clip': 'world',
    'slider-sse': 'world',
    'slider-height-offset': 'world',
    'input-address-search': 'world',
    'btn-address-search': 'world',
    'btn-fly-coords': 'world',
    'btn-home': 'flight',
    'slider-flight-speed': 'flight',
    'slider-orbit-speed': 'flight',
    'btn-rec-free': 'capture',
    'btn-rec-orbit': 'capture',
    'btn-snapshot-png': 'capture',
    'btn-load-render-path': 'capture',
    'btn-render-frames': 'capture',
    'btn-render-to-folder': 'capture',
    'input-box-name': 'box',
    'btn-box-draw': 'box',
    'btn-box-from-view': 'box',
    'btn-box-frame': 'box',
    'btn-box-visible': 'box',
    'btn-box-clear': 'box',
    'slider-box-base': 'box',
    'slider-box-height': 'box',
    'btn-box-capture-bundle': 'box',
    'btn-box-export-json': 'box',
    'btn-box-export-geojson': 'box',
    'btn-box-copy-coords': 'box',
    'btn-toggle-new-survey': 'site',
    'btn-copy-survey-url': 'site',
    'input-active-survey-date': 'site',
    'input-active-survey-label': 'site',
    'select-active-survey-status': 'site',
    'input-active-survey-splat': 'site',
    'input-site-title': 'site',
    'input-source-crs': 'site',
    'btn-load-manifest': 'site',
    'btn-export-manifest': 'site',
    'btn-copy-manifest': 'site',
    'input-bookmark-name': 'site',
    'btn-save-bookmark': 'site',
    'btn-measure-distance': 'site',
    'btn-measure-area': 'site',
    'btn-measure-clear': 'site',
    'btn-weather-units': 'weather',
    'btn-weather-refresh': 'weather',
    'btn-toggle-3d-weather': 'weather',
    'slider-weather-opacity': 'weather',
  };

  let zenSnapshot: {
    activeCard: ActiveCard;
    hudMode: 'rail' | 'summon';
    copilotOpen: boolean;
  } = {
    activeCard: null,
    hudMode: 'rail',
    copilotOpen: false,
  };

  function clearSpotlight(): void {
    if (spotlightTimer !== null) {
      window.clearTimeout(spotlightTimer);
      spotlightTimer = null;
    }
    if (spotlightCleanup) {
      spotlightCleanup();
      spotlightCleanup = null;
    }
    if (spotlightTag) {
      spotlightTag.classList.add('hidden');
      spotlightTag.textContent = '';
    }
  }

  function highlightControl(controlId: string, note?: string): { ok: boolean; controlId: string; card?: string; error?: string } {
    clearSpotlight();
    const id = controlId.trim();
    if (!id) return { ok: false, controlId: id, error: 'controlId is required.' };

    if (hudMode === 'zen') {
      setHudTucked(false);
    }

    const parentCard = CONTROL_CARD_MAP[id];
    if (parentCard && activeCard !== parentCard) {
      setActiveCard(parentCard);
    }

    const target = el<HTMLElement>(id);
    if (!target) {
      return { ok: false, controlId: id, error: `Control "#${id}" not found in HUD.` };
    }

    const applyHighlight = () => {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      target.classList.add('copilot-spotlight');

      if (spotlightTag) {
        const rect = target.getBoundingClientRect();
        const tagText = (note || '').trim() || target.textContent?.trim() || id;
        spotlightTag.textContent = tagText;
        spotlightTag.classList.remove('hidden');
        const tagW = spotlightTag.offsetWidth || 120;
        const left = Math.max(12, Math.min(window.innerWidth - tagW - 12, rect.left + rect.width / 2 - tagW / 2));
        const top = Math.max(12, rect.top - 32);
        spotlightTag.style.left = `${Math.round(left)}px`;
        spotlightTag.style.top = `${Math.round(top)}px`;
      }

      const onInteract = () => clearSpotlight();
      target.addEventListener('click', onInteract, { once: true });
      spotlightCleanup = () => {
        target.classList.remove('copilot-spotlight');
        target.removeEventListener('click', onInteract);
      };
      spotlightTimer = window.setTimeout(clearSpotlight, 6000);
    };

    window.setTimeout(applyHighlight, parentCard ? 250 : 30);
    return { ok: true, controlId: id, card: parentCard || activeCard || 'rail' };
  }

  function notifyUiStateChanged(): void {
    try {
      controller.onUiStateChange?.(getContextSnapshot());
    } catch {
      // ignore
    }
  }

  function updateRailActiveButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-rail-card]').forEach((btn) => {
      const card = btn.dataset.railCard as Exclude<ActiveCard, null>;
      btn.setAttribute('data-active', String(hudMode === 'rail' && activeCard === card));
    });
    const summonBtn = el<HTMLButtonElement>('btn-summon-all');
    if (summonBtn) {
      summonBtn.setAttribute('data-active', String(hudMode === 'summon'));
    }
  }

  function setActiveCard(card: ActiveCard): void {
    if (hudMode === 'zen' && card !== null) {
      setHudTucked(false);
    }

    // Close Summon-All grid whenever isolating or tucking a single card
    if (summonGrid) {
      summonGrid.setAttribute('data-tucked', 'true');
      summonGrid.setAttribute('aria-hidden', 'true');
    }

    hudMode = 'rail';
    activeCard = card;

    ALL_CARDS.forEach((c) => {
      const node = el<HTMLElement>(`card-${c}`);
      if (!node) return;
      if (c === card) {
        node.classList.remove('hidden');
        requestAnimationFrame(() => {
          if (activeCard === c && hudMode === 'rail') {
            node.setAttribute('data-tucked', 'false');
            node.setAttribute('aria-hidden', 'false');
          }
        });
      } else {
        node.setAttribute('data-tucked', 'true');
        node.setAttribute('aria-hidden', 'true');
        window.setTimeout(() => {
          if (activeCard !== c) {
            node.classList.add('hidden');
          }
        }, 190);
      }
    });

    updateRailActiveButtons();
    notifyUiStateChanged();
  }

  function toggleSummonAll(): void {
    if (hudMode === 'zen') {
      setHudTucked(false);
    }
    if (hudMode === 'summon') {
      setActiveCard(null);
      return;
    }

    // Tuck any currently open single card cleanly
    ALL_CARDS.forEach((c) => {
      const node = el<HTMLElement>(`card-${c}`);
      if (!node) return;
      node.setAttribute('data-tucked', 'true');
      node.setAttribute('aria-hidden', 'true');
      window.setTimeout(() => {
        if (activeCard !== c) node.classList.add('hidden');
      }, 190);
    });

    activeCard = null;
    hudMode = 'summon';
    if (summonGrid) {
      summonGrid.setAttribute('data-tucked', 'false');
      summonGrid.setAttribute('aria-hidden', 'false');
    }

    updateRailActiveButtons();
    notifyUiStateChanged();
  }

  function setHudTucked(tucked: boolean): void {
    const isCurrentlyZen = hudMode === 'zen';
    if (isCurrentlyZen === tucked) return;

    const headerEl = document.querySelector('header') as HTMLElement | null;
    const dockEl = el<HTMLElement>('hud-dock');
    const recallBtn = el<HTMLButtonElement>('btn-recall-hud');

    if (tucked) {
      clearSpotlight();
      zenSnapshot = {
        activeCard,
        hudMode: hudMode === 'summon' ? 'summon' : 'rail',
        copilotOpen: controller.isCopilotDrawerVisible?.() ?? false,
      };
      hudMode = 'zen';

      ALL_CARDS.forEach((c) => {
        const node = el<HTMLElement>(`card-${c}`);
        if (!node) return;
        node.setAttribute('data-tucked', 'true');
        node.setAttribute('aria-hidden', 'true');
      });
      if (summonGrid) {
        summonGrid.setAttribute('data-tucked', 'true');
        summonGrid.setAttribute('aria-hidden', 'true');
      }
      controller.setCopilotDrawerVisible?.(false);

      headerEl?.setAttribute('data-tucked', 'true');
      flightClusterGauge?.setAttribute('data-tucked', 'true');
      flightClusterGauge?.setAttribute('aria-hidden', 'true');
      dockEl?.setAttribute('data-tucked', 'true');
      recallBtn?.setAttribute('data-tucked', 'false');
      recallBtn?.setAttribute('aria-hidden', 'false');
      notifyUiStateChanged();
    } else {
      hudMode = 'rail';
      recallBtn?.setAttribute('data-tucked', 'true');
      recallBtn?.setAttribute('aria-hidden', 'true');
      headerEl?.setAttribute('data-tucked', 'false');
      flightClusterGauge?.setAttribute('data-tucked', 'false');
      flightClusterGauge?.setAttribute('aria-hidden', 'false');
      dockEl?.setAttribute('data-tucked', 'false');

      if (zenSnapshot.copilotOpen) {
        controller.setCopilotDrawerVisible?.(true);
      }
      if (zenSnapshot.hudMode === 'summon') {
        toggleSummonAll();
      } else {
        setActiveCard(zenSnapshot.activeCard);
      }
    }
  }

  function getVisibleControlsSnapshot(): UiControlEntry[] {
    const entries: UiControlEntry[] = [];
    if (hudMode === 'zen') {
      entries.push({ id: 'btn-recall-hud', label: 'Show HUD (H)', card: 'zen' });
      return entries;
    }

    if (hudMode === 'summon') {
      return [
        { id: 'card-world', label: 'World (3DGS, Layers, LOD, Coords)', card: 'summon' },
        { id: 'card-flight', label: 'Flight (WASD, Orbit, Speed, Lens)', card: 'summon' },
        { id: 'card-capture', label: 'Capture (Record, 360°, Render Path)', card: 'summon' },
        { id: 'card-site', label: 'Site (Manifest, Bookmarks, Measure)', card: 'summon' },
      ];
    }

    if (activeCard === 'world') {
      return [
        { id: 'btn-load-redmond', label: '110M Splat Campus (#4547222)', card: 'world' },
        { id: 'btn-toggle-terrain', label: 'World Terrain', card: 'world', active: worldTerrainEnabled },
        { id: 'btn-toggle-google3d', label: 'Google 3D Tiles', card: 'world', active: google3DEnabled },
        { id: 'btn-load-asset', label: 'Load Ion Asset ID', card: 'world' },
        { id: 'btn-apply-clip', label: 'Clip GeoJSON', card: 'world', active: activeClipAssetId !== null },
        { id: 'slider-sse', label: 'LOD SSE', card: 'world', value: `${currentSSE} px` },
        { id: 'slider-height-offset', label: 'Height Nudge', card: 'world', value: `${currentHeightOffset} m` },
        { id: 'btn-address-search', label: 'Find Address', card: 'world' },
        { id: 'btn-fly-coords', label: 'Fly To Coordinates', card: 'world' },
      ];
    }
    if (activeCard === 'flight') {
      return [
        { id: 'flight-mode-status', label: 'Flight Mode', card: 'flight', value: flightMode },
        { id: 'slider-flight-speed', label: 'Airspeed', card: 'flight', value: `${wasdSpeedMps} m/s` },
        { id: 'slider-orbit-speed', label: 'Orbit Rate', card: 'flight', value: `${orbitSpeedDegPerSec} deg/s` },
        { id: 'val-lens-fov', label: '35mm Lens', card: 'flight', value: `${activeLensMm}mm` },
        { id: 'btn-home', label: 'Reset Globe', card: 'flight' },
      ];
    }
    if (activeCard === 'capture') {
      return [
        { id: 'btn-rec-free', label: isRecording ? 'Stop Recording' : 'Record Flight', card: 'capture', active: isRecording },
        { id: 'btn-rec-orbit', label: '1-Lap 360° Clip', card: 'capture' },
        { id: 'btn-snapshot-png', label: 'Snapshot PNG', card: 'capture' },
        { id: 'btn-load-render-path', label: 'Load Render Path JSON', card: 'capture', value: loadedRenderPath ? `${loadedRenderPath.samples.length} frames` : 'none' },
        { id: 'btn-render-frames', label: 'Render Frames (ZIP)', card: 'capture', disabled: !loadedRenderPath || isRenderingPath },
        { id: 'btn-render-to-folder', label: 'Render to Folder', card: 'capture', disabled: !loadedRenderPath || isRenderingPath || !supportsDirectoryPicker },
      ];
    }
    if (activeCard === 'box') {
      const m = geoBox ? computeGeoBoxMetrics(geoBox) : null;
      return [
        { id: 'btn-box-draw', label: 'Draw on Globe', card: 'box', active: geoBoxDrawing },
        { id: 'btn-box-from-view', label: 'Drop Box at View', card: 'box' },
        { id: 'btn-box-frame', label: 'Frame Geo-Box', card: 'box', disabled: !geoBox },
        { id: 'btn-box-capture-bundle', label: 'Capture Studio Bundle (ZIP)', card: 'box', disabled: !geoBox || isCapturingGeoBox, value: `${geoBoxCaptureViews} views` },
        { id: 'btn-box-export-json', label: 'Export Bundle JSON', card: 'box', disabled: !geoBox },
        { id: 'btn-box-export-geojson', label: 'Export GeoJSON', card: 'box', disabled: !geoBox },
        { id: 'slider-box-height', label: 'Ceiling Height', card: 'box', value: m ? `${m.heightMeters} m` : '60 m' },
      ];
    }
    if (activeCard === 'site') {
      return [
        { id: 'btn-load-manifest', label: 'Load Manifest JSON', card: 'site' },
        { id: 'btn-export-manifest', label: 'Export Manifest JSON', card: 'site' },
        { id: 'btn-copy-manifest', label: 'Copy Manifest JSON', card: 'site' },
        { id: 'btn-save-bookmark', label: 'Save Camera Bookmark', card: 'site', value: `${cameraBookmarks.length} saved` },
        { id: 'btn-measure-distance', label: 'Measure Distance', card: 'site', active: measureMode === 'distance' },
        { id: 'btn-measure-area', label: 'Measure Area', card: 'site', active: measureMode === 'area' },
        { id: 'btn-measure-clear', label: 'Clear Measurement', card: 'site' },
      ];
    }
    if (activeCard === 'weather') {
      return [
        { id: 'btn-weather-units', label: 'Temperature Units', card: 'weather', value: weatherUnits },
        { id: 'btn-weather-refresh', label: 'Refresh Weather', card: 'weather' },
        { id: 'btn-toggle-3d-weather', label: '3D Wind Vectors', card: 'weather', active: show3DWeatherOverlay },
        { id: 'slider-weather-opacity', label: 'Weather Layer Opacity', card: 'weather', value: `${Math.round(weatherOpacity * 100)}%` },
      ];
    }
    if (activeCard === 'telemetry') {
      return [
        { id: 'metric-fps', label: 'FPS', card: 'telemetry', value: `${Math.round(smoothedFps)}` },
        { id: 'metric-tilesets', label: 'Loaded Tilesets', card: 'telemetry', value: `${activeTilesets.length}` },
      ];
    }

    // No card open: bottom command rail + ion token pill are visible
    return [
      { id: 'btn-open-token', label: 'ion Token', card: 'header', active: ionConnected },
      { id: 'btn-summon-all', label: 'Summon All Cards', card: 'rail' },
      { id: 'btn-toggle-copilot', label: 'Co-Pilot', card: 'rail', active: controller.isCopilotDrawerVisible?.() ?? false },
      { id: 'btn-tuck-hud', label: 'Zen Mode (H)', card: 'rail' },
    ];
  }

  function getCameraState(): CameraState | null {
    if (pendingCameraTarget) {
      return { ...pendingCameraTarget };
    }
    if (!viewer?.camera?.positionCartographic) return null;
    const carto = viewer.camera.positionCartographic;
    return {
      lat: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
      lon: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)),
      ellipsoidalHeight: Number(carto.height.toFixed(2)),
      heading: Number(Cesium.Math.toDegrees(viewer.camera.heading).toFixed(2)),
      pitch: Number(Cesium.Math.toDegrees(viewer.camera.pitch).toFixed(2)),
      roll: Number(Cesium.Math.toDegrees(viewer.camera.roll).toFixed(2)),
    };
  }

  function getContextSnapshot(): CopilotContextSnapshot {
    const uiState: UiStateSnapshot = {
      hudMode,
      activeCard,
      copilotOpen: controller.isCopilotDrawerVisible?.() ?? false,
      visibleControls: getVisibleControlsSnapshot(),
    };
    return {
      camera: getCameraState(),
      loadedTilesets: activeTilesets.map((t) => ({
        assetId: t.id,
        name: t.name,
        visible: t.visible,
      })),
      activeLayers: {
        worldTerrain: worldTerrainEnabled,
        google3DTiles: google3DEnabled,
        ionConnected,
        sse: currentSSE,
        verticalOffsetMeters: currentHeightOffset,
        weatherLayer: activeWeatherLayer,
        show3DWeather: show3DWeatherOverlay,
      },
      flightMode,
      isRecording,
      lensMm: activeLensMm,
      airspeedMps: wasdSpeedMps,
      bookmarkCount: cameraBookmarks.length,
      weatherAdvisory: lastWeatherData
        ? {
            stationName: lastWeatherData.stationName,
            advisory: lastWeatherData.flightAdvisory,
            advisoryLabel: lastWeatherData.flightAdvisoryLabel,
            windSpeedMps: lastWeatherData.windSpeedMps,
            windCardinal: lastWeatherData.windCardinal,
            tempC: lastWeatherData.tempC,
            cloudCoverPct: lastWeatherData.cloudCoverPct,
            updatedAt: lastWeatherData.updatedAt,
          }
        : null,
      geoBox: geoBox ? computeGeoBoxMetrics(geoBox) : null,
      surveyCatalog: {
        activeSurveyId,
        compareSurveyId,
        surveyCount: surveyCatalog.length,
        surveys: sortSurveysNewestFirst(surveyCatalog).map((s) => ({
          surveyId: s.surveyId,
          capturedAt: s.capturedAt,
          label: s.label,
          status: s.status,
          tilesetCount: s.surveyId === activeSurveyId ? activeTilesets.length : s.assets.tilesets.length,
          bookmarkCount: s.surveyId === activeSurveyId ? cameraBookmarks.length : s.bookmarks.length,
          hasSplat: Boolean(s.assets.splat),
        })),
      },
      uiState,
    };
  }

  async function executeTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CopilotToolResult> {
    try {
      switch (name) {
        case 'flyTo': {
          const current = getCameraState();
          const hasLat = args.lat !== undefined && args.lat !== null && Number.isFinite(Number(args.lat));
          const hasLon = args.lon !== undefined && args.lon !== null && Number.isFinite(Number(args.lon));
          const hasHeight =
            args.height !== undefined && args.height !== null && Number.isFinite(Number(args.height));
          const hasHeading =
            args.heading !== undefined && args.heading !== null && Number.isFinite(Number(args.heading));
          const hasPitch =
            args.pitch !== undefined && args.pitch !== null && Number.isFinite(Number(args.pitch));
          const hasRoll =
            args.roll !== undefined && args.roll !== null && Number.isFinite(Number(args.roll));

          const lat = hasLat ? Number(args.lat) : (current?.lat ?? NaN);
          const lon = hasLon ? Number(args.lon) : (current?.lon ?? NaN);
          const height = hasHeight ? Number(args.height) : (current?.ellipsoidalHeight ?? 650);
          const heading = hasHeading ? Number(args.heading) : (current?.heading ?? 0);
          const pitch = hasPitch ? Number(args.pitch) : (current?.pitch ?? -35);
          const roll = hasRoll ? Number(args.roll) : (current?.roll ?? 0);

          const sameSpot =
            current !== null &&
            Math.abs(lat - current.lat) < 0.002 &&
            Math.abs(lon - current.lon) < 0.002;
          const orientationOnly = !hasLat && !hasLon && !hasHeight;
          const ok = flyToWGS84(lat, lon, height, pitch, heading, roll, {
            keepAltitudeFlat: sameSpot,
            preserveExactPosition: orientationOnly,
            duration: sameSpot ? 0.8 : 2.0,
          });
          return ok
            ? { ok: true, lat, lon, height, heading, pitch, roll }
            : { ok: false, error: 'Invalid WGS84 coordinates or viewer not ready.' };
        }

        case 'searchAddress': {
          const query = String(args.query || '').trim();
          return await searchGlobalAddress(query);
        }

        case 'loadIonAsset': {
          const assetId = Number(args.assetId);
          const label = typeof args.name === 'string' ? args.name : '';
          return await loadIonTileset(assetId, label);
        }

        case 'setTilesetVisible': {
          const assetId = Number(args.assetId);
          const visible = Boolean(args.visible);
          return setTilesetVisibleById(assetId, visible);
        }

        case 'removeTileset': {
          const assetId = Number(args.assetId);
          return removeTilesetById(assetId);
        }

        case 'setLayer': {
          const layer = String(args.layer || '');
          const on = Boolean(args.on);
          if (layer === 'worldTerrain') {
            if (on !== worldTerrainEnabled) {
              await toggleWorldTerrain();
            }
            const ok = worldTerrainEnabled === on;
            return {
              ok,
              layer: 'worldTerrain',
              enabled: worldTerrainEnabled,
              requiresToken: !ionConnected && on,
              message: ok
                ? `World Terrain is now ${worldTerrainEnabled ? 'on' : 'off'}.`
                : 'Cesium ion token is required to enable World Terrain. Opened the ion Token modal.',
            };
          }
          if (layer === 'google3DTiles') {
            if (on !== google3DEnabled) {
              await toggleGoogle3DTiles();
            }
            const ok = google3DEnabled === on;
            return {
              ok,
              layer: 'google3DTiles',
              enabled: google3DEnabled,
              requiresToken: !ionConnected && on,
              message: ok
                ? `Google Photorealistic 3D Tiles is now ${google3DEnabled ? 'on' : 'off'}.`
                : 'Cesium ion token is required to enable Google Photorealistic 3D Tiles. Opened the ion Token modal.',
            };
          }
          return { ok: false, error: `Unknown layer "${layer}". Use "worldTerrain" or "google3DTiles".` };
        }

        case 'setSSE': {
          const val = Number(args.value);
          if (!Number.isFinite(val)) return { ok: false, error: 'Numeric SSE value (1-32) required.' };
          const applied = applySSE(val);
          return { ok: true, sse: applied, updatedTilesets: activeTilesets.length };
        }

        case 'setHeightNudge': {
          const meters = Number(args.meters);
          if (!Number.isFinite(meters)) return { ok: false, error: 'Numeric height offset in metres required.' };
          const applied = applyHeightNudge(meters);
          return { ok: true, verticalOffsetMeters: applied, updatedTilesets: activeTilesets.length };
        }

        case 'setFlightMode': {
          const mode = String(args.mode || '') as FlightMode;
          if (!['explore', 'wasd', 'orbit', 'tour'].includes(mode)) {
            return { ok: false, error: 'Invalid flight mode. Use explore, wasd, orbit, or tour.' };
          }
          setFlightMode(mode);
          const ok = flightMode === mode;
          return {
            ok,
            mode: flightMode,
            error: ok
              ? undefined
              : mode === 'tour'
                ? 'Save at least one camera bookmark before starting Tour Views.'
                : 'Could not switch flight mode.',
          };
        }

        case 'setAirspeed': {
          const mps = Number(args.mps);
          if (!Number.isFinite(mps)) return { ok: false, error: 'Numeric airspeed in m/s required.' };
          const applied = applyAirspeed(mps);
          return { ok: true, airspeedMps: applied };
        }

        case 'setLens': {
          const mm = Number(args.mm);
          if (![18, 24, 35, 50].includes(mm)) {
            return { ok: false, error: 'Lens focal length must be 18, 24, 35, or 50 mm.' };
          }
          applyLensPreset(mm);
          return { ok: true, lensMm: activeLensMm };
        }

        case 'startRecording': {
          if (isRecording) {
            return { ok: true, recording: true, alreadyRecording: true, mode: recordingModeLabel };
          }
          const modeLabel =
            flightMode === 'wasd'
              ? 'WASD Pilot'
              : flightMode === 'orbit'
                ? '360° Orbit'
                : 'Free Flight';
          const started = startRecording(modeLabel);
          return {
            ok: started,
            recording: isRecording,
            mode: recordingModeLabel,
            error: started ? undefined : 'Browser could not start WebGL MediaRecorder capture.',
          };
        }

        case 'stopRecording': {
          const wasRecording = isRecording;
          stopRecording();
          return { ok: true, wasRecording, recording: false };
        }

        case 'record360Lap': {
          return startRecord360Lap();
        }

        case 'takeSnapshot': {
          const ok = capturePngSnapshot();
          return {
            ok,
            message: ok ? 'High-resolution PNG snapshot downloaded.' : 'Snapshot capture failed.',
          };
        }

        case 'addBookmark': {
          const nameArg = typeof args.name === 'string' ? args.name.trim() : '';
          const bm = saveCurrentCameraBookmark(nameArg || undefined);
          return bm
            ? { ok: true, bookmark: bm, totalBookmarks: cameraBookmarks.length }
            : { ok: false, error: 'Camera not ready to save bookmark.' };
        }

        case 'listBookmarks': {
          return { ok: true, count: cameraBookmarks.length, bookmarks: cameraBookmarks };
        }

        case 'flyToBookmark': {
          const query = String(args.name || '').trim().toLowerCase();
          if (!query) return { ok: false, error: 'Bookmark name required.' };
          const bm =
            cameraBookmarks.find((b) => b.name.toLowerCase() === query) ||
            cameraBookmarks.find((b) => b.name.toLowerCase().includes(query));
          if (!bm) {
            return {
              ok: false,
              error: `Bookmark "${args.name}" not found.`,
              available: cameraBookmarks.map((b) => b.name),
            };
          }
          flyToBookmark(bm);
          return { ok: true, bookmark: bm };
        }

        case 'measure': {
          const mode = String(args.mode || '') as MeasureMode;
          if (mode !== 'distance' && mode !== 'area') {
            return { ok: false, error: 'Measurement mode must be "distance" or "area".' };
          }
          setMeasureMode(mode);
          return {
            ok: true,
            mode: measureMode,
            instruction: 'Left-click points on the 3D globe or tileset; right-click to finish.',
          };
        }

        case 'getWeather': {
          let lat = lastWeatherLat;
          let lon = lastWeatherLon;
          const target = pickViewportTarget();
          if (target) {
            const carto = Cesium.Cartographic.fromCartesian(target);
            if (carto) {
              lat = Cesium.Math.toDegrees(carto.latitude);
              lon = Cesium.Math.toDegrees(carto.longitude);
            }
          } else if (viewer?.camera?.positionCartographic) {
            lat = Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude);
            lon = Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude);
          }

          const data = await fetchAndRenderSiteWeather(lat, lon, false);
          if (!data) {
            return { ok: false, error: 'Live weather service temporarily unavailable.' };
          }
          return {
            ok: true,
            stationName: data.stationName,
            country: data.country,
            condition: data.description || data.condition,
            tempC: data.tempC,
            tempF: Math.round((data.tempC * 9) / 5 + 32),
            windSpeedMps: data.windSpeedMps,
            windSpeedMph: Number((data.windSpeedMps * 2.23694).toFixed(1)),
            windGustMps: data.windGustMps,
            windCardinal: data.windCardinal,
            windDeg: data.windDeg,
            cloudCoverPct: data.cloudCoverPct,
            humidityPct: data.humidityPct,
            pressureHpa: data.pressureHpa,
            flightAdvisory: data.flightAdvisory,
            flightAdvisoryLabel: data.flightAdvisoryLabel,
          };
        }

        case 'getCameraState': {
          const state = getCameraState();
          return state ? { ok: true, ...state } : { ok: false, error: 'Camera state unavailable.' };
        }

        case 'exportManifest': {
          const manifest = buildSiteManifest();
          exportSiteManifest();
          return { ok: true, manifest };
        }

        case 'loadManifest': {
          const raw = args.json;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          await applySiteManifest(parsed, {
            requestedSurveyId: typeof args.surveyId === 'string' ? args.surveyId : null,
            requestedCompareId: typeof args.compareSurveyId === 'string' ? args.compareSurveyId : null,
          });
          return {
            ok: true,
            title: parsed?.title || parsed?.siteId || 'Site',
            activeSurveyId,
            compareSurveyId,
            surveyCount: surveyCatalog.length,
            tilesetsLoaded: activeTilesets.length,
            bookmarksLoaded: cameraBookmarks.length,
          };
        }

        case 'selectSurvey': {
          const surveyId = String(args.surveyId || '').trim();
          const ok = await selectSurvey(surveyId, { flyToFirst: args.flyToFirst !== false });
          if (typeof args.compareSurveyId === 'string') {
            setCompareSurvey(args.compareSurveyId.trim() || null, true);
          }
          return ok
            ? { ok: true, activeSurveyId, compareSurveyId }
            : { ok: false, error: `Survey "${surveyId}" not found.` };
        }

        case 'createSurvey': {
          const created = await createNewSurveyEpoch({
            capturedAt: typeof args.capturedAt === 'string' ? args.capturedAt : undefined,
            label: typeof args.label === 'string' ? args.label : undefined,
            status: typeof args.status === 'string' ? normalizeSurveyStatus(args.status) : undefined,
            splatInput: typeof args.splat === 'string' ? args.splat : undefined,
          });
          return { ok: true, survey: created };
        }

        case 'openPanel': {
          const panel = String(args.panel || '').toLowerCase();
          if (panel === 'summon') {
            toggleSummonAll();
            return { ok: true, panel: 'summon', activeCard: null };
          }
          if (panel === 'none' || panel === 'close') {
            setActiveCard(null);
            return { ok: true, panel: 'none', activeCard: null };
          }
          if (ALL_CARDS.includes(panel as Exclude<ActiveCard, null>)) {
            setActiveCard(panel as Exclude<ActiveCard, null>);
            return { ok: true, panel, activeCard: panel };
          }
          return { ok: false, error: `Unknown panel "${panel}".` };
        }

        case 'highlightControl': {
          const controlId = String(args.controlId || '');
          const note = typeof args.note === 'string' ? args.note : undefined;
          return highlightControl(controlId, note);
        }

        case 'setGeoBox': {
          const snap = dropGeoBoxAtView({
            name: typeof args.name === 'string' ? args.name : undefined,
            centerLat: args.centerLat !== undefined ? Number(args.centerLat) : undefined,
            centerLon: args.centerLon !== undefined ? Number(args.centerLon) : undefined,
            widthMeters: args.widthMeters !== undefined ? Number(args.widthMeters) : undefined,
            depthMeters: args.depthMeters !== undefined ? Number(args.depthMeters) : undefined,
            south: args.south !== undefined ? Number(args.south) : undefined,
            north: args.north !== undefined ? Number(args.north) : undefined,
            west: args.west !== undefined ? Number(args.west) : undefined,
            east: args.east !== undefined ? Number(args.east) : undefined,
            heightMeters: args.heightMeters !== undefined ? Number(args.heightMeters) : undefined,
            baseOffsetMeters: args.baseOffsetMeters !== undefined ? Number(args.baseOffsetMeters) : undefined,
            frame: args.frame !== false,
          });
          if (!snap) return { ok: false, error: 'Could not determine 3D surface coordinates for Geo-Box.' };
          setActiveCard('box');
          return { ok: true, geoBox: snap };
        }

        case 'clearGeoBox': {
          clearGeoBox();
          return { ok: true };
        }

        case 'webSearch': {
          const query = String(args.query || '').trim();
          if (!query) return { ok: false, error: 'Search query is required.' };
          const res = await fetch('/api/copilot/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          });
          const data = await res.json();
          if (!res.ok || !data?.ok) {
            return { ok: false, query, error: data?.error || `Web search HTTP ${res.status}` };
          }
          logEvent(`Co-Pilot web search: "${query}" (${data.sources?.length ?? 0} sources).`, 'info');
          return {
            ok: true,
            query: data.query || query,
            summary: data.summary || '',
            sources: Array.isArray(data.sources) ? data.sources : [],
            engine: data.engine || 'google-search',
          };
        }

        default:
          return { ok: false, error: `Unknown tool "${name}".` };
      }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  const controller: NoDroneController = {
    getContextSnapshot,
    executeTool,
    hideControlPanel: () => {
      setActiveCard(null);
    },
  };

  // Wire Bottom Command Rail, Summon-All, Card Done, and Zen Mode synchronously on boot
  document.querySelectorAll<HTMLButtonElement>('[data-rail-card]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.dataset.railCard as Exclude<ActiveCard, null>;
      if (!card) return;
      if (hudMode === 'rail' && activeCard === card) {
        setActiveCard(null);
      } else {
        setActiveCard(card);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-summon-card]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.dataset.summonCard as Exclude<ActiveCard, null>;
      if (card) setActiveCard(card);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-card-done]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setActiveCard(null);
    });
  });

  el<HTMLButtonElement>('btn-summon-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSummonAll();
  });

  el<HTMLButtonElement>('btn-tuck-hud')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setHudTucked(true);
  });

  el<HTMLButtonElement>('btn-recall-hud')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setHudTucked(false);
  });

  // Chronograph Altimeter + Airspeedometer Cluster Gauge Controls
  applyClusterUnitLabels();
  el<HTMLButtonElement>('btn-cluster-units')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clusterUnits = clusterUnits === 'imperial' ? 'metric' : 'imperial';
    applyClusterUnitLabels();
    lastClusterSampleMs = 0;
    updateFlightClusterGauge(performance.now());
  });
  el<HTMLButtonElement>('btn-toggle-cluster')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clusterCollapsed = !clusterCollapsed;
    const body = el<HTMLDivElement>('cluster-dials-body');
    const btn = el<HTMLButtonElement>('btn-toggle-cluster');
    const hdr = flightClusterGauge?.querySelector('div:first-child') as HTMLElement | null;
    if (body) body.classList.toggle('hidden', clusterCollapsed);
    if (btn) btn.textContent = clusterCollapsed ? '+' : '−';
    if (hdr) {
      hdr.classList.toggle('border-b', !clusterCollapsed);
      hdr.classList.toggle('pb-1.5', !clusterCollapsed);
      hdr.classList.toggle('mb-2', !clusterCollapsed);
    }
  });

  // Clean unobstructed 3D globe on initial launch (no cards open; bottom rail + top-left brand pill + cluster gauge)
  setActiveCard(null);
  initCesium();
  return controller;
}
