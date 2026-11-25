import { ThinkingLevel, Type } from '@google/genai';
import type { Content, FunctionDeclaration } from '@google/genai';
import { getGeminiClient } from './geminiService.ts';

export const COPILOT_FLASH_MODEL = 'gemini-4-hydrogen';
export const COPILOT_LIVE_MODEL = 'gemini-3.8-live';

export const COPILOT_SYSTEM_INSTRUCTION =
  'You are the NoDRONE Co-Pilot. You operate the viewer directly with your tools, can guide Joe visually across the chronograph HUD, and can perform live web research using webSearch (or Google Search grounding) for real-time facts, FAA/airspace regulations, site history, landmarks, coordinates, specs, or current events. Whenever Joe asks to move, drop closer, zoom in, pan, inspect a location, or change a setting, ALWAYS call the appropriate viewer tool (such as flyTo or searchAddress) rather than only replying in text, and NEVER return an empty response. LIVE VIEWER CONTEXT includes uiState (activeCard, hudMode, visibleControls) and surveyCatalog (activeSurveyId, compareSurveyId, surveys). When Joe asks how to do something, where a button is, or asks to open a panel, use openPanel and highlightControl (with exact controlId from visibleControls or known IDs) to spotlight it in gold in real time. When Joe asks to research something or look up current facts, call webSearch and give a crisp, accurate summary (sources appear automatically as links). When Joe asks to perform a viewer action, execute the tool directly and confirm in one short sentence. Heights are metres above the WGS84 ellipsoid. Angles in degrees. Never invent asset IDs; ask if unknown. Before recording, check getWeather and mention any wind advisory. Site manifest schemaVersion 2.0 supports dated surveys[] (surveyId, capturedAt, label, status, assets, bookmarks, paths) plus geodesy and layers. In voice, keep replies to 1-2 sentences and never read JSON or URLs aloud.';

