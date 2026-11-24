import type { IncomingMessage, ServerResponse } from 'http';
import {
  generateRoofAudit,
  generateCommercialProposal,
  handleAIChat,
  generateDroneVideoPrompt,
  analyzeDroneFlightClip,
} from './geminiService.ts';
import type { BuildingContext } from './geminiService.ts';
import {
  ALLOWED_WEATHER_LAYERS,
  fetchOpenWeatherTile,
  fetchSiteWeather,
  hasOpenWeatherMapKey,
} from './weatherService.ts';
import type { WeatherTileLayer } from './weatherService.ts';
import {
  COPILOT_FLASH_MODEL,
  COPILOT_LIVE_MODEL,
  getActiveCopilotConfig,
  runCopilotTurn,
  runWebSearch,
} from './copilotService.ts';

interface ReverseGeocodePayload {
  city: string | null;
  region: string | null;
  regionCode: string | null;
  country: string | null;
  countryCode: string | null;
  ocean: string | null;
  source: 'bigdatacloud' | 'nominatim' | 'fallback';
}

const reverseGeocodeCache = new Map<string, { ts: number; payload: ReverseGeocodePayload }>();

function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url || '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }

  // 1. AI Roof Engineering Audit Endpoint
  if (url.startsWith('/api/ai/audit') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ context: BuildingContext }>(req);
      const result = await generateRoofAudit(body?.context || {});
      sendJson(res, 200, { audit: result.text, text: result.text, isLiveAi: result.isLiveAi });
      return true;
    } catch (err: any) {
      console.error('API /api/ai/audit error:', err);
      const fallbackResult = await generateRoofAudit({});
      sendJson(res, 200, { audit: fallbackResult.text, text: fallbackResult.text, isLiveAi: false });
      return true;
    }
  }

  // 2. AI Commercial Scope of Work & Proposal Endpoint
  if (url.startsWith('/api/ai/proposal') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ context: BuildingContext; notes?: string }>(req);
      const result = await generateCommercialProposal(body?.context || {}, body?.notes);
      sendJson(res, 200, { proposal: result.text, text: result.text, isLiveAi: result.isLiveAi });
      return true;
    } catch (err: any) {
      console.error('API /api/ai/proposal error:', err);
      const fallbackResult = await generateCommercialProposal({});
      sendJson(res, 200, { proposal: fallbackResult.text, text: fallbackResult.text, isLiveAi: false });
      return true;
    }
  }

  // 3. AI Interactive Chat Co-Pilot Endpoint
  if (url.startsWith('/api/ai/chat') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        message: string;
        history?: Array<{ role: 'user' | 'model'; text: string }>;
        context: BuildingContext;
      }>(req);

      const message = body?.message || 'Hello';
      const result = await handleAIChat(message, body?.history || [], body?.context || {});
      sendJson(res, 200, { reply: result.text, text: result.text, isLiveAi: result.isLiveAi });
      return true;
    } catch (err: any) {
      console.error('API /api/ai/chat error:', err);
      const fallbackResult = await handleAIChat('Roofing analysis', [], {});
      sendJson(res, 200, { reply: fallbackResult.text, text: fallbackResult.text, isLiveAi: false });
      return true;
    }
  }

  // 4. AI Drone Video Director & Prompts Endpoint
  if (url.startsWith('/api/ai/drone-video-director') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        context: BuildingContext;
        style?: 'cinematic' | 'inspection' | 'sunset' | 'photogrammetry';
        cameraMotion?: string;
      }>(req);
      const result = await generateDroneVideoPrompt(
        body?.context || ({} as BuildingContext),
        body?.style || 'cinematic',
        body?.cameraMotion || '360° Survey Orbit with Google Earth Studio mathematical easing'
      );
      sendJson(res, 200, { script: result.text, text: result.text, isLiveAi: result.isLiveAi });
      return true;
    } catch (err: any) {
      console.error('API /api/ai/drone-video-director error:', err);
      const fallbackResult = await generateDroneVideoPrompt({} as BuildingContext);
      sendJson(res, 200, { script: fallbackResult.text, text: fallbackResult.text, isLiveAi: false });
      return true;
    }
  }

  // 5. AI Drone Flight Clip Forensic Analysis Endpoint
  if (url.startsWith('/api/ai/drone-clip-analysis') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        context: BuildingContext;
        flightStats: {
          durationSeconds: number;
          flightMode: string;
          maxAltitudeFeet: number;
          minAltitudeFeet: number;
          avgSpeedMph: number;
          lapCount: number;
          targetedFacets: number[];
        };
      }>(req);
      const result = await analyzeDroneFlightClip(
        body?.context || ({} as BuildingContext),
        body?.flightStats || {
          durationSeconds: 20,
          flightMode: 'orbit',
          maxAltitudeFeet: 75,
          minAltitudeFeet: 65,
          avgSpeedMph: 15,
          lapCount: 1,
          targetedFacets: [1, 2, 3]
        }
      );
      sendJson(res, 200, { report: result.text, text: result.text, isLiveAi: result.isLiveAi });
      return true;
    } catch (err: any) {
      console.error('API /api/ai/drone-clip-analysis error:', err);
      const fallbackResult = await analyzeDroneFlightClip({} as BuildingContext, {
        durationSeconds: 20,
        flightMode: 'orbit',
        maxAltitudeFeet: 75,
        minAltitudeFeet: 65,
        avgSpeedMph: 15,
        lapCount: 1,
        targetedFacets: []
      });
      sendJson(res, 200, { report: fallbackResult.text, text: fallbackResult.text, isLiveAi: false });
      return true;
    }
  }

  // 6. Global Geocoding & Address Lookup Proxy
  if (url.startsWith('/api/maps/geocode') && (req.method === 'GET' || req.method === 'POST')) {
    try {
      let query = '';
      if (req.method === 'POST') {
        const body = await parseJsonBody<{ query: string }>(req);
        query = body?.query || '';
      } else {
        const u = new URL(url, 'http://localhost');
        query = u.searchParams.get('query') || '';
      }

      // Check if user input is coordinate format e.g. "37.4128, -121.9442"
      const coordMatch = query.match(/^(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)$/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[3]);
        sendJson(res, 200, {
          formattedAddress: `GPS Coordinates (${lat.toFixed(4)}°, ${lng.toFixed(4)}°)`,
          location: { lat, lng },
          name: `Site @ ${lat.toFixed(4)}, ${lng.toFixed(4)}`
        });
        return true;
      }

      // Global landmarks database for instant zero-latency lookup worldwide
      const globalLandmarks: Record<string, { lat: number; lng: number; name: string; address: string }> = {
        'augusta': { lat: 33.5021, lng: -82.0226, name: 'Augusta, Georgia', address: 'Augusta, GA, USA' },
        'redmond': { lat: 47.6423, lng: -122.1369, name: 'Redmond, Washington', address: 'Redmond, WA, USA' },
        'grand canyon': { lat: 36.0544, lng: -112.1401, name: 'Grand Canyon National Park', address: 'Grand Canyon Village, AZ 86023' },
        'apple': { lat: 37.334644, lng: -122.008972, name: 'Apple Park Infinite Loop', address: '1 Apple Park Way, Cupertino, CA 95014' },
        'cupertino': { lat: 37.334644, lng: -122.008972, name: 'Apple Park', address: '1 Apple Park Way, Cupertino, CA 95014' },
        'empire': { lat: 40.748817, lng: -73.985428, name: 'Empire State Building', address: '20 W 34th St., New York, NY 10001' },
        'new york': { lat: 40.748817, lng: -73.985428, name: 'Empire State Building', address: '20 W 34th St., New York, NY 10001' },
        'salesforce': { lat: 37.7897, lng: -122.3972, name: 'Salesforce Tower', address: '415 Mission St, San Francisco, CA 94105' },
        'san francisco': { lat: 37.7897, lng: -122.3972, name: 'Salesforce Tower', address: '415 Mission St, San Francisco, CA 94105' },
        'googleplex': { lat: 37.4220, lng: -122.0841, name: 'Googleplex HQ', address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043' },
        'mountain view': { lat: 37.4220, lng: -122.0841, name: 'Googleplex HQ', address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043' },
        'sydney': { lat: -33.8568, lng: 151.2153, name: 'Sydney Opera House', address: 'Bennelong Point, Sydney NSW 2000, Australia' },
        'tokyo': { lat: 35.6586, lng: 139.7454, name: 'Tokyo Tower', address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo 105-0011, Japan' },
        'paris': { lat: 48.8584, lng: 2.2945, name: 'Eiffel Tower', address: 'Champ de Mars, 5 Av. Anatole France, 75007 Paris, France' },
        'london': { lat: 51.5033, lng: -0.1195, name: 'London Eye & Waterloo', address: 'Riverside Building, County Hall, London SE1 7PB, UK' },
        'chicago': { lat: 41.8789, lng: -87.6359, name: 'Willis Tower', address: '233 S Wacker Dr, Chicago, IL 60606' },
        'austin': { lat: 30.2635, lng: -97.7404, name: 'Austin Convention Center', address: '500 E Cesar Chavez St, Austin, TX 78701' },
        'denver': { lat: 39.739235, lng: -104.990250, name: 'Denver Medical District', address: '850 Medical Plaza Dr, Denver, CO 80204' },
        'columbus': { lat: 39.952583, lng: -83.000650, name: 'Vanguard Hub', address: '4500 Interchange Blvd, Columbus, OH 43228' }
      };

      const qLower = query.toLowerCase();
      for (const [key, val] of Object.entries(globalLandmarks)) {
        if (qLower.includes(key)) {
          sendJson(res, 200, {
            formattedAddress: val.address,
            location: { lat: val.lat, lng: val.lng },
            name: val.name
          });
          return true;
        }
      }

      // Try Google Geocoding API if key available, or fallback to Nominatim OpenStreetMap
      const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
      if (mapsKey) {
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${mapsKey}`;
        const resp = await fetch(geoUrl);
        if (resp.ok) {
          const gData = await resp.json();
          if (gData.results && gData.results[0]) {
            const r = gData.results[0];
            sendJson(res, 200, {
              formattedAddress: r.formatted_address,
              location: r.geometry.location,
              name: r.address_components?.[0]?.long_name || query
            });
            return true;
          }
        }
      }

      // OpenStreetMap Nominatim Fallback for zero-config global coverage
      try {
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
        const nomResp = await fetch(nomUrl, { headers: { 'User-Agent': 'NoDRONE-Survey-Engine/2.4' } });
        if (nomResp.ok) {
          const nomData = await nomResp.json();
          if (nomData && nomData[0]) {
            sendJson(res, 200, {
              formattedAddress: nomData[0].display_name,
              location: { lat: parseFloat(nomData[0].lat), lng: parseFloat(nomData[0].lon) },
              name: nomData[0].name || query
            });
            return true;
          }
        }
      } catch (nomErr) {
        console.warn('Nominatim geocode fallback failed:', nomErr);
      }

      // Generic fallback for custom query
      sendJson(res, 200, {
        formattedAddress: query,
        location: { lat: 37.412850, lng: -121.944200 },
        name: query
      });
      return true;
    } catch (err: any) {
      console.error('API /api/maps/geocode error:', err);
      sendJson(res, 500, { error: err.message });
      return true;
    }
  }

  // 6b. Live Reverse Geocoding (City, State/Region, Country, or Ocean) with LRU cache
  if (url.startsWith('/api/maps/reverse') && req.method === 'GET') {
    try {
      const u = new URL(url, 'http://localhost');
      const lat = Number(u.searchParams.get('lat'));
      const lon = Number(u.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        sendJson(res, 400, { error: 'Valid lat (-90..90) and lon (-180..180) are required.' });
        return true;
      }

      const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      const cached = reverseGeocodeCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 3600_000) {
        sendJson(res, 200, cached.payload);
        return true;
      }

      let payload: ReverseGeocodePayload | null = null;

      // Primary: BigDataCloud free reverse geocode (fast, includes ocean/sea names)
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat.toFixed(5))}&longitude=${encodeURIComponent(lon.toFixed(5))}&localityLanguage=en`;
        const bdcResp = await fetch(bdcUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (bdcResp.ok) {
          const d: any = await bdcResp.json();
          const city = String(d?.city || d?.locality || '').trim();
          const region = String(d?.principalSubdivision || '').trim();
          const isoSub = String(d?.principalSubdivisionCode || '').trim();
          const regionCode = isoSub.includes('-') ? isoSub.split('-').pop() || '' : '';
          const country = String(d?.countryName || '').trim();
          const countryCode = String(d?.countryCode || '').trim();
          const ocean = !country
            ? String(
                d?.localityInfo?.informative?.find((i: any) => i?.description?.toLowerCase().includes('ocean') || i?.description?.toLowerCase().includes('sea'))?.name ||
                  d?.locality ||
                  ''
              ).trim()
            : '';

          if (city || region || country || ocean) {
            payload = {
              city: city || null,
              region: region || null,
              regionCode: regionCode || null,
              country: country || null,
              countryCode: countryCode || null,
              ocean: ocean || null,
              source: 'bigdatacloud',
            };
          }
        }
      } catch {
        // fall through to Nominatim
      }

      // Secondary fallback: OpenStreetMap Nominatim
      if (!payload) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat.toFixed(5))}&lon=${encodeURIComponent(lon.toFixed(5))}&zoom=10`;
          const nomResp = await fetch(nomUrl, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'NoDRONE-Survey-Engine/2.4' },
          });
          clearTimeout(timer);
          if (nomResp.ok) {
            const nd: any = await nomResp.json();
            const addr = nd?.address || {};
            const city = String(addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.county || '').trim();
            const region = String(addr.state || addr.region || '').trim();
            const iso3166 = String(addr['ISO3166-2-lvl4'] || '').trim();
            const regionCode = iso3166.includes('-') ? iso3166.split('-').pop() || '' : '';
            const country = String(addr.country || '').trim();
            const countryCode = String(addr.country_code || '').toUpperCase().trim();
            const hasLand = Boolean(city || region || country);
            payload = {
              city: city || null,
              region: region || null,
              regionCode: regionCode || null,
              country: country || null,
              countryCode: countryCode || null,
              ocean: hasLand ? null : 'Open Ocean',
              source: 'nominatim',
            };
          }
        } catch {
          // ignore
        }
      }

      if (!payload) {
        payload = {
          city: null,
          region: null,
          regionCode: null,
          country: null,
          countryCode: null,
          ocean: 'Open Ocean',
          source: 'fallback',
        };
      }

      if (reverseGeocodeCache.size >= 500) {
        const oldestKey = reverseGeocodeCache.keys().next().value;
        if (oldestKey) reverseGeocodeCache.delete(oldestKey);
      }
      reverseGeocodeCache.set(cacheKey, { ts: Date.now(), payload });
      sendJson(res, 200, payload);
      return true;
    } catch (err: any) {
      console.error('API /api/maps/reverse error:', err);
      sendJson(res, 500, { error: err?.message || 'Reverse geocode failed' });
      return true;
    }
  }

  // 7. Google Aerial View API Proxy (with mandatory solution_id=gmp_git_agentskills_v1)
  if (url.startsWith('/api/maps/aerial-view') && req.method === 'GET') {
    try {
      const u = new URL(url, 'http://localhost');
      const address = u.searchParams.get('address') || '';
      const videoId = u.searchParams.get('videoId') || '';
      const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';

      if (!address && !videoId) {
        sendJson(res, 400, { error: 'Address or videoId required' });
        return true;
      }

      let reqUrl = 'https://aerialview.googleapis.com/v1/videos:lookupVideo?solution_id=gmp_git_agentskills_v1';
      if (key) reqUrl += `&key=${key}`;
      if (address) reqUrl += `&address=${encodeURIComponent(address)}`;
      if (videoId) reqUrl += `&videoId=${encodeURIComponent(videoId)}`;

      try {
        const resp = await fetch(reqUrl);
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, {
            ...data,
            attribution: 'Google Maps' // Mandatory skill attribution
          });
          return true;
        } else {
          const errData = await resp.json().catch(() => ({}));
          sendJson(res, 200, {
            state: 'NOT_FOUND',
            message: errData.error?.message || 'Video not found or 3D imagery not yet rendered for this postal address.',
            attribution: 'Google Maps'
          });
          return true;
        }
      } catch (fErr) {
        sendJson(res, 200, {
          state: 'NOT_FOUND',
          message: 'Aerial View API lookup currently unavailable for this location.',
          attribution: 'Google Maps'
        });
        return true;
      }
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
      return true;
    }
  }

  // 8. Real-Time Site Weather Proxy (OpenWeatherMap API with live Open-Meteo fallback)
  if (url.startsWith('/api/weather/current') && req.method === 'GET') {
    try {
      const u = new URL(url, 'http://localhost');
      const latRaw = u.searchParams.get('lat');
      const lonRaw = u.searchParams.get('lon');
      const lat = latRaw !== null ? Number(latRaw) : NaN;
      const lon = lonRaw !== null ? Number(lonRaw) : NaN;

      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        sendJson(res, 400, { error: 'Valid numeric lat (-90..90) and lon (-180..180) are required.' });
        return true;
      }

      const weather = await fetchSiteWeather(lat, lon);
      sendJson(res, 200, weather);
      return true;
    } catch (err: any) {
      const reason = err?.name === 'AbortError' ? 'upstream request timed out' : (err?.message || 'upstream unavailable');
      console.warn(`Weather proxy temporarily unavailable (${reason}).`);
      sendJson(res, 503, { error: 'Live weather providers temporarily timed out. Please retry.' });
      return true;
    }
  }

  // 9. OpenWeatherMap Global Raster Tile Proxy (keeps OPENWEATHERMAP_API_KEY strictly server-side)
  const tileMatch = url.split('?')[0].match(/^\/api\/weather\/tile\/([a-z_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (tileMatch && req.method === 'GET') {
    const layer = tileMatch[1] as WeatherTileLayer;
    const z = parseInt(tileMatch[2], 10);
    const x = parseInt(tileMatch[3], 10);
    const y = parseInt(tileMatch[4], 10);

    if (!ALLOWED_WEATHER_LAYERS.has(layer)) {
      sendJson(res, 400, { error: 'Unsupported weather tile layer.' });
      return true;
    }

    const maxIndex = Math.pow(2, z) - 1;
    if (z < 0 || z > 18 || x < 0 || y < 0 || x > maxIndex || y > maxIndex) {
      sendJson(res, 400, { error: 'Tile coordinates out of range.' });
      return true;
    }

    const tile = await fetchOpenWeatherTile(layer, z, x, y);
    res.writeHead(200, {
      'Content-Type': tile.contentType,
      'Cache-Control': tile.isPlaceholder ? 'no-store' : 'public, max-age=300',
      'X-Weather-Tile-Source': tile.isPlaceholder ? 'placeholder' : 'openweathermap',
    });
    res.end(tile.buffer);
    return true;
  }

  // 10. NoDRONE Co-Pilot Function-Calling Turn Proxy (keeps GEMINI_API_KEY strictly server-side)
  if (url.startsWith('/api/copilot/turn') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        contents?: any[];
        context?: Record<string, unknown> | null;
      }>(req);

      if (!Array.isArray(body?.contents) || body.contents.length === 0) {
        sendJson(res, 400, { error: 'Valid conversation contents array is required.' });
        return true;
      }

      const result = await runCopilotTurn(body.contents, body?.context ?? null);
      sendJson(res, 200, result);
      return true;
    } catch (err: any) {
      const status = typeof err?.statusCode === 'number'
        ? err.statusCode
        : typeof err?.status === 'number'
          ? err.status
          : 500;
      const rawMessage = String(err?.message || 'Co-Pilot request failed.');
      let cleanMessage = rawMessage;
      try {
        const parsed = JSON.parse(rawMessage);
        if (parsed?.error?.message) {
          cleanMessage = String(parsed.error.message);
        }
      } catch {
        // not JSON
      }
      if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED') || rawMessage.includes('429')) {
        cleanMessage =
          'Rate limit reached on the active Co-Pilot API key. Wait a few seconds and retry, or add NOUS_API_KEY / ANTHROPIC_API_KEY in Settings > Secrets.';
      } else if (status === 401 || status === 403 || rawMessage.includes('PERMISSION_DENIED') || rawMessage.includes('API_KEY_INVALID')) {
        const providerLabel = err?.provider ? `${String(err.provider).toUpperCase()} ` : '';
        cleanMessage =
          `${providerLabel}API key is invalid or missing permissions. Check your key in Settings > Secrets.`;
      }
      console.error('API /api/copilot/turn error:', cleanMessage);
      sendJson(res, status >= 400 && status < 600 ? status : 500, { error: cleanMessage });
      return true;
    }
  }

  // 10b. NoDRONE Co-Pilot Live Web Search & Grounded Research Endpoint
  if (url.startsWith('/api/copilot/search') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ query?: string }>(req);
      const query = String(body?.query || '').trim();
      if (!query) {
        sendJson(res, 400, { ok: false, error: 'Search query is required.' });
        return true;
      }
      const result = await runWebSearch(query);
      sendJson(res, result.ok ? 200 : 502, result);
      return true;
    } catch (err: any) {
      console.error('API /api/copilot/search error:', err?.message || err);
      sendJson(res, 500, { ok: false, error: err?.message || 'Web search failed.' });
      return true;
    }
  }

  // 11. Health / Status Endpoint
  if (url.startsWith('/api/ai/status') && req.method === 'GET') {
    const cfg = getActiveCopilotConfig();
    sendJson(res, 200, {
      status: 'online',
      provider: cfg.primaryProvider,
      configuredProviders: cfg.providers,
      model: cfg.primaryModel,
      copilotFlashModel: COPILOT_FLASH_MODEL,
      copilotLiveModel: COPILOT_LIVE_MODEL,
      hasApiKey: cfg.providers.length > 0,
      hasWeatherKey: hasOpenWeatherMapKey(),
      engine: `NoDRONE Co-Pilot (${cfg.primaryProvider || 'unconfigured'}: ${cfg.primaryModel} / Live: ${COPILOT_LIVE_MODEL})`,
    });
    return true;
  }

  return false;
}
