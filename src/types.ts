declare global {
  interface Window {
    Cesium: any;
  }
}

export type LogLevel = 'ok' | 'info' | 'warn' | 'error';
export type HealthState = 'ok' | 'warn' | 'critical';
export type FlightMode = 'explore' | 'wasd' | 'orbit' | 'tour';
export type MeasureMode = 'off' | 'distance' | 'area';
export type PanelTab = 'map' | 'flight' | 'manifest';
export type ActiveCard = 'world' | 'flight' | 'capture' | 'box' | 'site' | 'weather' | 'telemetry' | null;
export type HudMode = 'rail' | 'summon' | 'zen';

export interface UiControlEntry {
  id: string;
  label: string;
  card: string;
  active?: boolean;
  value?: string;
  disabled?: boolean;
}

export interface UiStateSnapshot {
  hudMode: HudMode;
  activeCard: ActiveCard;
  copilotOpen: boolean;
  visibleControls: UiControlEntry[];
}

export interface TilesetEntry {
  id: number;
  name: string;
  tileset: any;
  visible: boolean;
}

export interface CameraBookmark {
  name: string;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  pitch: number;
  roll: number;
}

export type SurveyStatus = 'planned' | 'captured' | 'processed';

export interface SurveyTilesetRef {
  name: string;
  ionAssetId: number;
  type: '3dtiles' | '3dgs' | 'mesh' | 'imagery' | string;
  visible: boolean;
  clippingGeoJsonAssetId: number | null;
}

export interface SurveySplatAnchor {
  lat: number;
  lon: number;
  baseHeightMeters: number;
}

export interface SurveySplatRef {
  name?: string;
  ionAssetId?: number | null;
  url?: string | null;
  format?: string;
  anchor?: SurveySplatAnchor | null;
  headingDeg?: number;
  scale?: number;
  offsetMeters?: number;
  splatCount?: number | null;
  lastError?: string | null;
}

export interface SurveyAssetBundle {
  imagery: {
    provider: string;
    ionAssetId?: number | null;
    capturedAt?: string | null;
    url?: string | null;
  } | null;
  mesh: SurveyTilesetRef | null;
  splat: SurveySplatRef | null;
  tilesets: SurveyTilesetRef[];
  clippingGeoJsonAssetId: number | null;
  bundleProvenanceSha256?: string | null;
}

export interface SurveyPathRef {
  pathId: string;
  name: string;
  format: 'nodrone-camera-path/1' | 'ges-tracking' | 'camera-matrices' | 'splatthat-bundle';
  url?: string | null;
  sampleCount?: number;
  smoothMode?: 'linear' | 'catmull-rom';
}

export interface SurveyRecord {
  surveyId: string;
  capturedAt: string;
  label: string;
  status: SurveyStatus;
  notes?: string;
  verticalOffsetMeters?: number;
  assets: SurveyAssetBundle;
  bookmarks: CameraBookmark[];
  paths: SurveyPathRef[];
  provenance: {
    quotable: false;
    provenanceTag: 'observed_guide_internal';
    createdAt: string;
    updatedAt: string;
  };
}

export interface SurveyCompareHook {
  baselineSurveyId: string | null;
  targetSurveyId: string | null;
  mode: 'off' | 'split' | 'swipe';
}

export interface SiteManifest {
  schemaVersion: string;
  siteId: string;
  title: string;
  exportedAt: string;
  activeSurveyId: string;
  compareSurveyId: string | null;
  comparisonHook: SurveyCompareHook;
  geodesy: {
    sourceCRS: string;
    convertedBy: string;
    wgs84Origin: {
      lat: number;
      lon: number;
      ellipsoidalHeight: number;
    };
    verticalOffsetMeters: number;
  };
  layers: {
    worldTerrain: boolean;
    google3DTiles: boolean;
    defaultSSE: number;
    clippingGeoJsonAssetId: number | null;
  };
  surveys: SurveyRecord[];
  /** Legacy v1.0 mirrors of the active survey for backwards compatibility */
  tilesets: SurveyTilesetRef[];
  bookmarks: CameraBookmark[];
}

export interface RecordedClip {
  id: string;
  name: string;
  url: string;
  blob: Blob;
  durationSec: number;
  mode: string;
  createdAt: string;
  sizeMb: string;
  cameraPath?: {
    url: string;
    name: string;
  };
}

export type WeatherTileLayer =
  | 'off'
  | 'clouds_new'
  | 'wind_new'
  | 'precipitation_new'
  | 'temp_new';

export type WeatherUnitSystem = 'imperial' | 'metric';

export interface SiteWeatherData {
  source: 'openweathermap' | 'open-meteo';
  owmTilesAvailable: boolean;
  lat: number;
  lon: number;
  stationName: string;
  country: string;
  condition: string;
  description: string;
  tempC: number;
  feelsLikeC: number;
  windSpeedMps: number;
  windGustMps: number | null;
  windDeg: number;
  windCardinal: string;
  cloudCoverPct: number;
  humidityPct: number;
  pressureHpa: number;
  visibilityMeters: number | null;
  flightAdvisory: 'favorable' | 'caution' | 'high-wind';
  flightAdvisoryLabel: string;
  updatedAt: string;
}

export interface CameraState {
  lat: number;
  lon: number;
  ellipsoidalHeight: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface GeoDrawBoxSnapshot {
  name: string;
  south: number;
  north: number;
  west: number;
  east: number;
  centerLat: number;
  centerLon: number;
  baseEllipsoidalMeters: number;
  baseOffsetMeters: number;
  heightMeters: number;
  ceilingEllipsoidalMeters: number;
  widthMeters: number;
  depthMeters: number;
  areaSqMeters: number;
  captureViews: number;
  visible: boolean;
}

export interface CopilotContextSnapshot {
  camera: CameraState | null;
  loadedTilesets: Array<{
    assetId: number;
    name: string;
    visible: boolean;
  }>;
  activeLayers: {
    worldTerrain: boolean;
    google3DTiles: boolean;
    ionConnected: boolean;
    sse: number;
    verticalOffsetMeters: number;
    weatherLayer: WeatherTileLayer;
    show3DWeather: boolean;
  };
  flightMode: FlightMode;
  isRecording: boolean;
  lensMm: number;
  airspeedMps: number;
  bookmarkCount: number;
  weatherAdvisory: {
    stationName: string;
    advisory: string;
    advisoryLabel: string;
    windSpeedMps: number;
    windCardinal: string;
    tempC: number;
    cloudCoverPct: number;
    updatedAt: string;
  } | null;
  geoBox?: GeoDrawBoxSnapshot | null;
  surveyCatalog?: {
    activeSurveyId: string;
    compareSurveyId: string | null;
    surveyCount: number;
    surveys: Array<{
      surveyId: string;
      capturedAt: string;
      label: string;
      status: SurveyStatus;
      tilesetCount: number;
      bookmarkCount: number;
      hasSplat: boolean;
    }>;
  };
  uiState?: UiStateSnapshot;
}

export interface WebSearchSource {
  title: string;
  uri: string;
}

export interface CopilotToolResult {
  ok: boolean;
  [key: string]: unknown;
}

export interface NoDroneController {
  getContextSnapshot: () => CopilotContextSnapshot;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<CopilotToolResult>;
  hideControlPanel: () => void;
  onControlPanelToggle?: (visible: boolean) => void;
  onUiStateChange?: (snapshot: CopilotContextSnapshot) => void;
  isCopilotDrawerVisible?: () => boolean;
  setCopilotDrawerVisible?: (visible: boolean) => void;
}