export const COPILOT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'flyTo',
    description:
      'Fly the Cesium camera to WGS84 coordinates (lat, lon, ellipsoidal height in metres) and/or change orientation (heading, pitch, roll in degrees). Omit lat, lon, or height to keep the current camera position and height—when Joe asks to tilt/pitch/pan/turn without mentioning altitude, omit height so the current height is preserved.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: {
          type: Type.NUMBER,
          description: 'Optional WGS84 latitude in decimal degrees (-90 to 90). Omit to keep current latitude.',
        },
        lon: {
          type: Type.NUMBER,
          description: 'Optional WGS84 longitude in decimal degrees (-180 to 180). Omit to keep current longitude.',
        },
        height: {
          type: Type.NUMBER,
          description: 'Optional height in metres above the WGS84 ellipsoid. Omit unless Joe asks to change altitude/height.',
        },
        heading: {
          type: Type.NUMBER,
          description: 'Optional camera heading in degrees (0 = North, 90 = East). Omit to keep current heading.',
        },
        pitch: {
          type: Type.NUMBER,
          description: 'Optional camera pitch in degrees (-90 = straight down, -30 = 30 degrees below horizon, 0 = level). Omit to keep current pitch.',
        },
        roll: {
          type: Type.NUMBER,
          description: 'Optional camera roll in degrees (default preserves current roll).',
        },
      },
    },
  },
  {
    name: 'searchAddress',
    description:
      'Geocode a city, address, or landmark query and fly the camera there automatically.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'City, street address, or landmark name (e.g. "Augusta, Georgia").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'loadIonAsset',
    description:
      'Load a 3D Tiles or 3DGS SplatMap tileset from Cesium ion by numeric Asset ID and fly to it. Never invent asset IDs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        assetId: {
          type: Type.INTEGER,
          description: 'Numeric Cesium ion Asset ID (e.g. 4547222 for the 110M-Splat Campus demo).',
        },
        name: {
          type: Type.STRING,
          description: 'Optional display label for the tileset.',
        },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'setTilesetVisible',
    description: 'Show or hide an already-loaded Cesium ion tileset by its Asset ID.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        assetId: {
          type: Type.INTEGER,
          description: 'Numeric Cesium ion Asset ID of the loaded tileset.',
        },
        visible: {
          type: Type.BOOLEAN,
          description: 'True to show the tileset, false to hide it.',
        },
      },
      required: ['assetId', 'visible'],
    },
  },
  {
    name: 'removeTileset',
    description: 'Remove an already-loaded Cesium ion tileset from the scene by its Asset ID.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        assetId: {
          type: Type.INTEGER,
          description: 'Numeric Cesium ion Asset ID of the loaded tileset to remove.',
        },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'setLayer',
    description: 'Turn Cesium World Terrain or Google Photorealistic 3D Tiles on or off.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        layer: {
          type: Type.STRING,
          enum: ['worldTerrain', 'google3DTiles'],
          description: 'Base world layer to toggle: "worldTerrain" or "google3DTiles".',
        },
        on: {
          type: Type.BOOLEAN,
          description: 'True to enable the layer, false to disable it.',
        },
      },
      required: ['layer', 'on'],
    },
  },
  {
    name: 'setSSE',
    description:
      'Set the 3D Tiles / 3DGS LOD maximum Screen Space Error (1 to 32 px; lower is sharper, higher is faster).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        value: {
          type: Type.NUMBER,
          description: 'Screen Space Error in pixels from 1 to 32.',
        },
      },
      required: ['value'],
    },
  },
  {
    name: 'setHeightNudge',
    description:
      'Set the Geotrans ellipsoidal height nudge in metres (-60 to +60 m) applied to loaded custom tilesets to fix floating or sinking.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        meters: {
          type: Type.NUMBER,
          description: 'Vertical ellipsoidal height offset in metres.',
        },
      },
      required: ['meters'],
    },
  },
  {
    name: 'setFlightMode',
    description: 'Switch the virtual drone flight mode.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          enum: ['explore', 'wasd', 'orbit', 'tour'],
          description: 'Flight mode: "explore", "wasd", "orbit", or "tour".',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'setAirspeed',
    description: 'Set the WASD virtual drone pilot airspeed in metres per second (5 to 150 m/s).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mps: {
          type: Type.NUMBER,
          description: 'Airspeed in metres per second (5 to 150).',
        },
      },
      required: ['mps'],
    },
  },
  {
    name: 'setLens',
    description: 'Set the 35mm equivalent camera lens focal length preset (18, 24, 35, or 50 mm).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mm: {
          type: Type.INTEGER,
          description: 'Lens focal length in mm: 18, 24, 35, or 50.',
        },
      },
      required: ['mm'],
    },
  },
  {
    name: 'startRecording',
    description:
      'Start recording a WebM aerial video clip of the viewport. Always call getWeather first to check wind advisory.',
  },
  {
    name: 'stopRecording',
    description: 'Stop the active WebM aerial video recording and open the clip playback modal.',
  },
  {
    name: 'record360Lap',
    description:
      'Start a 360-degree survey orbit around the current target and record a one-lap WebM clip that stops automatically after 360 degrees. Always call getWeather first to check wind advisory.',
  },
  {
    name: 'takeSnapshot',
    description: 'Capture and download a high-resolution PNG snapshot of the current 3D viewport.',
  },
  {
    name: 'addBookmark',
    description: 'Save the current WGS84 camera pose as a named bookmark.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'Name for the saved camera bookmark (e.g. "Hero Shot").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'listBookmarks',
    description: 'Return all saved WGS84 camera bookmarks in the current session.',
  },
  {
    name: 'flyToBookmark',
    description: 'Fly the camera to a previously saved bookmark by name.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'Name of the saved bookmark to fly to.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'measure',
    description: 'Activate the 3D surface distance or area measurement tool on the globe/tileset.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          enum: ['distance', 'area'],
          description: 'Measurement mode: "distance" or "area".',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'getWeather',
    description:
      'Fetch live site weather telemetry and drone flight wind advisory for the current camera target position.',
  },
  {
    name: 'getCameraState',
    description:
      'Return the current WGS84 camera latitude, longitude, ellipsoidal height (m), heading, pitch, and roll (deg).',
  },
  {
    name: 'exportManifest',
    description:
      'Build and download the shared UE5 + Web site_manifest.json (schemaVersion 2.0 with Survey Catalog) and return its JSON object.',
  },
  {
    name: 'loadManifest',
    description: 'Load and apply a site_manifest.json (schemaVersion 1.0 or 2.0) into the viewer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        json: {
          type: Type.STRING,
          description: 'Valid JSON string conforming to the NoDRONE site_manifest.json schema.',
        },
        surveyId: {
          type: Type.STRING,
          description: 'Optional surveyId or YYYY-MM-DD date to activate immediately.',
        },
        compareSurveyId: {
          type: Type.STRING,
          description: 'Optional surveyId to arm as Before/After comparison target.',
        },
      },
      required: ['json'],
    },
  },
  {
    name: 'selectSurvey',
    description: 'Switch the active dated survey epoch in the Survey Catalog and optionally arm a Before/After comparison survey.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        surveyId: {
          type: Type.STRING,
          description: 'Target surveyId or YYYY-MM-DD capture date from surveyCatalog.surveys.',
        },
        compareSurveyId: {
          type: Type.STRING,
          description: 'Optional surveyId to arm as Before/After comparison target (pass empty string to clear).',
        },
      },
      required: ['surveyId'],
    },
  },
  {
    name: 'createSurvey',
    description: 'Create a new dated survey epoch in the Survey Catalog.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        capturedAt: {
          type: Type.STRING,
          description: 'Capture date in YYYY-MM-DD format.',
        },
        label: {
          type: Type.STRING,
          description: 'Short label for the epoch (e.g. "Post-Storm", "Q4 Baseline").',
        },
        status: {
          type: Type.STRING,
          enum: ['planned', 'captured', 'processed'],
          description: 'Workflow status for this survey epoch.',
        },
        splat: {
          type: Type.STRING,
          description: 'Optional Cesium ion Asset ID or .ply/.spz URL for the splat.',
        },
      },
    },
  },
  {
    name: 'openPanel',
    description:
      'Open, switch, fan out, or tuck the bottom chronograph command card so Joe can see the relevant buttons while Co-Pilot stays open.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        panel: {
          type: Type.STRING,
          enum: ['world', 'flight', 'capture', 'box', 'site', 'weather', 'telemetry', 'summon', 'none'],
          description:
            'Card to display above the bottom command rail ("world", "flight", "capture", "box", "site", "weather", "telemetry"), "summon" for the overview cluster, or "none" to tuck all cards.',
        },
      },
      required: ['panel'],
    },
  },
  {
    name: 'highlightControl',
    description:
      'Spotlight a specific button or control on screen with a champagne-gold pulse halo and optional short callout note. Automatically opens its parent card if needed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        controlId: {
          type: Type.STRING,
          description:
            'Exact DOM ID of the button/control (e.g. "btn-load-redmond", "btn-toggle-google3d", "btn-rec-orbit", "btn-load-render-path", "btn-render-frames", "btn-box-draw", "btn-box-capture-bundle", "btn-export-manifest", "btn-measure-distance", "btn-weather-refresh", "btn-open-token", "btn-cluster-units").',
        },
        note: {
          type: Type.STRING,
          description: 'Optional 2-5 word guidance tag displayed next to the spotlighted button.',
        },
      },
      required: ['controlId'],
    },
  },
  {
    name: 'setGeoBox',
    description:
      'Create or update a 3D Geo-Coordinate Draw Box bounding volume on the globe for 3D mesh/splat asset capture and Splat Studio bundle export. Can specify exact south/north/west/east bounds OR centerLat/centerLon with widthMeters/depthMeters.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'Optional asset name for the draw box (e.g. "Stadium Mesh").',
        },
        centerLat: {
          type: Type.NUMBER,
          description: 'Center latitude in decimal degrees (optional if south/north given or defaults to current view).',
        },
        centerLon: {
          type: Type.NUMBER,
          description: 'Center longitude in decimal degrees (optional if west/east given or defaults to current view).',
        },
        widthMeters: {
          type: Type.NUMBER,
          description: 'East-west box width in meters (default 100).',
        },
        depthMeters: {
          type: Type.NUMBER,
          description: 'North-south box depth in meters (default 100).',
        },
        south: { type: Type.NUMBER, description: 'Optional exact southern latitude bound in degrees.' },
        north: { type: Type.NUMBER, description: 'Optional exact northern latitude bound in degrees.' },
        west: { type: Type.NUMBER, description: 'Optional exact western longitude bound in degrees.' },
        east: { type: Type.NUMBER, description: 'Optional exact eastern longitude bound in degrees.' },
        heightMeters: {
          type: Type.NUMBER,
          description: 'Vertical ceiling height of the box in meters above base (10 to 500, default 60).',
        },
        baseOffsetMeters: {
          type: Type.NUMBER,
          description: 'Vertical offset of the box base in meters relative to ground/surface (-50 to 250, default 0).',
        },
        frame: {
          type: Type.BOOLEAN,
          description: 'If true, smoothly fly the camera to frame the new 3D draw box.',
        },
      },
    },
  },
  {
    name: 'clearGeoBox',
    description: 'Remove the active 3D Geo-Coordinate Draw Box from the viewport.',
  },
  {
    name: 'webSearch',
    description:
      'Search the live web for real-time research: site facts, FAA Part 107 / drone airspace rules, landmark coordinates, photogrammetry/3DGS tools, local news, or general questions. Returns a grounded summary and clickable web source links.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Focused web search query to research.',
        },
      },
      required: ['query'],
    },
  },
];

