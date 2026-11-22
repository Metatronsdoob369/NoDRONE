import {
  Content,
  FunctionDeclaration,
  ThinkingLevel,
  Type,
} from '@google/genai';
import { getGeminiClient } from './geminiService.js';

export const COPILOT_FLASH_MODEL = 'gemini-4-hydrogen';
export const COPILOT_LIVE_MODEL = 'gemini-3.8-live';

export const COPILOT_SYSTEM_INSTRUCTION =
  'You are the NoDRONE Co-Pilot. You operate the viewer directly with your tools. When Joe asks for something, do it with a tool call, then confirm in one short sentence. Heights are metres above the WGS84 ellipsoid. Angles in degrees. Never invent asset IDs; ask if unknown. Before recording, check getWeather and mention any wind advisory. Site manifest keys: schemaVersion, siteId, title, exportedAt, geodesy{sourceCRS, convertedBy, wgs84Origin{lat,lon,ellipsoidalHeight}, verticalOffsetMeters}, layers{worldTerrain, google3DTiles, defaultSSE, clippingGeoJsonAssetId}, tilesets[{name, ionAssetId, type, visible, clippingGeoJsonAssetId}], bookmarks[{name,lat,lon,alt,heading,pitch,roll}]. In voice, keep replies to 1-2 sentences and never read JSON aloud.';

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
      'Build and download the shared UE5 + Web site_manifest.json (schemaVersion 1.0) and return its JSON object.',
  },
  {
    name: 'loadManifest',
    description: 'Load and apply a site_manifest.json (schemaVersion 1.0) into the viewer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        json: {
          type: Type.STRING,
          description: 'Valid JSON string conforming to the NoDRONE site_manifest.json schema.',
        },
      },
      required: ['json'],
    },
  },
];

export function buildSystemInstructionWithContext(context?: Record<string, unknown> | null): string {
  if (!context || typeof context !== 'object') {
    return COPILOT_SYSTEM_INSTRUCTION;
  }
  return `${COPILOT_SYSTEM_INSTRUCTION}\n\nLIVE VIEWER CONTEXT (JSON):\n${JSON.stringify(context)}`;
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
}

export async function runCopilotTurn(
  contents: Content[],
  context?: Record<string, unknown> | null
): Promise<CopilotTurnResult> {
  const client = getGeminiClient();
  if (!client) {
    const err = new Error(
      'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets to use Co-Pilot.'
    );
    (err as any).statusCode = 503;
    throw err;
  }

  if (!Array.isArray(contents) || contents.length === 0) {
    const err = new Error('Conversation contents array is required.');
    (err as any).statusCode = 400;
    throw err;
  }

  const maxAttempts = 3;
  let lastErr: any = null;
  let response: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await client.models.generateContent({
        model: COPILOT_FLASH_MODEL,
        contents,
        config: {
          systemInstruction: buildSystemInstructionWithContext(context),
          tools: [{ functionDeclarations: COPILOT_TOOL_DECLARATIONS }],
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      break;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || '');
      const status = err?.status ?? err?.statusCode ?? 0;
      const isTransient =
        status === 503 ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('overloaded');
      if (isTransient && attempt < maxAttempts) {
        const delayMs = 600 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }

  if (!response) {
    throw lastErr || new Error('Co-Pilot model returned no response.');
  }

  const modelContent = response.candidates?.[0]?.content ?? null;
  const rawCalls = response.functionCalls ?? [];
  const functionCalls = rawCalls
    .filter((fc): fc is NonNullable<typeof fc> & { name: string } => Boolean(fc?.name))
    .map((fc) => ({
      id: fc.id,
      name: fc.name,
      args: (fc.args && typeof fc.args === 'object' ? fc.args : {}) as Record<string, unknown>,
    }));

  return {
    text: (response.text ?? '').trim(),
    functionCalls,
    modelContent,
    model: COPILOT_FLASH_MODEL,
  };
}
