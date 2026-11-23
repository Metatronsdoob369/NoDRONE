import type { CopilotToolResult, NoDroneController, WebSearchSource } from './types';

interface ConversationContent {
  role: 'user' | 'model';
  parts: Array<Record<string, unknown>>;
}

interface TurnFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface CopilotTurnResponse {
  text: string;
  functionCalls: TurnFunctionCall[];
  modelContent: ConversationContent | null;
  model: string;
  sources?: WebSearchSource[];
  error?: string;
}

const MAX_TOOL_ROUNDS = 6;

function formatToolChipLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'flyTo': {
      const lat = args.lat !== undefined ? Number(args.lat) : NaN;
      const lon = args.lon !== undefined ? Number(args.lon) : NaN;
      const h = args.height !== undefined ? Number(args.height) : NaN;
      const pitch = args.pitch !== undefined ? Number(args.pitch) : NaN;
      const heading = args.heading !== undefined ? Number(args.heading) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const hStr = Number.isFinite(h) ? ` · ${Math.round(h)}m` : '';
        return `flyTo ${lat.toFixed(2)}°, ${lon.toFixed(2)}°${hStr}`;
      }
      const parts: string[] = [];
      if (Number.isFinite(pitch)) parts.push(`pitch ${Math.round(pitch)}°`);
      if (Number.isFinite(heading)) parts.push(`hdg ${Math.round(heading)}°`);
      if (Number.isFinite(h)) parts.push(`${Math.round(h)}m`);
      return parts.length > 0 ? `flyTo ${parts.join(' · ')}` : 'flyTo';
    }
    case 'searchAddress':
      return `flyTo ${String(args.query || '').trim() || 'address'}`;
    case 'loadIonAsset':
      return `loadIonAsset #${args.assetId ?? ''}${args.name ? ` ${args.name}` : ''}`;
    case 'setTilesetVisible':
      return `setTilesetVisible #${args.assetId ?? ''} ${args.visible ? 'show' : 'hide'}`;
    case 'removeTileset':
      return `removeTileset #${args.assetId ?? ''}`;
    case 'setLayer':
      return `setLayer ${args.layer ?? ''} ${args.on ? 'on' : 'off'}`;
    case 'setSSE':
      return `setSSE ${args.value ?? ''}px`;
    case 'setHeightNudge': {
      const m = Number(args.meters);
      return `setHeightNudge ${Number.isFinite(m) ? `${m >= 0 ? '+' : ''}${m}m` : ''}`;
    }
    case 'setFlightMode':
      return `setFlightMode ${args.mode ?? ''}`;
    case 'setAirspeed':
      return `setAirspeed ${args.mps ?? ''} m/s`;
    case 'setLens':
      return `setLens ${args.mm ?? ''}mm`;
    case 'addBookmark':
      return `addBookmark ${String(args.name || '').trim()}`;
    case 'flyToBookmark':
      return `flyToBookmark ${String(args.name || '').trim()}`;
    case 'measure':
      return `measure ${args.mode ?? ''}`;
    case 'openPanel':
      return `panel ${String(args.panel ?? '')}`;
    case 'highlightControl':
      return `spotlight ${String(args.controlId ?? '')}`;
    case 'webSearch': {
      const q = String(args.query ?? '').trim();
      return `search "${q.length > 26 ? `${q.slice(0, 25)}…` : q}"`;
    }
    default:
      return name;
  }
}

