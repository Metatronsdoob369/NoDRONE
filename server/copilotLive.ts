import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import {
  COPILOT_LIVE_MODEL,
  COPILOT_TOOL_DECLARATIONS,
  buildSystemInstructionWithContext,
} from './copilotService.js';

let liveAiClient: GoogleGenAI | null = null;

function getLiveGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) return null;
  if (!liveAiClient) {
    liveAiClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return liveAiClient;
}

interface ClientLiveMessage {
  type: 'init' | 'audio' | 'text' | 'toolResponse' | 'close';
  context?: Record<string, unknown> | null;
  data?: string;
  text?: string;
  functionResponses?: Array<{
    id?: string;
    name: string;
    response: Record<string, unknown>;
  }>;
}

const attachedServers = new WeakSet<HttpServer>();

function safeSend(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function attachCopilotLiveWebSocket(httpServer: HttpServer | null | undefined): void {
  if (!httpServer || attachedServers.has(httpServer)) return;
  attachedServers.add(httpServer);

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/api/copilot/live') {
      return;
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wss.emit('connection', clientWs, req);
    });
  });

  wss.on('connection', (clientWs: WebSocket) => {
    const client = getLiveGeminiClient();
    if (!client) {
      safeSend(clientWs, {
        type: 'error',
        error: 'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
      });
      clientWs.close(1011, 'Missing GEMINI_API_KEY');
      return;
    }

    let liveSession: any = null;
    let sessionPromise: Promise<any> | null = null;
    let closed = false;

    const startLiveSession = (initialContext?: Record<string, unknown> | null) => {
      if (sessionPromise || closed) return;

      sessionPromise = client.live
        .connect({
          model: COPILOT_LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Zephyr' },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ functionDeclarations: COPILOT_TOOL_DECLARATIONS }],
            systemInstruction: buildSystemInstructionWithContext(initialContext),
          },
          callbacks: {
            onopen: () => {
              safeSend(clientWs, { type: 'ready', model: COPILOT_LIVE_MODEL });
            },
            onmessage: (message: LiveServerMessage) => {
              if (closed) return;

              const serverContent = message.serverContent;
              if (serverContent?.modelTurn?.parts) {
                for (const part of serverContent.modelTurn.parts) {
                  if (part.inlineData?.data) {
                    safeSend(clientWs, {
                      type: 'audio',
                      data: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                    });
                  }
                }
              }

              if (serverContent?.inputTranscription?.text) {
                safeSend(clientWs, {
                  type: 'inputTranscript',
                  text: serverContent.inputTranscription.text,
                });
              }

              if (serverContent?.outputTranscription?.text) {
                safeSend(clientWs, {
                  type: 'outputTranscript',
                  text: serverContent.outputTranscription.text,
                });
              }

              if (serverContent?.interrupted) {
                safeSend(clientWs, { type: 'interrupted' });
              }

              if (serverContent?.turnComplete) {
                safeSend(clientWs, { type: 'turnComplete' });
              }

              const calls = message.toolCall?.functionCalls;
              if (calls && calls.length > 0) {
                safeSend(clientWs, {
                  type: 'toolCall',
                  functionCalls: calls
                    .filter((fc) => Boolean(fc?.name))
                    .map((fc) => ({
                      id: fc.id,
                      name: fc.name!,
                      args: (fc.args && typeof fc.args === 'object' ? fc.args : {}) as Record<
                        string,
                        unknown
                      >,
                    })),
                });
              }
            },
            onerror: (err: any) => {
              console.warn('Gemini Live session error:', err?.message || err);
              safeSend(clientWs, {
                type: 'error',
                error: err?.message || 'Gemini Live voice session encountered an error.',
              });
            },
            onclose: (ev: any) => {
              if (!closed) {
                safeSend(clientWs, {
                  type: 'closed',
                  reason: ev?.reason || 'Live session closed',
                });
              }
            },
          },
        })
        .then((session) => {
          if (closed) {
            try {
              session.close();
            } catch {
              // ignore
            }
            return null;
          }
          liveSession = session;
          return session;
        })
        .catch((err: any) => {
          console.error('Failed to connect Gemini Live session:', err);
          safeSend(clientWs, {
            type: 'error',
            error: err?.message || 'Could not start Gemini Live voice session.',
          });
          clientWs.close(1011, 'Live connect failed');
          return null;
        });
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // ignore
        }
        liveSession = null;
      } else if (sessionPromise) {
        sessionPromise.then((s) => {
          if (s) {
            try {
              s.close();
            } catch {
              // ignore
            }
          }
        });
      }
    };

    clientWs.on('message', (raw) => {
      let msg: ClientLiveMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'init') {
        startLiveSession(msg.context ?? null);
        return;
      }

      if (msg.type === 'close') {
        cleanup();
        clientWs.close(1000, 'Client closed session');
        return;
      }

      if (!sessionPromise) {
        startLiveSession(msg.context ?? null);
      }

      sessionPromise?.then((session) => {
        if (!session || closed) return;
        try {
          if (msg.type === 'audio' && typeof msg.data === 'string' && msg.data.length > 0) {
            session.sendRealtimeInput({
              audio: {
                data: msg.data,
                mimeType: 'audio/pcm;rate=16000',
              },
            });
          } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
            const payload = msg.context
              ? `${msg.text.trim()}\n[LIVE VIEWER CONTEXT: ${JSON.stringify(msg.context)}]`
              : msg.text.trim();
            session.sendRealtimeInput({ text: payload });
          } else if (msg.type === 'toolResponse' && Array.isArray(msg.functionResponses)) {
            const enriched = msg.functionResponses.map((fr) => ({
              id: fr.id,
              name: fr.name,
              response: msg.context
                ? { ...fr.response, _viewerContext: msg.context }
                : fr.response,
            }));
            session.sendToolResponse({ functionResponses: enriched });
          }
        } catch (err: any) {
          console.warn('Gemini Live send error:', err?.message || err);
        }
      });
    });

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);
  });
}