export function buildSystemInstructionWithContext(context?: Record<string, unknown> | null): string {
  if (!context || typeof context !== 'object') {
    return COPILOT_SYSTEM_INSTRUCTION;
  }
  return `${COPILOT_SYSTEM_INSTRUCTION}\n\nLIVE VIEWER CONTEXT (JSON):\n${JSON.stringify(context)}`;
}

export type CopilotProviderId = 'nous' | 'anthropic' | 'gemini';

export const DEFAULT_NOUS_BASE_URL = 'https://inference-api.nousresearch.com/v1';
export const DEFAULT_NOUS_MODEL = 'google/gemini-4-hydrogen';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
export const GEMINI_FALLBACK_FLASH_MODEL = 'gemini-3.1-flash-lite';

export interface WebSearchSource {
  title: string;
  uri: string;
}

export interface WebSearchResult {
  ok: boolean;
  query: string;
  summary: string;
  sources: WebSearchSource[];
  engine: string;
  error?: string;
}

export interface CopilotTurnResult {
  text: string;
  functionCalls: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  modelContent: Content | null;
  model: string;
  provider?: CopilotProviderId;
  sources?: WebSearchSource[];
}

function extractGroundingSources(response: any): WebSearchSource[] {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const chunk of chunks) {
    const uri = typeof chunk?.web?.uri === 'string' ? chunk.web.uri.trim() : '';
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const title =
      typeof chunk?.web?.title === 'string' && chunk.web.title.trim()
        ? chunk.web.title.trim()
        : uri.replace(/^https?:\/\//i, '').split('/')[0] || 'Source';
    sources.push({ title, uri });
    if (sources.length >= 6) break;
  }
  return sources;
}