function downsampleBuffer(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function float32ToPcm16Base64(float32: Float32Array): string {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

export function initCopilotDrawer(controller: NoDroneController): void {
  const el = <T extends HTMLElement>(id: string): T | null =>
    document.getElementById(id) as T | null;

  const drawer = el<HTMLElement>('copilot-drawer');
  const toggleBtn = el<HTMLButtonElement>('btn-toggle-copilot');
  const closeBtn = el<HTMLButtonElement>('btn-close-copilot');
  const clearBtn = el<HTMLButtonElement>('btn-copilot-clear');
  const dockDot = el<HTMLSpanElement>('dock-copilot-dot');
  const messagesEl = el<HTMLDivElement>('copilot-messages');
  const emptyEl = el<HTMLDivElement>('copilot-empty');
  const form = el<HTMLFormElement>('copilot-form');
  const inputEl = el<HTMLInputElement>('copilot-input');
  const sendBtn = el<HTMLButtonElement>('btn-copilot-send');
  const micBtn = el<HTMLButtonElement>('btn-copilot-mic');
  const voiceBar = el<HTMLDivElement>('copilot-voice-bar');
  const voiceDot = el<HTMLSpanElement>('copilot-voice-dot');
  const voiceStatus = el<HTMLSpanElement>('copilot-voice-status');
  const stopVoiceBtn = el<HTMLButtonElement>('btn-copilot-stop-voice');

  if (!drawer || !messagesEl || !form || !inputEl) return;

  let drawerVisible = false;
  let isBusy = false;
  let history: ConversationContent[] = [];

  // Gemini Live Voice state
  let liveWs: WebSocket | null = null;
  let liveActive = false;
  let micStream: MediaStream | null = null;
  let inputAudioCtx: AudioContext | null = null;
  let outputAudioCtx: AudioContext | null = null;
  let scriptProcessor: ScriptProcessorNode | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let nextPlayTime = 0;
  const activePlaybackSources = new Set<AudioBufferSourceNode>();
  let liveUserBubble: HTMLDivElement | null = null;
  let liveUserText = '';
  let liveModelBubble: HTMLDivElement | null = null;
  let liveModelText = '';
  let liveToolRow: HTMLDivElement | null = null;

  function scrollToBottom(): void {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmptyState(): void {
    if (emptyEl) emptyEl.classList.add('hidden');
  }

  function setDrawerVisible(visible: boolean): void {
    drawerVisible = visible;
    if (drawer) {
      drawer.setAttribute('data-tucked', visible ? 'false' : 'true');
      drawer.setAttribute('aria-hidden', String(!visible));
    }
    document.body.setAttribute('data-copilot-open', String(visible));
    if (visible) {
      window.setTimeout(() => {
        if (drawerVisible) inputEl?.focus();
      }, 60);
    }
    updateDockButtonStyle();
  }

  function updateDockButtonStyle(): void {
    if (!toggleBtn) return;
    toggleBtn.setAttribute('data-active', String(drawerVisible));
  }

  // Enforce clean tucked state on initial load
  setDrawerVisible(false);

  controller.isCopilotDrawerVisible = () => drawerVisible;
  controller.setCopilotDrawerVisible = (visible: boolean) => setDrawerVisible(visible);

  // Push live UI state transitions silently into an active Gemini Live Voice session
  controller.onUiStateChange = (snapshot) => {
    if (liveActive && liveWs && liveWs.readyState === WebSocket.OPEN) {
      try {
        liveWs.send(
          JSON.stringify({
            type: 'uiContext',
            context: snapshot,
          })
        );
      } catch {
        // ignore transient send error
      }
    }
  };

  function appendUserBubble(text: string): HTMLDivElement {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-end';

    const bubble = document.createElement('div');
    bubble.className =
      'max-w-[85%] rounded-xl rounded-br-sm bg-[#d4af63]/16 border border-[#d4af63]/40 px-3 py-2 text-xs text-[#faf0d4] leading-relaxed whitespace-pre-wrap break-words';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl!.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  function createAssistantTurnContainer(): {
    root: HTMLDivElement;
    chipsRow: HTMLDivElement;
    textBubble: HTMLDivElement;
    sourcesRow: HTMLDivElement;
  } {
    hideEmptyState();
    const root = document.createElement('div');
    root.className = 'flex flex-col items-start gap-1.5';

    const chipsRow = document.createElement('div');
    chipsRow.className = 'hidden flex-wrap gap-1.5 max-w-[95%]';

    const textBubble = document.createElement('div');
    textBubble.className =
      'hidden max-w-[90%] rounded-xl rounded-bl-sm bg-black/55 border border-white/10 px-3 py-2 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap break-words';

    const sourcesRow = document.createElement('div');
    sourcesRow.className = 'hidden flex-wrap gap-1 max-w-[95%] pt-0.5';

    root.append(chipsRow, textBubble, sourcesRow);
    messagesEl!.appendChild(root);
    scrollToBottom();
    return { root, chipsRow, textBubble, sourcesRow };
  }

  function appendSourcesToRow(sourcesRow: HTMLDivElement, sources: WebSearchSource[]): void {
    if (!Array.isArray(sources) || sources.length === 0) return;
    const existing = new Set(
      Array.from(sourcesRow.querySelectorAll('a')).map((a) => a.href)
    );
    let added = false;
    for (const src of sources) {
      if (!src?.uri || !/^https?:\/\//i.test(src.uri)) continue;
      if (existing.has(src.uri)) continue;
      existing.add(src.uri);
      const link = document.createElement('a');
      link.href = src.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className =
        'copilot-source-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono max-w-[200px] truncate';
      link.title = `${src.title || src.uri}\n${src.uri}`;
      link.textContent = `↗ ${src.title || src.uri.replace(/^https?:\/\//i, '').split('/')[0]}`;
      sourcesRow.appendChild(link);
      added = true;
    }
    if (added) {
      sourcesRow.classList.remove('hidden');
      sourcesRow.classList.add('flex');
      scrollToBottom();
    }
  }

  function appendErrorBubble(message: string): void {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start';

    const bubble = document.createElement('div');
    bubble.className =
      'max-w-[92%] rounded-2xl rounded-bl-md bg-red-950/60 border border-red-500/35 px-3 py-2 text-xs text-red-200 leading-relaxed break-words';
    bubble.textContent = message;
    wrap.appendChild(bubble);
    messagesEl!.appendChild(wrap);
    scrollToBottom();
  }

  function createToolChip(
    chipsRow: HTMLDivElement,
    name: string,
    args: Record<string, unknown>
  ): {
    markResult: (result: CopilotToolResult) => void;
  } {
    chipsRow.classList.remove('hidden');
    chipsRow.classList.add('flex');

    const chip = document.createElement('span');
    chip.className =
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/60 border border-white/15 text-[11px] font-mono text-slate-300';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = formatToolChipLabel(name, args);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'text-[#e7cb88] animate-pulse';
    statusSpan.textContent = '…';

    chip.append(labelSpan, statusSpan);
    chipsRow.appendChild(chip);
    scrollToBottom();

    return {
      markResult: (result: CopilotToolResult) => {
        chip.title = JSON.stringify(result);
        if (result.ok) {
          chip.className =
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-400/35 text-[11px] font-mono text-emerald-200';
          statusSpan.className = 'text-emerald-400 font-semibold';
          statusSpan.textContent = '✓';
        } else {
          chip.className =
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-950/60 border border-amber-400/35 text-[11px] font-mono text-amber-200';
          statusSpan.className = 'text-amber-400 font-semibold';
          statusSpan.textContent = '!';
        }
        scrollToBottom();
      },
    };
  }

  async function sendTextCommand(rawText: string): Promise<void> {
    const prompt = rawText.trim();
    if (!prompt || isBusy) return;

    // If Live Voice session is active, send typed command directly into Live session
    if (liveActive && liveWs && liveWs.readyState === WebSocket.OPEN) {
      appendUserBubble(prompt);
      inputEl!.value = '';
      liveWs.send(
        JSON.stringify({
          type: 'text',
          text: prompt,
          context: controller.getContextSnapshot(),
        })
      );
      return;
    }

    isBusy = true;
    if (sendBtn) sendBtn.disabled = true;
    inputEl!.value = '';

    appendUserBubble(prompt);
    const turnUI = createAssistantTurnContainer();

    // Show subtle thinking state until text or tool chips appear
    turnUI.textBubble.classList.remove('hidden');
    turnUI.textBubble.className =
      'max-w-[90%] rounded-2xl rounded-bl-md bg-zinc-950/85 border border-zinc-800 px-3 py-2 text-xs text-zinc-400 italic';
    turnUI.textBubble.textContent = 'Working...';

    history.push({ role: 'user', parts: [{ text: prompt }] });

    try {
      let finalText = '';
      const collectedSources: WebSearchSource[] = [];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch('/api/copilot/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: history,
            context: controller.getContextSnapshot(),
          }),
        });

        const data = (await res.json()) as CopilotTurnResponse;
        if (!res.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        if (Array.isArray(data.sources) && data.sources.length > 0) {
          collectedSources.push(...data.sources);
        }

        if (data.modelContent) {
          history.push(data.modelContent);
        }

        if (data.functionCalls && data.functionCalls.length > 0) {
          const responseParts: Array<Record<string, unknown>> = [];

          for (const fc of data.functionCalls) {
            const chip = createToolChip(turnUI.chipsRow, fc.name, fc.args || {});
            const toolResult = await controller.executeTool(fc.name, fc.args || {});
            chip.markResult(toolResult);
            if (Array.isArray((toolResult as any)?.sources)) {
              collectedSources.push(...((toolResult as any).sources as WebSearchSource[]));
            }
            responseParts.push({
              functionResponse: {
                ...(fc.id ? { id: fc.id } : {}),
                name: fc.name,
                response: toolResult,
              },
            });
          }

          history.push({
            role: 'user',
            parts: responseParts,
          });
          continue;
        }

        finalText = data.text || 'Done.';
        break;
      }

      turnUI.textBubble.className =
        'max-w-[90%] rounded-xl rounded-bl-sm bg-black/55 border border-white/10 px-3 py-2 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap break-words';
      turnUI.textBubble.textContent = finalText || 'Done.';
      if (collectedSources.length > 0) {
        appendSourcesToRow(turnUI.sourcesRow, collectedSources);
      }
      scrollToBottom();
    } catch (err: any) {
      turnUI.textBubble.remove();
      // Remove dangling user turn on hard failure so user can retry cleanly
      if (history.length > 0 && history[history.length - 1].role === 'user') {
        history.pop();
      }
      appendErrorBubble(err?.message || 'Co-Pilot request failed.');
    } finally {
      isBusy = false;
      if (sendBtn) sendBtn.disabled = false;
      inputEl?.focus();
    }
  }

  // =========================================================================
  // Gemini Live API Voice Session (16kHz PCM In -> 24kHz PCM Out + Tools)
  // =========================================================================

  function setVoiceUIState(state: 'off' | 'connecting' | 'listening' | 'speaking'): void {
    const active = state !== 'off';
    if (voiceBar) {
      voiceBar.classList.toggle('hidden', !active);
      voiceBar.classList.toggle('flex', active);
    }
    if (dockDot) {
      dockDot.classList.toggle('hidden', !active);
    }
    if (voiceStatus) {
      if (state === 'connecting') voiceStatus.textContent = 'Voice Live — Connecting...';
      else if (state === 'speaking') voiceStatus.textContent = 'Voice Live — Speaking';
      else if (state === 'listening') voiceStatus.textContent = 'Voice Live — Listening';
    }
    if (voiceDot) {
      voiceDot.className =
        state === 'speaking'
          ? 'w-2 h-2 rounded-full bg-[#e7cb88] animate-pulse shrink-0'
          : state === 'connecting'
            ? 'w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0'
            : 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0';
    }
    if (micBtn) {
      micBtn.className = active
        ? 'glass-btn flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-400/50 text-white shrink-0 cursor-pointer'
        : 'chrono-pusher flex items-center justify-center w-9 h-9 rounded-lg shrink-0 cursor-pointer';
    }
  }

  function stopPlaybackQueue(): void {
    activePlaybackSources.forEach((src) => {
      try {
        src.stop();
      } catch {
        // ignore
      }
    });
    activePlaybackSources.clear();
    nextPlayTime = 0;
  }

  function schedulePcm24kChunk(base64Audio: string): void {
    if (!outputAudioCtx) return;
    if (outputAudioCtx.state === 'suspended') {
      outputAudioCtx.resume().catch(() => {});
    }

    const samples = base64Pcm16ToFloat32(base64Audio);
    if (samples.length === 0) return;

    const audioBuffer = outputAudioCtx.createBuffer(1, samples.length, 24000);
    audioBuffer.copyToChannel(samples, 0);

    const source = outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outputAudioCtx.destination);

    const now = outputAudioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.02;
    }

    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
    activePlaybackSources.add(source);
    setVoiceUIState('speaking');

    source.onended = () => {
      activePlaybackSources.delete(source);
      if (activePlaybackSources.size === 0 && liveActive) {
        setVoiceUIState('listening');
      }
    };
  }

  function stopLiveVoice(): void {
    liveActive = false;
    stopPlaybackQueue();

    if (scriptProcessor) {
      scriptProcessor.onaudioprocess = null;
      try {
        scriptProcessor.disconnect();
      } catch {
        // ignore
      }
      scriptProcessor = null;
    }
    if (micSource) {
      try {
        micSource.disconnect();
      } catch {
        // ignore
      }
      micSource = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (inputAudioCtx) {
      inputAudioCtx.close().catch(() => {});
      inputAudioCtx = null;
    }
    if (outputAudioCtx) {
      outputAudioCtx.close().catch(() => {});
      outputAudioCtx = null;
    }
    if (liveWs) {
      try {
        if (liveWs.readyState === WebSocket.OPEN) {
          liveWs.send(JSON.stringify({ type: 'close' }));
        }
        liveWs.close();
      } catch {
        // ignore
      }
      liveWs = null;
    }

    liveUserBubble = null;
    liveUserText = '';
    liveModelBubble = null;
    liveModelText = '';
    liveToolRow = null;
    setVoiceUIState('off');
  }

  async function startLiveVoice(): Promise<void> {
    if (liveActive) {
      stopLiveVoice();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      appendErrorBubble('Microphone capture is not supported in this browser.');
      return;
    }

    setVoiceUIState('connecting');

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioCtx = new AudioCtx({ sampleRate: 16000 });
      outputAudioCtx = new AudioCtx({ sampleRate: 24000 });
      nextPlayTime = 0;

      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${window.location.host}/api/copilot/live`);
      liveWs = ws;
      liveActive = true;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'init',
            context: controller.getContextSnapshot(),
          })
        );
      };

      ws.onmessage = async (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'ready') {
          setVoiceUIState('listening');
          if (!inputAudioCtx || !micStream) return;
          if (inputAudioCtx.state === 'suspended') {
            await inputAudioCtx.resume().catch(() => {});
          }
          micSource = inputAudioCtx.createMediaStreamSource(micStream);
          scriptProcessor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (audioEvent) => {
            if (!liveActive || !liveWs || liveWs.readyState !== WebSocket.OPEN) return;
            const inputData = audioEvent.inputBuffer.getChannelData(0);
            const pcm16k = downsampleBuffer(inputData, inputAudioCtx!.sampleRate, 16000);
            const base64 = float32ToPcm16Base64(pcm16k);
            liveWs.send(JSON.stringify({ type: 'audio', data: base64 }));
          };
          micSource.connect(scriptProcessor);
          scriptProcessor.connect(inputAudioCtx.destination);
        } else if (msg.type === 'audio' && msg.data) {
          schedulePcm24kChunk(msg.data);
        } else if (msg.type === 'interrupted') {
          stopPlaybackQueue();
          if (liveActive) setVoiceUIState('listening');
        } else if (msg.type === 'inputTranscript' && msg.text) {
          liveModelBubble = null;
          liveModelText = '';
          liveToolRow = null;
          liveUserText = `${liveUserText}${msg.text}`;
          if (!liveUserBubble) {
            liveUserBubble = appendUserBubble(liveUserText.trim());
          } else {
            liveUserBubble.textContent = liveUserText.trim();
            scrollToBottom();
          }
        } else if (msg.type === 'outputTranscript' && msg.text) {
          liveUserBubble = null;
          liveUserText = '';
          liveModelText = `${liveModelText}${msg.text}`;
          if (!liveModelBubble) {
            const turn = createAssistantTurnContainer();
            if (liveToolRow && liveToolRow.parentElement) {
              // Reuse existing tool turn bubble if tools ran right before speech
              const siblingBubble = liveToolRow.nextElementSibling as HTMLDivElement | null;
              if (siblingBubble) {
                turn.root.remove();
                liveModelBubble = siblingBubble;
              } else {
                liveModelBubble = turn.textBubble;
              }
            } else {
              liveModelBubble = turn.textBubble;
            }
            liveModelBubble.classList.remove('hidden');
          }
          liveModelBubble.textContent = liveModelText.trim();
          scrollToBottom();
        } else if (msg.type === 'turnComplete') {
          liveUserBubble = null;
          liveUserText = '';
          liveModelBubble = null;
          liveModelText = '';
          liveToolRow = null;
        } else if (msg.type === 'toolCall' && Array.isArray(msg.functionCalls)) {
          liveUserBubble = null;
          liveUserText = '';
          const turn = createAssistantTurnContainer();
          liveToolRow = turn.chipsRow;

          const functionResponses: Array<{
            id?: string;
            name: string;
            response: CopilotToolResult;
          }> = [];

          for (const fc of msg.functionCalls as TurnFunctionCall[]) {
            const chip = createToolChip(turn.chipsRow, fc.name, fc.args || {});
            const result = await controller.executeTool(fc.name, fc.args || {});
            chip.markResult(result);
            if (Array.isArray((result as any)?.sources)) {
              appendSourcesToRow(turn.sourcesRow, (result as any).sources as WebSearchSource[]);
            }
            functionResponses.push({
              ...(fc.id ? { id: fc.id } : {}),
              name: fc.name,
              response: result,
            });
          }

          if (liveWs && liveWs.readyState === WebSocket.OPEN) {
            liveWs.send(
              JSON.stringify({
                type: 'toolResponse',
                functionResponses,
                context: controller.getContextSnapshot(),
              })
            );
          }
        } else if (msg.type === 'error') {
          appendErrorBubble(msg.error || 'Gemini Live voice error.');
          stopLiveVoice();
        } else if (msg.type === 'closed') {
          stopLiveVoice();
        }
      };

      ws.onerror = () => {
        if (liveActive) {
          appendErrorBubble('Lost connection to Gemini Live voice bridge.');
          stopLiveVoice();
        }
      };

      ws.onclose = () => {
        if (liveActive) {
          stopLiveVoice();
        }
      };
    } catch (err: any) {
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow mic permission to use Live Voice.'
          : err?.message || 'Could not start microphone for Live Voice.';
      appendErrorBubble(msg);
      stopLiveVoice();
    }
  }

  // Event Wiring: first click explicitly sets coPilotOpen=true and controlsOpen=false
  toggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nextOpen = !drawerVisible;
    setDrawerVisible(nextOpen);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDrawerVisible(false);
  });

  clearBtn?.addEventListener('click', () => {
    history = [];
    Array.from(messagesEl.children).forEach((child) => {
      if (child.id !== 'copilot-empty') child.remove();
    });
    if (emptyEl) emptyEl.classList.remove('hidden');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendTextCommand(inputEl.value);
  });

  micBtn?.addEventListener('click', () => {
    startLiveVoice();
  });

  stopVoiceBtn?.addEventListener('click', () => {
    stopLiveVoice();
  });

  document.querySelectorAll<HTMLButtonElement>('.copilot-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.copilotPrompt || '';
      if (prompt) sendTextCommand(prompt);
    });
  });

  window.addEventListener('beforeunload', () => {
    stopLiveVoice();
  });
}
