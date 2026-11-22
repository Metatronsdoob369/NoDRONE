export type WeatherTileLayer =
  | 'clouds_new'
  | 'wind_new'
  | 'precipitation_new'
  | 'temp_new'
  | 'pressure_new';

export const ALLOWED_WEATHER_LAYERS = new Set<WeatherTileLayer>([
  'clouds_new',
  'wind_new',
  'precipitation_new',
  'temp_new',
  'pressure_new',
]);

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

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const MAX_CACHE_ENTRIES = 200;
const UPSTREAM_TIMEOUT_MS = 10_000;

interface CacheEntry {
  data: SiteWeatherData;
  fetchedAt: number;
}

const weatherCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<SiteWeatherData>>();

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

function degreesToCardinal(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return COMPASS_POINTS[idx] || 'N';
}

function evaluateFlightAdvisory(
  windSpeedMps: number,
  windGustMps: number | null,
  visibilityMeters: number | null
): { advisory: 'favorable' | 'caution' | 'high-wind'; label: string } {
  const effectiveWindMps = Math.max(windSpeedMps, (windGustMps ?? 0) * 0.85);
  const lowVis = visibilityMeters !== null && visibilityMeters < 4800; // < 3 statute miles FAA Part 107

  if (effectiveWindMps >= 11.2 || lowVis) {
    return {
      advisory: 'high-wind',
      label: lowVis ? 'Low Visibility' : 'High Wind Advisory',
    };
  }
  if (effectiveWindMps >= 8.0) {
    return {
      advisory: 'caution',
      label: 'Moderate Wind Caution',
    };
  }
  return {
    advisory: 'favorable',
    label: 'Favorable Flight',
  };
}

function wmoCodeToCondition(code: number): { condition: string; description: string } {
  if (code === 0) return { condition: 'Clear', description: 'clear sky' };
  if (code === 1) return { condition: 'Clear', description: 'mainly clear' };
  if (code === 2) return { condition: 'Clouds', description: 'partly cloudy' };
  if (code === 3) return { condition: 'Clouds', description: 'overcast clouds' };
  if (code === 45 || code === 48) return { condition: 'Fog', description: 'fog / mist' };
  if (code >= 51 && code <= 57) return { condition: 'Drizzle', description: 'light drizzle' };
  if (code >= 61 && code <= 67) return { condition: 'Rain', description: 'rain showers' };
  if (code >= 71 && code <= 77) return { condition: 'Snow', description: 'snowfall' };
  if (code >= 80 && code <= 82) return { condition: 'Rain', description: 'passing showers' };
  if (code >= 95) return { condition: 'Thunderstorm', description: 'thunderstorm activity' };
  return { condition: 'Clouds', description: 'variable sky' };
}

function metNoSymbolToCondition(symbol: string): { condition: string; description: string } {
  const s = (symbol || '').toLowerCase();
  if (s.includes('thunder')) return { condition: 'Thunderstorm', description: 'thunderstorm activity' };
  if (s.includes('snow') || s.includes('sleet')) return { condition: 'Snow', description: 'snowfall' };
  if (s.includes('rain') || s.includes('shower')) return { condition: 'Rain', description: 'rain showers' };
  if (s.includes('fog')) return { condition: 'Fog', description: 'fog / mist' };
  if (s.includes('clearsky')) return { condition: 'Clear', description: 'clear sky' };
  if (s.includes('fair') || s.includes('partlycloudy')) return { condition: 'Clouds', description: 'partly cloudy' };
  return { condition: 'Clouds', description: 'cloudy sky' };
}

