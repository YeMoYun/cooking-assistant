import type { ContextSelection, PendingActionPreview, VoiceFrame } from '@xiaochu/shared';
import { apiClient } from '../../lib/api-client';
import { decodeNdjson } from './ndjson-decoder';
import { SentenceBuffer } from './sentence-buffer';
import { speak, stopSpeaking } from './speech-synthesis';

export type AssistantTurnState = 'idle' | 'thinking' | 'speaking' | 'error';

export class TurnController {
  #abort: AbortController | undefined;
  #turnId = '';
  #sequence = -1;
  #buffer = new SentenceBuffer();

  constructor(
    private readonly sessionId: string,
    private readonly onText: (text: string) => void,
    private readonly onState: (state: AssistantTurnState) => void,
    private readonly onDraft: (action: PendingActionPreview) => void,
    private readonly muted: () => boolean,
  ) {}

  async start(text: string, context: ContextSelection): Promise<void> {
    this.cancel();
    this.#turnId = crypto.randomUUID();
    this.#sequence = -1;
    this.#abort = new AbortController();
    this.onState('thinking');
    const response = await apiClient.stream(`/api/voice/sessions/${this.sessionId}/turns`, {
      method: 'POST',
      body: { turnId: this.#turnId, text, context },
      signal: this.#abort.signal,
    });
    if (response.body === null) throw new Error('The assistant did not return a stream.');
    for await (const frame of decodeNdjson<VoiceFrame>(response.body)) {
      if (
        frame.turn_id !== this.#turnId
        || frame.session_id !== this.sessionId
        || frame.seq <= this.#sequence
      ) continue;
      this.#sequence = frame.seq;
      if (frame.type === 'text.delta') {
        this.onText(frame.text);
        if (!this.muted()) {
          for (const sentence of this.#buffer.push(frame.text)) speak(sentence);
          this.onState('speaking');
        }
      }
      if (frame.type === 'tool.draft') this.onDraft(frame.action);
      if (frame.type === 'turn.finished') {
        if (!this.muted()) {
          for (const sentence of this.#buffer.flush()) speak(sentence);
        }
        this.onState('idle');
      }
      if (frame.type === 'turn.error') {
        this.onState('error');
        throw new Error(frame.error.message);
      }
    }
  }

  cancel(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    stopSpeaking();
    this.#buffer.clear();
    this.onState('idle');
  }
}
