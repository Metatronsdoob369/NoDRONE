import type {
  CameraBookmark,
  CameraState,
  CopilotContextSnapshot,
  CopilotToolResult,
  FlightMode,
  HealthState,
  LogLevel,
  MeasureMode,
  NoDroneController,
  PanelTab,
  RecordedClip,
  SiteManifest,
  SiteWeatherData,
  TilesetEntry,
  WeatherTileLayer,
  WeatherUnitSystem,
} from './types';

// Optional: Paste a read-only public Cesium ion token here if embedding publicly
const DEFAULT_ION_TOKEN = '';
const STORAGE_KEY = 'cesium_splatmap_ion_token';
const REDMOND_SPLAT_ASSET_ID = 4547222;

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

  // UI Visibility State (Controls starts closed by default on load so Co-Pilot / globe open cleanly)
  let panelVisible = false;
  let healthVisible = window.innerWidth >= 640;
  let activeTab: PanelTab = 'map';

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
  let recordingTimerHandle: number | null = null;
  let recordingModeLabel = 'Free Flight';
  let recordedClips: RecordedClip[] = [];

  // 3D Surface Measurement State
  let measureMode: MeasureMode = 'off';
  let measurePositions: any[] = [];
  let measureEntities: any[] = [];
  let measureHandler: any = null;

  // Telemetry State
  let frameCount = 0;
  let lastFpsCheck = performance.now();
  let smoothedFps = 60;

  // Real-Time Weather Overlay State
  let weatherVisible = window.innerWidth >= 640;
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
  const controlPanel = el<HTMLElement>('control-panel');
  const healthPanel = el<HTMLElement>('health-panel');
  const healthLogList = el<HTMLDivElement>('health-log-list');
  const tilesetListEl = el<HTMLDivElement>('tileset-list');
  const bookmarkListEl = el<HTMLDivElement>('bookmark-list');
  const clipListEl = el<HTMLDivElement>('clip-list');
  const manifestFileInput = el<HTMLInputElement>('input-manifest-file');
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
  const weatherHud = el<HTMLElement>('weather-hud');

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

  function setPanelTab(tab: PanelTab): void {
    activeTab = tab;
    const tabs: PanelTab[] = ['map', 'flight', 'manifest'];
    tabs.forEach((t) => {
      const content = el<HTMLDivElement>(`tab-content-${t}`);
      if (content) {
        content.classList.toggle('hidden', t !== tab);
        content.classList.toggle('flex', t === tab);
      }
    });

    document.querySelectorAll<HTMLButtonElement>('.panel-tab-btn').forEach((btn) => {
      const isSelected = btn.dataset.panelTab === tab;
      btn.className = isSelected
        ? 'panel-tab-btn px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap bg-zinc-800 text-zinc-100'
        : 'panel-tab-btn px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap text-zinc-400 hover:text-zinc-200';
    });
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
      btn.className =
        mm === focalLengthMm
          ? 'lens-btn px-2 py-1.5 rounded-lg bg-indigo-600/20 border border-indigo-500/40 text-xs font-mono text-indigo-200 transition-colors cursor-pointer'
          : 'lens-btn px-2 py-1.5 rounded-lg bg-zinc-950/70 hover:bg-zinc-800 border border-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer';
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
      const active = m === flightMode;
      btn.className = active
        ? 'flight-mode-btn px-3 py-2 rounded-xl bg-indigo-600/20 border border-indigo-500/40 text-xs font-medium text-indigo-200 transition-colors text-left cursor-pointer'
        : 'flight-mode-btn px-3 py-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700/70 text-xs font-medium text-zinc-300 transition-colors text-left cursor-pointer';
      const sub = btn.querySelector('div:last-child');
      if (sub) {
        sub.className = active ? 'text-[10px] text-indigo-300/80' : 'text-[10px] text-zinc-400';
      }
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

      mediaRecorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunks.push(ev.data);
        }
      };

      mediaRecorder.onstop = () => {
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
        recordedClips = recordedClips.filter((c) => c.id !== clip.id);
        renderClipList();
      });

      actions.append(btnPlay, btnDel);
      row.append(info, actions);
      clipListEl.appendChild(row);
    });
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
        mode === 'off' ? 'text-[11px] font-mono text-zinc-500' : 'text-[11px] font-mono text-indigo-300';
    }

    const activeCls =
      'px-2 py-2 rounded-xl bg-indigo-600/25 border border-indigo-500/50 text-xs font-semibold text-indigo-200 transition-colors cursor-pointer';
    const idleCls =
      'px-2 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/70 text-xs font-medium text-zinc-200 transition-colors cursor-pointer';
    if (btnDist) btnDist.className = mode === 'distance' ? activeCls : idleCls;
    if (btnArea) btnArea.className = mode === 'area' ? activeCls : idleCls;

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
          ? 'font-medium text-red-300 whitespace-nowrap shrink-0'
          : data.flightAdvisory === 'caution'
            ? 'font-medium text-amber-300 whitespace-nowrap shrink-0'
            : 'font-medium text-emerald-300 whitespace-nowrap shrink-0';
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
      btn.className = isSelected
        ? 'weather-layer-btn px-1.5 py-1.5 rounded-lg bg-indigo-600/20 border border-indigo-500/40 text-[11px] font-medium text-indigo-200 transition-colors cursor-pointer'
        : 'weather-layer-btn px-1.5 py-1.5 rounded-lg bg-zinc-950/70 hover:bg-zinc-800 border border-zinc-800 text-[11px] font-medium text-zinc-300 transition-colors cursor-pointer';
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

      // Scene hooks: Pre-update for Drone Flight, Post-render for Telemetry, MoveEnd for Weather Sync
      viewer.scene.preUpdate.addEventListener(handlePreUpdate);
      viewer.scene.postRender.addEventListener(updateTelemetry);
      viewer.camera.moveEnd.addEventListener(scheduleCameraWeatherSync);

      // Default starting camera over the Continental US
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-96.0, 38.5, 9500000),
        orientation: {
          heading: 0.0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0.0,
        },
      });

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

      // Auto-load a hosted site_manifest.json if provided via ?manifest=URL
      const params = new URLSearchParams(window.location.search);
      const manifestUrl = params.get('manifest');
      if (manifestUrl) {
        await loadManifestFromUrl(manifestUrl);
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
        if (activeWeatherLayer !== 'off') {
          setWeatherTileLayer(activeWeatherLayer, true);
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
    const status = el<HTMLDivElement>(statusId);
    if (!btn || !status) return;

    if (active) {
      btn.className =
        'px-3 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-xs font-medium text-indigo-200 transition-colors text-left cursor-pointer';
      status.className = 'text-[10px] text-indigo-300';
      status.textContent = 'Active';
    } else {
      btn.className =
        'px-3 py-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700/70 text-xs font-medium text-zinc-300 transition-colors text-left cursor-pointer';
      status.className = 'text-[10px] text-zinc-400';
      status.textContent = 'Off';
    }
  }

  function renderTilesetList(): void {
    if (!tilesetListEl) return;
    tilesetListEl.innerHTML = '';
    if (activeTilesets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-[11px] text-zinc-500 italic';
      empty.textContent = 'No custom 3DGS / 3D Tilesets loaded yet.';
      tilesetListEl.appendChild(empty);
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
      btnFly.className = 'px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-medium text-zinc-200 transition-colors cursor-pointer';
      btnFly.textContent = 'Fly';
      btnFly.addEventListener('click', () => flyToBookmark(bm));

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
  }

  function buildSiteManifest(): SiteManifest {
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

    return {
      schemaVersion: '1.0',
      siteId,
      title,
      exportedAt: new Date().toISOString(),
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
      tilesets: activeTilesets.map((t) => ({
        name: t.name,
        ionAssetId: t.id,
        type: '3dtiles',
        visible: t.visible,
        clippingGeoJsonAssetId: activeClipAssetId,
      })),
      bookmarks: cameraBookmarks,
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
      `Exported "${manifest.siteId}_manifest.json" (${manifest.tilesets.length} tilesets, ${manifest.bookmarks.length} bookmarks).`,
      'ok'
    );
    showToast(`Exported ${manifest.siteId}_manifest.json`);
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
      logEvent('Copied site_manifest.json to clipboard.', 'ok');
      showToast('Copied site_manifest.json to clipboard.');
    } catch {
      logEvent('Clipboard copy blocked—use Export JSON instead.', 'warn');
      showToast('Copy blocked—click Export JSON instead.', 'error');
    }
    ta.remove();
  }

  async function applySiteManifest(manifest: any): Promise<void> {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid manifest JSON structure.');
    }

    logEvent(`Applying site manifest "${manifest.title || manifest.siteId || 'Untitled'}"...`, 'info');

    if (manifest.title) {
      const titleInput = el<HTMLInputElement>('input-site-title');
      if (titleInput) titleInput.value = String(manifest.title);
    }
    if (manifest.geodesy?.sourceCRS) {
      const crsInput = el<HTMLInputElement>('input-source-crs');
      if (crsInput) crsInput.value = String(manifest.geodesy.sourceCRS);
    }

    if (manifest.layers && typeof manifest.layers.defaultSSE === 'number') {
      currentSSE = manifest.layers.defaultSSE;
      const sliderSSE = el<HTMLInputElement>('slider-sse');
      const valSSE = el<HTMLSpanElement>('val-sse');
      if (sliderSSE) sliderSSE.value = String(currentSSE);
      if (valSSE) valSSE.textContent = `${currentSSE} px`;
    }

    if (manifest.geodesy && typeof manifest.geodesy.verticalOffsetMeters === 'number') {
      currentHeightOffset = manifest.geodesy.verticalOffsetMeters;
      const sliderH = el<HTMLInputElement>('slider-height-offset');
      const valH = el<HTMLSpanElement>('val-height-offset');
      if (sliderH) sliderH.value = String(currentHeightOffset);
      if (valH) valH.textContent = `${currentHeightOffset >= 0 ? '+' : ''}${currentHeightOffset.toFixed(1)} m`;
    }

    if (manifest.layers && ionConnected) {
      if (typeof manifest.layers.worldTerrain === 'boolean' && manifest.layers.worldTerrain !== worldTerrainEnabled) {
        await toggleWorldTerrain();
      }
      if (typeof manifest.layers.google3DTiles === 'boolean' && manifest.layers.google3DTiles !== google3DEnabled) {
        await toggleGoogle3DTiles();
      }
    }

    const clipId =
      manifest.layers?.clippingGeoJsonAssetId ||
      (Array.isArray(manifest.tilesets)
        ? manifest.tilesets.find((t: any) => t?.clippingGeoJsonAssetId)?.clippingGeoJsonAssetId
        : null) ||
      null;
    if (clipId) {
      const clipInput = el<HTMLInputElement>('input-clip-asset-id');
      if (clipInput) clipInput.value = String(clipId);
      if (ionConnected) {
        await applyClippingGeoJson(clipId);
      }
    }

    if (Array.isArray(manifest.tilesets)) {
      for (const ts of manifest.tilesets) {
        if (ts?.ionAssetId) {
          await loadIonTileset(ts.ionAssetId, ts.name || `Asset #${ts.ionAssetId}`);
        }
      }
    }

    if (Array.isArray(manifest.bookmarks)) {
      cameraBookmarks = manifest.bookmarks.filter(
        (b: any) => b && typeof b.lat === 'number' && typeof b.lon === 'number'
      );
      renderBookmarkList();
    }

    if (cameraBookmarks.length > 0) {
      flyToBookmark(cameraBookmarks[0]);
    } else if (manifest.geodesy?.wgs84Origin) {
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

    logEvent(`Loaded manifest "${manifest.title || manifest.siteId || 'Site'}".`, 'ok');
    showToast(`Loaded manifest: ${manifest.title || manifest.siteId || 'Site'}`);
  }

  async function loadManifestFromUrl(url: string): Promise<void> {
    try {
      logEvent(`Fetching manifest from ${url}...`, 'info');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await applySiteManifest(json);
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
    if (now - lastFpsCheck < 500) return;

    const elapsed = now - lastFpsCheck;
    const fps = (frameCount * 1000) / elapsed;
    smoothedFps = smoothedFps * 0.6 + fps * 0.4;
    frameCount = 0;
    lastFpsCheck = now;

    const fpsEl = el<HTMLDivElement>('metric-fps');
    const altEl = el<HTMLDivElement>('metric-alt');
    const latLonEl = el<HTMLSpanElement>('metric-latlon');
    const hdgPitchEl = el<HTMLSpanElement>('metric-hdg-pitch');

    if (fpsEl) fpsEl.textContent = `${Math.round(smoothedFps)}`;

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

  function setupUI(): void {
    renderTilesetList();
    renderBookmarkList();
    renderClipList();
    setPanelTab(activeTab);

    // WebGL Reload Fallback
    el<HTMLButtonElement>('btn-reload-webgl')?.addEventListener('click', () => {
      window.location.reload();
    });

    // Panel Tabs
    document.querySelectorAll<HTMLButtonElement>('.panel-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.panelTab as PanelTab;
        if (tab) setPanelTab(tab);
      });
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
      btnToggle3DWeather.className = show3DWeatherOverlay
        ? 'text-[11px] font-mono text-sky-300 hover:text-sky-200 transition-colors cursor-pointer'
        : 'text-[11px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer';
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

    const toggleWeatherHud = () => {
      setWeatherHudVisible(!weatherVisible);
    };
    el<HTMLButtonElement>('btn-toggle-weather')?.addEventListener('click', toggleWeatherHud);
    el<HTMLButtonElement>('btn-close-weather')?.addEventListener('click', toggleWeatherHud);

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

    // Video Recording & Snapshot Controls
    el<HTMLButtonElement>('btn-rec-free')?.addEventListener('click', () => {
      if (isRecording) stopRecording();
      else startRecording(flightMode === 'wasd' ? 'WASD Pilot' : 'Free Flight');
    });
    el<HTMLButtonElement>('btn-rec-orbit')?.addEventListener('click', () => {
      startRecord360Lap();
    });
    el<HTMLButtonElement>('btn-snapshot-png')?.addEventListener('click', capturePngSnapshot);
    el<HTMLButtonElement>('btn-quick-record')?.addEventListener('click', () => {
      if (isRecording) stopRecording();
      else startRecording(flightMode === 'orbit' ? '360° Orbit' : 'Aerial Capture');
    });
    el<HTMLButtonElement>('btn-stop-rec-banner')?.addEventListener('click', stopRecording);

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

    // Site Manifest Builder Controls
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
    });

    // Telemetry toggle (Controls toggle is wired synchronously on boot)
    const toggleHealth = () => {
      setHealthPanelVisible(!healthVisible);
    };
    el<HTMLButtonElement>('btn-toggle-health')?.addEventListener('click', toggleHealth);
    el<HTMLButtonElement>('btn-close-health')?.addEventListener('click', toggleHealth);

    // Keyboard Listeners for WASD Pilot & Escape
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isTyping) return;

      if (e.key === 'Escape') {
        if (flightMode !== 'explore') setFlightMode('explore');
        if (measureMode !== 'off') setMeasureMode('off');
        closeTokenModal();
        closeClipModal();
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

  function setControlPanelVisible(visible: boolean): void {
    panelVisible = visible;
    if (controlPanel) {
      controlPanel.classList.toggle('hidden', !visible);
      controlPanel.classList.toggle('flex', visible);
      controlPanel.style.display = visible ? 'flex' : 'none';
      controlPanel.setAttribute('aria-hidden', String(!visible));
    }
    const toggleBtn = el<HTMLButtonElement>('btn-toggle-panel');
    if (toggleBtn) {
      toggleBtn.className = visible
        ? 'px-2.5 sm:px-3 py-2 rounded-xl text-xs font-semibold bg-zinc-700 text-white hover:bg-zinc-600 transition-colors cursor-pointer whitespace-nowrap shrink-0'
        : 'px-2.5 sm:px-3 py-2 rounded-xl text-xs font-medium bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors cursor-pointer whitespace-nowrap shrink-0';
    }
  }

  function setHealthPanelVisible(visible: boolean): void {
    healthVisible = visible;
    if (healthPanel) {
      healthPanel.classList.remove('sm:flex');
      healthPanel.classList.toggle('hidden', !visible);
      healthPanel.classList.toggle('flex', visible);
      healthPanel.setAttribute('aria-hidden', String(!visible));
    }
  }

  function setWeatherHudVisible(visible: boolean): void {
    weatherVisible = visible;
    if (weatherHud) {
      weatherHud.classList.remove('sm:flex');
      weatherHud.classList.toggle('hidden', !visible);
      weatherHud.classList.toggle('flex', visible);
      weatherHud.setAttribute('aria-hidden', String(!visible));
    }
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
          await applySiteManifest(parsed);
          return {
            ok: true,
            title: parsed?.title || parsed?.siteId || 'Site',
            tilesetsLoaded: Array.isArray(parsed?.tilesets) ? parsed.tilesets.length : 0,
            bookmarksLoaded: Array.isArray(parsed?.bookmarks) ? parsed.bookmarks.length : 0,
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
      setControlPanelVisible(false);
    },
  };

  // Wire Controls toggle synchronously so dock clicks work immediately on load
  const handleToggleControlPanel = (e?: Event) => {
    e?.preventDefault();
    e?.stopPropagation();
    const nextVisible = !panelVisible;
    setControlPanelVisible(nextVisible);
    controller.onControlPanelToggle?.(nextVisible);
  };
  el<HTMLButtonElement>('btn-toggle-panel')?.addEventListener('click', handleToggleControlPanel);
  el<HTMLButtonElement>('btn-close-panel')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setControlPanelVisible(false);
    controller.onControlPanelToggle?.(false);
  });

  setControlPanelVisible(false);
  setHealthPanelVisible(healthVisible);
  setWeatherHudVisible(weatherVisible);
  initCesium();
  return controller;
}
