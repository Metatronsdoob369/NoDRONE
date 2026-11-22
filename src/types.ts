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

export interface SiteManifest {
  schemaVersion: string;
  siteId: string;
  title: string;
  exportedAt: string;
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
  tilesets: Array<{
    name: string;
    ionAssetId: number;
    type: string;
    visible: boolean;
    clippingGeoJsonAssetId: number | null;
  }>;
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
}