export function hasOpenWeatherMapKey(): boolean {
  return Boolean(process.env.OPENWEATHERMAP_API_KEY?.trim());
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromOpenWeatherMap(
  lat: number,
  lon: number,
  apiKey: string
): Promise<SiteWeatherData> {
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lon', lon.toFixed(5));
  url.searchParams.set('units', 'metric');
  url.searchParams.set('appid', apiKey);

  const data = await fetchJsonWithTimeout(url.toString());
  const windSpeedMps = Number(data?.wind?.speed ?? 0);
  const windGustMps = typeof data?.wind?.gust === 'number' ? Number(data.wind.gust) : null;
  const windDeg = Number(data?.wind?.deg ?? 0);
  const visibilityMeters = typeof data?.visibility === 'number' ? Number(data.visibility) : null;
  const adv = evaluateFlightAdvisory(windSpeedMps, windGustMps, visibilityMeters);

  return {
    source: 'openweathermap',
    owmTilesAvailable: true,
    lat,
    lon,
    stationName: String(data?.name || `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`),
    country: String(data?.sys?.country || ''),
    condition: String(data?.weather?.[0]?.main || 'Clear'),
    description: String(data?.weather?.[0]?.description || 'clear sky'),
    tempC: Number(data?.main?.temp ?? 0),
    feelsLikeC: Number(data?.main?.feels_like ?? data?.main?.temp ?? 0),
    windSpeedMps,
    windGustMps,
    windDeg,
    windCardinal: degreesToCardinal(windDeg),
    cloudCoverPct: Number(data?.clouds?.all ?? 0),
    humidityPct: Number(data?.main?.humidity ?? 0),
    pressureHpa: Number(data?.main?.pressure ?? 1013),
    visibilityMeters,
    flightAdvisory: adv.advisory,
    flightAdvisoryLabel: adv.label,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchFromOpenMeteo(
  lat: number,
  lon: number,
  owmTilesAvailable: boolean
): Promise<SiteWeatherData> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(5));
  url.searchParams.set('longitude', lon.toFixed(5));
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code'
  );
  url.searchParams.set('wind_speed_unit', 'ms');

  const data = await fetchJsonWithTimeout(url.toString());
  const cur = data?.current || {};
  const windSpeedMps = Number(cur.wind_speed_10m ?? 0);
  const windGustMps = typeof cur.wind_gusts_10m === 'number' ? Number(cur.wind_gusts_10m) : null;
  const windDeg = Number(cur.wind_direction_10m ?? 0);
  const wmo = wmoCodeToCondition(Number(cur.weather_code ?? 0));
  const adv = evaluateFlightAdvisory(windSpeedMps, windGustMps, 10000);

  return {
    source: 'open-meteo',
    owmTilesAvailable,
    lat,
    lon,
    stationName: `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`,
    country: '',
    condition: wmo.condition,
    description: wmo.description,
    tempC: Number(cur.temperature_2m ?? 0),
    feelsLikeC: Number(cur.apparent_temperature ?? cur.temperature_2m ?? 0),
    windSpeedMps,
    windGustMps,
    windDeg,
    windCardinal: degreesToCardinal(windDeg),
    cloudCoverPct: Number(cur.cloud_cover ?? 0),
    humidityPct: Number(cur.relative_humidity_2m ?? 0),
    pressureHpa: Math.round(Number(cur.surface_pressure ?? 1013)),
    visibilityMeters: 10000,
    flightAdvisory: adv.advisory,
    flightAdvisoryLabel: adv.label,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchFromMetNo(
  lat: number,
  lon: number,
  owmTilesAvailable: boolean
): Promise<SiteWeatherData> {
  const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
  url.searchParams.set('lat', lat.toFixed(4));
  url.searchParams.set('lon', lon.toFixed(4));

  const data = await fetchJsonWithTimeout(url.toString(), {
    'User-Agent': 'NoDRONE-Geospatial/1.0 (https://nodrone.app)',
  });

  const first = data?.properties?.timeseries?.[0];
  const details = first?.data?.instant?.details || {};
  const symbolCode =
    first?.data?.next_1_hours?.summary?.symbol_code ||
    first?.data?.next_6_hours?.summary?.symbol_code ||
    'cloudy';

  const windSpeedMps = Number(details.wind_speed ?? 0);
  const windDeg = Number(details.wind_from_direction ?? 0);
  const tempC = Number(details.air_temperature ?? 0);
  const cond = metNoSymbolToCondition(symbolCode);
  const adv = evaluateFlightAdvisory(windSpeedMps, null, 10000);

  return {
    source: 'open-meteo',
    owmTilesAvailable,
    lat,
    lon,
    stationName: `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`,
    country: '',
    condition: cond.condition,
    description: cond.description,
    tempC,
    feelsLikeC: tempC,
    windSpeedMps,
    windGustMps: null,
    windDeg,
    windCardinal: degreesToCardinal(windDeg),
    cloudCoverPct: Number(details.cloud_area_fraction ?? 0),
    humidityPct: Number(details.relative_humidity ?? 0),
    pressureHpa: Math.round(Number(details.air_pressure_at_sea_level ?? 1013)),
    visibilityMeters: 10000,
    flightAdvisory: adv.advisory,
    flightAdvisoryLabel: adv.label,
    updatedAt: new Date().toISOString(),
  };
}

function storeInCache(cacheKey: string, data: SiteWeatherData): void {
  if (weatherCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = weatherCache.keys().next().value;
    if (oldestKey) weatherCache.delete(oldestKey);
  }
  weatherCache.set(cacheKey, { data, fetchedAt: Date.now() });
}

/**
 * Fetches live site weather conditions for the given WGS84 coordinates with
 * in-memory caching, request deduplication, and multi-provider live fallback
 * (OpenWeatherMap -> Open-Meteo -> MET Norway).
 */
export async function fetchSiteWeather(lat: number, lon: number): Promise<SiteWeatherData> {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const existingFlight = inFlightRequests.get(cacheKey);
  if (existingFlight) {
    return existingFlight;
  }

  const task = (async (): Promise<SiteWeatherData> => {
    const apiKey = process.env.OPENWEATHERMAP_API_KEY?.trim() || '';
    const owmTilesAvailable = Boolean(apiKey);

    if (apiKey) {
      try {
        const result = await fetchFromOpenWeatherMap(lat, lon, apiKey);
        storeInCache(cacheKey, result);
        return result;
      } catch {
        // Fall through cleanly to secondary live global providers
      }
    }

    try {
      const result = await fetchFromOpenMeteo(lat, lon, owmTilesAvailable);
      storeInCache(cacheKey, result);
      return result;
    } catch {
      // Fall through cleanly to MET Norway live global telemetry
    }

    try {
      const result = await fetchFromMetNo(lat, lon, owmTilesAvailable);
      storeInCache(cacheKey, result);
      return result;
    } catch (metErr) {
      // If we have a slightly stale cached value for this location, serve it rather than failing
      if (cached) {
        return cached.data;
      }
      throw metErr;
    }
  })();

  inFlightRequests.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

// 1x1 transparent PNG fallback when OWM tile key is not configured
const TRANSPARENT_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

/**
 * Proxies an OpenWeatherMap raster map tile server-side so the API key never reaches the browser.
 */
export async function fetchOpenWeatherTile(
  layer: WeatherTileLayer,
  z: number,
  x: number,
  y: number
): Promise<{ buffer: Buffer; contentType: string; isPlaceholder: boolean }> {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY?.trim();
  if (!apiKey) {
    return {
      buffer: TRANSPARENT_PNG_1X1,
      contentType: 'image/png',
      isPlaceholder: true,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const tileUrl = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(tileUrl, { signal: controller.signal });
    if (!resp.ok) {
      return {
        buffer: TRANSPARENT_PNG_1X1,
        contentType: 'image/png',
        isPlaceholder: true,
      };
    }
    const arrayBuffer = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || 'image/png',
      isPlaceholder: false,
    };
  } catch {
    return {
      buffer: TRANSPARENT_PNG_1X1,
      contentType: 'image/png',
      isPlaceholder: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}