export async function runWebSearch(rawQuery: string): Promise<WebSearchResult> {
  const query = String(rawQuery || '').trim();
  if (!query) {
    return {
      ok: false,
      query: '',
      summary: '',
      sources: [],
      engine: 'none',
      error: 'Search query is required.',
    };
  }

  // Primary: Gemini Live Google Search Grounding (server-side @google/genai)
  const client = getGeminiClient();
  if (client) {
    const modelsToTry = [COPILOT_FLASH_MODEL, GEMINI_FALLBACK_FLASH_MODEL];
    for (const modelName of modelsToTry) {
      try {
        const config: Record<string, unknown> = {
          systemInstruction:
            'You are a concise live web research engine for an aerial 3D geospatial pilot. Answer factually using Google Search results in 2-4 concise sentences with specific numbers, dates, or coordinates when relevant.',
          tools: [{ googleSearch: {} }],
        };
        if (modelName === COPILOT_FLASH_MODEL) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }
        const response = await client.models.generateContent({
          model: modelName,
          contents: query,
          config,
        });
        const summary = (response.text ?? '').trim();
        const sources = extractGroundingSources(response);
        if (summary || sources.length > 0) {
          return {
            ok: true,
            query,
            summary: summary || 'Retrieved grounded web sources.',
            sources,
            engine: `google-search:${modelName}`,
          };
        }
      } catch (err: any) {
        const msg = String(err?.message || '');
        console.warn(`Gemini Google Search grounding error (${modelName}):`, msg);
        if (modelName !== GEMINI_FALLBACK_FLASH_MODEL) {
          continue;
        }
        break;
      }
    }
  }

  // Fallback: Live Wikipedia OpenSearch + DuckDuckGo Instant Answer API (zero-key web lookup)
  const sources: WebSearchSource[] = [];
  const snippets: string[] = [];
  const decodeEntities = (str: string) =>
    str
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&utf8=&format=json`;
    const wikiRes = await fetch(wikiUrl, {
      headers: { 'User-Agent': 'NoDRONE-CoPilot-Research/1.0' },
      signal: AbortSignal.timeout(5500),
    });
    if (wikiRes.ok) {
      const wData: any = await wikiRes.json();
      const hits = Array.isArray(wData?.query?.search) ? wData.query.search : [];
      for (const hit of hits) {
        const title = String(hit.title || '').trim();
        const cleanSnippet = decodeEntities(String(hit.snippet || ''));
        if (title) {
          sources.push({
            title: `${title} — Wikipedia`,
            uri: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
          });
          if (cleanSnippet) snippets.push(`${title}: ${cleanSnippet}`);
        }
      }
    }
  } catch {
    // ignore wikipedia fallback error
  }

  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { 'User-Agent': 'NoDRONE-CoPilot-Research/1.0' },
      signal: AbortSignal.timeout(4500),
    });
    if (ddgRes.ok) {
      const dData: any = await ddgRes.json();
      if (typeof dData?.AbstractText === 'string' && dData.AbstractText.trim()) {
        snippets.unshift(dData.AbstractText.trim());
        if (typeof dData?.AbstractURL === 'string' && dData.AbstractURL.trim()) {
          sources.unshift({
            title: String(dData.Heading || dData.AbstractSource || 'Web Reference'),
            uri: dData.AbstractURL.trim(),
          });
        }
      }
    }
  } catch {
    // ignore ddg fallback error
  }

  if (snippets.length > 0 || sources.length > 0) {
    return {
      ok: true,
      query,
      summary: snippets.slice(0, 3).join(' · '),
      sources: sources.slice(0, 5),
      engine: 'web-fallback',
    };
  }

  return {
    ok: false,
    query,
    summary: '',
    sources: [],
    engine: 'none',
    error: 'Live web search returned no results. Ensure GEMINI_API_KEY is active for full Google Search grounding.',
  };
}

function mapGeminiTypeToJsonSchema(typeVal: unknown): string {
  const s = String(typeVal || 'object').toLowerCase();
  if (s === 'integer') return 'integer';
  if (s === 'number') return 'number';
  if (s === 'boolean') return 'boolean';
  if (s === 'array') return 'array';
  if (s === 'string') return 'string';
  return 'object';
}

function convertSchemaToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const out: Record<string, unknown> = {
    type: mapGeminiTypeToJsonSchema(schema.type),
  };
  if (typeof schema.description === 'string') {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      props[key] = convertSchemaToJsonSchema(val);
    }
    out.properties = props;
  } else if (out.type === 'object') {
    out.properties = {};
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = schema.required;
  }
  if (schema.items) {
    out.items = convertSchemaToJsonSchema(schema.items);
  }
  return out;
}

const AUTH_BILLING_COOLDOWN_MS = 10 * 60 * 1000;
const providerCooldowns = new Map<CopilotProviderId, { keySig: string; untilMs: number }>();

function sanitizeApiKey(raw?: string | null): string {
  if (!raw) return '';
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(v)) {
    v = v.replace(/^bearer\s+/i, '').trim();
  }
  return v;
}

function getProviderKeySignature(provider: CopilotProviderId): string {
  const raw =
    provider === 'nous'
      ? sanitizeApiKey(process.env.NOUS_API_KEY)
      : provider === 'anthropic'
        ? sanitizeApiKey(process.env.ANTHROPIC_API_KEY)
        : sanitizeApiKey(process.env.GEMINI_API_KEY || process.env.API_KEY);
  if (!raw) return '';
  return `${raw.length}:${raw.slice(0, 6)}:${raw.slice(-4)}`;
}

function isProviderInCooldown(provider: CopilotProviderId): boolean {
  const entry = providerCooldowns.get(provider);
  if (!entry) return false;
  const currentSig = getProviderKeySignature(provider);
  if (!currentSig || entry.keySig !== currentSig || Date.now() >= entry.untilMs) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

function isAuthOrBillingFailure(err: any): boolean {
  const status = Number(err?.statusCode ?? err?.status ?? 0);
  if (status === 401 || status === 402 || status === 403) return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('invalid') ||
    msg.includes('blocked') ||
    msg.includes('out of funds') ||
    msg.includes('credit balance') ||
    msg.includes('insufficient') ||
    msg.includes('authentication') ||
    msg.includes('permission_denied')
  );
}

function safeModelName(raw: string | undefined, fallback: string): string {
  const v = (raw || '').trim();
  if (!v || /^(sk-|key-|bearer\s)/i.test(v)) {
    return fallback;
  }
  return v;
}

export function getActiveCopilotConfig(): {
  providers: CopilotProviderId[];
  primaryProvider: CopilotProviderId | null;
  primaryModel: string;
} {
  const hasNous = Boolean(sanitizeApiKey(process.env.NOUS_API_KEY));
  const hasAnthropic = Boolean(sanitizeApiKey(process.env.ANTHROPIC_API_KEY));
  const hasGemini = Boolean(sanitizeApiKey(process.env.GEMINI_API_KEY || process.env.API_KEY));

  const preferred = (process.env.COPILOT_PROVIDER || 'auto').trim().toLowerCase();
  const configured: CopilotProviderId[] = [];
  const pushIfAvailable = (p: CopilotProviderId) => {
    if (configured.includes(p)) return;
    if (p === 'anthropic' && hasAnthropic) configured.push('anthropic');
    if (p === 'nous' && hasNous) configured.push('nous');
    if (p === 'gemini' && hasGemini) configured.push('gemini');
  };

  if (preferred === 'nous' || preferred === 'anthropic' || preferred === 'gemini') {
    pushIfAvailable(preferred);
  }
  pushIfAvailable('nous');
  pushIfAvailable('anthropic');
  pushIfAvailable('gemini');

  // Move any provider whose current key recently failed auth/billing to the end (or skip if healthy ones exist)
  const healthy = configured.filter((p) => !isProviderInCooldown(p));
  const ordered = healthy.length > 0 ? healthy : configured;

  const primaryProvider = ordered[0] ?? null;
  const primaryModel =
    primaryProvider === 'nous'
      ? safeModelName(process.env.NOUS_MODEL, DEFAULT_NOUS_MODEL)
      : primaryProvider === 'anthropic'
        ? safeModelName(process.env.ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_MODEL)
        : COPILOT_FLASH_MODEL;

  return { providers: ordered, primaryProvider, primaryModel };
}

function normalizeHistoryForOpenAI(contents: Content[], systemPrompt: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  let synthIdCounter = 1;
  const pendingCallIdsByName = new Map<string, string[]>();

  for (const turn of contents) {
    const role = turn?.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(turn?.parts) ? (turn.parts as Array<Record<string, any>>) : [];

    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<{ id: string; name: string; content: string }> = [];

    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        textParts.push(part.text);
      } else if (part?.functionCall && typeof part.functionCall === 'object') {
        const name = String(part.functionCall.name || '');
        const id = String(part.functionCall.id || `call_${synthIdCounter++}`);
        const args = part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {};
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        });
        const queue = pendingCallIdsByName.get(name) || [];
        queue.push(id);
        pendingCallIdsByName.set(name, queue);
      } else if (part?.functionResponse && typeof part.functionResponse === 'object') {
        const name = String(part.functionResponse.name || '');
        const queue = pendingCallIdsByName.get(name);
        const id = String(
          part.functionResponse.id ||
            (queue && queue.length > 0 ? queue.shift() : `call_${synthIdCounter++}`)
        );
        const resp = part.functionResponse.response ?? {};
        toolResults.push({
          id,
          name,
          content: typeof resp === 'string' ? resp : JSON.stringify(resp),
        });
      }
    }

    if (role === 'assistant') {
      if (toolCalls.length > 0 || textParts.length > 0) {
        const msg: Record<string, unknown> = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('\n') : null,
        };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        messages.push(msg);
      }
    } else {
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          name: tr.name,
          content: tr.content,
        });
      }
      if (textParts.length > 0) {
        messages.push({
          role: 'user',
          content: textParts.join('\n'),
        });
      }
    }
  }

  return messages;
}

async function runNousTurn(
  contents: Content[],
  context?: Record<string, unknown> | null
): Promise<CopilotTurnResult> {
  const apiKey = sanitizeApiKey(process.env.NOUS_API_KEY);
  if (!apiKey) {
    const err = new Error('NOUS_API_KEY is not configured.');
    (err as any).statusCode = 503;
    throw err;
  }

  const baseUrl = (process.env.NOUS_BASE_URL?.trim() || DEFAULT_NOUS_BASE_URL).replace(/\/+$/, '');
  const model = safeModelName(process.env.NOUS_MODEL, DEFAULT_NOUS_MODEL);
  const systemPrompt = buildSystemInstructionWithContext(context);
  const messages = normalizeHistoryForOpenAI(contents, systemPrompt);
  const tools = COPILOT_TOOL_DECLARATIONS.map((decl) => ({
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description || '',
      parameters: convertSchemaToJsonSchema(decl.parameters),
    },
  }));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(25000),
  });

  const rawText = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || rawText || `Nous API HTTP ${res.status}`;
    const err = new Error(`Nous Portal (${model}): ${errMsg}`);
    (err as any).statusCode = res.status;
    (err as any).provider = 'nous';
    throw err;
  }

  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const finishReason = String(choice.finish_reason || '');
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content.trim();
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const functionCalls: CopilotTurnResult['functionCalls'] = [];
  const modelParts: Array<Record<string, unknown>> = [];
  if (text) {
    modelParts.push({ text });
  }

  for (let i = 0; i < rawToolCalls.length; i++) {
    const tc = rawToolCalls[i];
    const name = tc?.function?.name;
    if (!name) continue;
    const id = String(tc.id || `nous_call_${Date.now()}_${i}`);
    let args: Record<string, unknown> = {};
    if (typeof tc.function.arguments === 'string' && tc.function.arguments.trim()) {
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (parsed && typeof parsed === 'object') args = parsed;
      } catch {
        args = {};
      }
    } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
      args = tc.function.arguments;
    }
    functionCalls.push({ id, name, args });
    modelParts.push({ functionCall: { id, name, args } });
  }

  if (!text && functionCalls.length === 0) {
    const err = new Error(
      `Nous Portal (${model}) returned an empty turn (finish_reason=${finishReason || 'unknown'}).`
    );
    (err as any).statusCode = 502;
    (err as any).provider = 'nous';
    throw err;
  }

  return {
    text,
    functionCalls,
    modelContent: modelParts.length > 0 ? ({ role: 'model', parts: modelParts } as Content) : null,
    model,
    provider: 'nous',
  };
}

function normalizeHistoryForAnthropic(contents: Content[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let synthIdCounter = 1;
  const pendingCallIdsByName = new Map<string, string[]>();

  for (const turn of contents) {
    const role = turn?.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(turn?.parts) ? (turn.parts as Array<Record<string, any>>) : [];
    const blocks: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        blocks.push({ type: 'text', text: part.text });
      } else if (part?.functionCall && typeof part.functionCall === 'object') {
        const name = String(part.functionCall.name || '');
        const id = String(part.functionCall.id || `toolu_${synthIdCounter++}`);
        const input =
          part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {};
        blocks.push({ type: 'tool_use', id, name, input });
        const queue = pendingCallIdsByName.get(name) || [];
        queue.push(id);
        pendingCallIdsByName.set(name, queue);
      } else if (part?.functionResponse && typeof part.functionResponse === 'object') {
        const name = String(part.functionResponse.name || '');
        const queue = pendingCallIdsByName.get(name);
        const toolUseId = String(
          part.functionResponse.id ||
            (queue && queue.length > 0 ? queue.shift() : `toolu_${synthIdCounter++}`)
        );
        const resp = part.functionResponse.response ?? {};
        blocks.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: typeof resp === 'string' ? resp : JSON.stringify(resp),
        });
      }
    }

    if (blocks.length === 0) continue;

    // Merge consecutive messages of the same role as required by Anthropic API
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role && Array.isArray(prev.content)) {
      (prev.content as Array<Record<string, unknown>>).push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  return messages;
}

async function runAnthropicTurn(
  contents: Content[],
  context?: Record<string, unknown> | null
): Promise<CopilotTurnResult> {
  const apiKey = sanitizeApiKey(process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not configured.');
    (err as any).statusCode = 503;
    throw err;
  }

  const model = safeModelName(process.env.ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_MODEL);
  const systemPrompt = buildSystemInstructionWithContext(context);
  const messages = normalizeHistoryForAnthropic(contents);
  const tools = COPILOT_TOOL_DECLARATIONS.map((decl) => ({
    name: decl.name,
    description: decl.description || '',
    input_schema: convertSchemaToJsonSchema(decl.parameters),
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    }),
    signal: AbortSignal.timeout(25000),
  });

  const rawText = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || rawText || `Anthropic API HTTP ${res.status}`;
    const err = new Error(`Anthropic (${model}): ${errMsg}`);
    (err as any).statusCode = res.status;
    (err as any).provider = 'anthropic';
    throw err;
  }

  const contentBlocks = Array.isArray(data?.content) ? data.content : [];
  const textParts: string[] = [];
  const functionCalls: CopilotTurnResult['functionCalls'] = [];
  const modelParts: Array<Record<string, unknown>> = [];

  for (const block of contentBlocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textParts.push(block.text.trim());
      modelParts.push({ text: block.text.trim() });
    } else if (block?.type === 'tool_use' && block.name) {
      const id = String(block.id || `toolu_${Date.now()}`);
      const args = block.input && typeof block.input === 'object' ? block.input : {};
      functionCalls.push({ id, name: String(block.name), args });
      modelParts.push({ functionCall: { id, name: String(block.name), args } });
    }
  }

  const finalText = textParts.join('\n').trim();
  if (!finalText && functionCalls.length === 0) {
    const err = new Error(
      `Anthropic (${model}) returned an empty turn (stop_reason=${String(data?.stop_reason || 'unknown')}).`
    );
    (err as any).statusCode = 502;
    (err as any).provider = 'anthropic';
    throw err;
  }

  return {
    text: finalText,
    functionCalls,
    modelContent: modelParts.length > 0 ? ({ role: 'model', parts: modelParts } as Content) : null,
    model,
    provider: 'anthropic',
  };
}

async function runGeminiTurn(
  contents: Content[],
  context?: Record<string, unknown> | null
): Promise<CopilotTurnResult> {
  const client = getGeminiClient();
  if (!client) {
    const err = new Error(
      'No Co-Pilot API key is configured. Add NOUS_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in Settings > Secrets.'
    );
    (err as any).statusCode = 503;
    throw err;
  }

  const modelsToTry = [COPILOT_FLASH_MODEL, GEMINI_FALLBACK_FLASH_MODEL];
  let lastErr: any = null;

  for (const modelName of modelsToTry) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Attempt 1 on primary Flash uses function declarations + Google Search;
        // Attempt 2 drops Google Search grounding to avoid MALFORMED_FUNCTION_CALL / empty-part collisions
        const useCombinedSearch = modelName === COPILOT_FLASH_MODEL && attempt === 1;
        const config: Record<string, unknown> = {
          systemInstruction: buildSystemInstructionWithContext(context),
          tools: useCombinedSearch
            ? [{ googleSearch: {} }, { functionDeclarations: COPILOT_TOOL_DECLARATIONS }]
            : [{ functionDeclarations: COPILOT_TOOL_DECLARATIONS }],
        };
        if (modelName === COPILOT_FLASH_MODEL) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
          if (useCombinedSearch) {
            config.toolConfig = { includeServerSideToolInvocations: true };
          }
        }
        const response = await client.models.generateContent({
          model: modelName,
          contents,
          config,
        });

        const candidate = response.candidates?.[0];
        const finishReason = String(candidate?.finishReason || '');
        const modelContent = candidate?.content ?? null;
        const rawCalls = response.functionCalls ?? [];
        const functionCalls = rawCalls
          .filter((fc): fc is NonNullable<typeof fc> & { name: string } => Boolean(fc?.name))
          .map((fc) => ({
            id: fc.id,
            name: fc.name,
            args: (fc.args && typeof fc.args === 'object' ? fc.args : {}) as Record<string, unknown>,
          }));
        const sources = extractGroundingSources(response);

        let text = (response.text ?? '').trim();
        if (!text && Array.isArray(modelContent?.parts)) {
          text = modelContent.parts
            .filter((p: any) => !p?.thought && typeof p?.text === 'string' && p.text.trim())
            .map((p: any) => String(p.text).trim())
            .join('\n')
            .trim();
        }

        if (!text && functionCalls.length === 0) {
          console.warn(
            `Gemini (${modelName}, attempt ${attempt}) returned empty turn (finishReason=${finishReason || 'unknown'}).`
          );
          if (attempt < maxAttempts) {
            continue;
          }
          if (modelName !== GEMINI_FALLBACK_FLASH_MODEL) {
            lastErr = new Error(
              `Gemini (${modelName}) returned an empty response (${finishReason || 'empty'}).`
            );
            break;
          }
          const emptyErr = new Error(
            `Co-Pilot returned an empty response (${finishReason || 'no content'}). Please rephrase or retry.`
          );
          (emptyErr as any).statusCode = 502;
          (emptyErr as any).provider = 'gemini';
          throw emptyErr;
        }

        return {
          text,
          functionCalls,
          modelContent,
          model: modelName,
          provider: 'gemini',
          ...(sources.length > 0 ? { sources } : {}),
        };
      } catch (err: any) {
        lastErr = err;
        (lastErr as any).provider = 'gemini';
        const msg = String(err?.message || '');
        const status = err?.status ?? err?.statusCode ?? 0;
        const isTransient =
          status === 503 ||
          msg.includes('503') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('overloaded');
        const isQuota = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');

        if (isTransient && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
          continue;
        }
        if ((isQuota || status === 502) && modelName !== GEMINI_FALLBACK_FLASH_MODEL) {
          break;
        }
        throw err;
      }
    }
  }

  throw lastErr || new Error('Gemini Co-Pilot returned no response.');
}

export async function runCopilotTurn(
  contents: Content[],
  context?: Record<string, unknown> | null
): Promise<CopilotTurnResult> {
  if (!Array.isArray(contents) || contents.length === 0) {
    const err = new Error('Conversation contents array is required.');
    (err as any).statusCode = 400;
    throw err;
  }

  const { providers } = getActiveCopilotConfig();
  if (providers.length === 0) {
    const err = new Error(
      'No Co-Pilot API key configured on the server. Add NOUS_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in Settings > Secrets.'
    );
    (err as any).statusCode = 503;
    throw err;
  }

  let lastErr: any = null;
  for (const provider of providers) {
    try {
      let result: CopilotTurnResult;
      if (provider === 'anthropic') result = await runAnthropicTurn(contents, context);
      else if (provider === 'nous') result = await runNousTurn(contents, context);
      else result = await runGeminiTurn(contents, context);
      providerCooldowns.delete(provider);
      return result;
    } catch (err: any) {
      lastErr = err;
      if (isAuthOrBillingFailure(err)) {
        providerCooldowns.set(provider, {
          keySig: getProviderKeySignature(provider),
          untilMs: Date.now() + AUTH_BILLING_COOLDOWN_MS,
        });
      }
    }
  }

  throw lastErr || new Error('Co-Pilot request failed.');
}
