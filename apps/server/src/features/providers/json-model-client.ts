import type {
  ModelErrorCode,
  ProviderCapabilities,
  ProviderConnectionResult,
} from '@xiaochu/shared';
import { request } from 'undici';
import {
  OutboundUrlPolicy,
} from './outbound-url-policy.js';
import { getOriginBoundSecret } from './origin-bound-secret.js';
import { createSafeDispatcher } from './safe-dispatcher.js';
import type { SecretStore } from './secret-store.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_REQUEST_BYTES = 15 * 1_024 * 1_024;

export interface ModelProviderProfile {
  readonly normalizedBaseUrl: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  readonly streamEnabled: boolean;
  readonly keyRef: string;
}

export type JsonModelContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image_url';
      readonly image_url: {
        readonly url: string;
        readonly detail?: 'auto' | 'low' | 'high';
      };
    };

export interface JsonModelMessage {
  readonly role: 'assistant' | 'system' | 'user';
  readonly content: string | readonly JsonModelContentPart[];
}

export interface ModelCompletionRequest {
  readonly profile: ModelProviderProfile;
  readonly messages: readonly JsonModelMessage[];
  readonly signal: AbortSignal;
  readonly jsonMode?: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly tools?: readonly unknown[];
}

export interface JsonCompletionRequest<T> extends Omit<
  ModelCompletionRequest,
  'jsonMode'
> {
  readonly parse: (value: unknown) => T;
}

export interface ModelCompletionResult {
  readonly content: string;
  readonly model: string;
}

export type ModelProviderStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly index: number; readonly callId: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: 'finish'; readonly reason: string };

export interface JsonCompletionResult<T> {
  readonly value: T;
  readonly model: string;
}

export interface JsonModelClientOptions {
  readonly bodyTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly policy?: OutboundUrlPolicy;
  readonly totalTimeoutMs?: number;
}

export class ModelClientError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelClientError';
  }
}

interface OpenAiResponse {
  readonly content: string;
  readonly model: string;
}

interface RequestAbortState {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  cleanup(): void;
}

const createAbortState = (
  externalSignal: AbortSignal,
  totalTimeoutMs: number,
): RequestAbortState => {
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromCaller = (): void => controller.abort(externalSignal.reason);
  if (externalSignal.aborted) {
    abortFromCaller();
  } else {
    externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('Provider request timed out'));
  }, totalTimeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', abortFromCaller);
    },
  };
};

export const buildChatCompletionsUrl = (baseUrl: string): string => {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/chat/completions`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
};

export const buildChatCompletionBody = (
  requestInput: Pick<
    ModelCompletionRequest,
    'jsonMode' | 'maxTokens' | 'messages' | 'profile' | 'temperature' | 'tools'
  >,
  stream = false,
): Readonly<Record<string, unknown>> => ({
  model: requestInput.profile.modelId,
  messages: requestInput.messages,
  stream,
  ...(requestInput.maxTokens === undefined
    ? {}
    : { max_tokens: requestInput.maxTokens }),
  ...(requestInput.temperature === undefined
    ? {}
    : { temperature: requestInput.temperature }),
  ...(requestInput.jsonMode === true
    ? { response_format: { type: 'json_object' } }
    : {}),
  ...(requestInput.tools === undefined || requestInput.tools.length === 0
    ? {}
    : { tools: requestInput.tools }),
});

const readBoundedBody = async (
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<string> => {
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let result = '';
  for await (const chunk of body) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maximumBytes) {
      throw new ModelClientError(
        'protocol',
        'Provider response exceeded the configured limit',
      );
    }
    result += decoder.decode(chunk, { stream: true });
  }
  result += decoder.decode();
  return result;
};

const parseJsonObject = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Expected an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ModelClientError(
      'protocol',
      'Provider returned invalid JSON',
      { cause: error },
    );
  }
};

const parseCompletion = (
  raw: string,
  fallbackModel: string,
): OpenAiResponse => {
  const payload = parseJsonObject(raw);
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelClientError(
      'protocol',
      'Provider response did not contain a completion',
    );
  }
  const first = choices[0];
  if (
    typeof first !== 'object'
    || first === null
    || !('message' in first)
    || typeof first.message !== 'object'
    || first.message === null
    || !('content' in first.message)
    || typeof first.message.content !== 'string'
  ) {
    throw new ModelClientError(
      'protocol',
      'Provider response used an unsupported completion shape',
    );
  }
  return {
    content: first.message.content,
    model: typeof payload.model === 'string' && payload.model.length > 0
      ? payload.model
      : fallbackModel,
  };
};

const upstreamErrorText = (raw: string): string => {
  try {
    const payload: unknown = JSON.parse(raw);
    if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
      return '';
    }
    const error = payload.error;
    if (typeof error !== 'object' || error === null) {
      return '';
    }
    const errorRecord = error as Record<string, unknown>;
    return ['code', 'type', 'message']
      .map((key) => typeof errorRecord[key] === 'string' ? errorRecord[key] : '')
      .join(' ')
      .toLocaleLowerCase('en-US')
      .slice(0, 2_000);
  } catch {
    return '';
  }
};

const errorForStatus = (statusCode: number, raw: string): ModelClientError => {
  const upstream = upstreamErrorText(raw);
  if (statusCode === 401 || statusCode === 403) {
    return new ModelClientError('auth', 'Provider authentication failed');
  }
  if (statusCode === 404 || upstream.includes('model_not_found')) {
    return new ModelClientError('model_not_found', 'Provider model was not found');
  }
  if (
    statusCode === 402
    || upstream.includes('insufficient_quota')
    || upstream.includes('insufficient balance')
    || upstream.includes('quota')
  ) {
    return new ModelClientError('quota', 'Provider quota is unavailable');
  }
  if (statusCode === 429) {
    return new ModelClientError('rate_limited', 'Provider rate limit was reached');
  }
  if (statusCode === 408 || statusCode === 504) {
    return new ModelClientError('timeout', 'Provider request timed out');
  }
  if (statusCode >= 300 && statusCode < 400) {
    return new ModelClientError('protocol', 'Provider redirects are not allowed');
  }
  return new ModelClientError('upstream', 'Provider request failed');
};

const mapRequestError = (
  error: unknown,
  externalSignal: AbortSignal,
  timedOut: boolean,
): ModelClientError => {
  if (error instanceof ModelClientError) {
    return error;
  }
  if (timedOut) {
    return new ModelClientError('timeout', 'Provider request timed out');
  }
  if (externalSignal.aborted) {
    return new ModelClientError('cancelled', 'Provider request was cancelled');
  }
  const code = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
      ? error.code
      : '';
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return new ModelClientError('timeout', 'Provider request timed out');
  }
  return new ModelClientError(
    'upstream',
    'Provider request could not be completed',
    error instanceof Error ? { cause: error } : undefined,
  );
};

const parseStreamPayload = (raw: string): readonly ModelProviderStreamEvent[] => {
  const payload = parseJsonObject(raw);
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelClientError('protocol', 'Provider stream did not contain choices');
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    throw new ModelClientError('protocol', 'Provider stream choice is invalid');
  }
  const record = choice as Record<string, unknown>;
  const events: ModelProviderStreamEvent[] = [];
  const delta = record.delta;
  if (typeof delta === 'object' && delta !== null && !Array.isArray(delta)) {
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.content === 'string' && deltaRecord.content.length > 0) {
      events.push({ type: 'text', text: deltaRecord.content });
    }
    if (Array.isArray(deltaRecord.tool_calls)) {
      deltaRecord.tool_calls.forEach((toolCall, position) => {
        if (typeof toolCall !== 'object' || toolCall === null || Array.isArray(toolCall)) return;
        const toolRecord = toolCall as Record<string, unknown>;
        const index = typeof toolRecord.index === 'number' && Number.isInteger(toolRecord.index)
          ? toolRecord.index : position;
        const functionValue = toolRecord.function;
        const functionRecord = typeof functionValue === 'object'
          && functionValue !== null && !Array.isArray(functionValue)
          ? functionValue as Record<string, unknown> : undefined;
        const callId = typeof toolRecord.id === 'string' && toolRecord.id.length > 0
          ? toolRecord.id : `tool-${index}`;
        const name = typeof functionRecord?.name === 'string' ? functionRecord.name : undefined;
        const argumentsDelta = typeof functionRecord?.arguments === 'string'
          ? functionRecord.arguments : undefined;
        events.push({
          type: 'tool', index, callId,
          ...(name === undefined ? {} : { name }),
          ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
        });
      });
    }
  }
  if (typeof record.finish_reason === 'string') {
    events.push({ type: 'finish', reason: record.finish_reason });
  }
  return events;
};

const splitSseLines = (buffer: string): { readonly lines: string[]; readonly rest: string } => {
  const normalized = buffer.replaceAll('\r\n', '\n');
  const lastBreak = normalized.lastIndexOf('\n');
  if (lastBreak === -1) return { lines: [], rest: normalized };
  return { lines: normalized.slice(0, lastBreak).split('\n'), rest: normalized.slice(lastBreak + 1) };
};

export class JsonModelClient {
  readonly #bodyTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #headersTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #policy: OutboundUrlPolicy;
  readonly #totalTimeoutMs: number;

  constructor(
    private readonly secretStore: SecretStore,
    options: JsonModelClientOptions = {},
  ) {
    this.#bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#headersTimeoutMs = options.headersTimeoutMs
      ?? DEFAULT_HEADERS_TIMEOUT_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes
      ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#policy = options.policy ?? new OutboundUrlPolicy();
    this.#totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  }

  async complete(
    input: ModelCompletionRequest,
  ): Promise<ModelCompletionResult> {
    if (input.messages.length === 0 || input.messages.length > 200) {
      throw new ModelClientError('protocol', 'Model messages are invalid');
    }
    if (input.jsonMode === true && !input.profile.capabilities.json) {
      throw new ModelClientError('protocol', 'Provider does not support JSON mode');
    }
    if (
      input.maxTokens !== undefined
      && (!Number.isInteger(input.maxTokens)
        || input.maxTokens < 1
        || input.maxTokens > 32_768)
    ) {
      throw new ModelClientError('protocol', 'Model token limit is invalid');
    }
    if (
      input.temperature !== undefined
      && (!Number.isFinite(input.temperature)
        || input.temperature < 0
        || input.temperature > 2)
    ) {
      throw new ModelClientError('protocol', 'Model temperature is invalid');
    }

    const validated = await this.#policy.validateBaseUrl(
      input.profile.normalizedBaseUrl,
    );
    if (validated.normalizedBaseUrl !== input.profile.normalizedBaseUrl) {
      throw new ModelClientError('protocol', 'Stored provider URL is not canonical');
    }
    const targetUrl = buildChatCompletionsUrl(validated.normalizedBaseUrl);
    if (new URL(targetUrl).origin !== validated.origin) {
      throw new ModelClientError('protocol', 'Provider endpoint changed origin');
    }

    let apiKey: string;
    try {
      apiKey = await getOriginBoundSecret(
        this.secretStore,
        input.profile.keyRef,
        validated.origin,
      );
    } catch (error) {
      throw new ModelClientError(
        'auth',
        'Provider credential is unavailable',
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    const requestBody = JSON.stringify(buildChatCompletionBody(input));
    if (Buffer.byteLength(requestBody, 'utf8') > this.#maxRequestBytes) {
      throw new ModelClientError('protocol', 'Provider request is too large');
    }
    const abortState = createAbortState(input.signal, this.#totalTimeoutMs);
    const safeDispatcher = createSafeDispatcher({
      boundOrigin: validated.origin,
      connectTimeoutMs: this.#connectTimeoutMs,
      developmentLoopback: validated.developmentLoopback,
      policy: this.#policy,
      targetUrl,
    });

    try {
      const response = await request(targetUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        bodyTimeout: this.#bodyTimeoutMs,
        dispatcher: safeDispatcher.dispatcher,
        headersTimeout: this.#headersTimeoutMs,
        signal: abortState.signal,
      });
      const raw = await readBoundedBody(response.body, this.#maxResponseBytes);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw errorForStatus(response.statusCode, raw);
      }
      return parseCompletion(raw, input.profile.modelId);
    } catch (error) {
      throw mapRequestError(error, input.signal, abortState.timedOut());
    } finally {
      abortState.cleanup();
      await safeDispatcher.close().catch(() => undefined);
      apiKey = '';
    }
  }

  async completeJson<T>(
    input: JsonCompletionRequest<T>,
  ): Promise<JsonCompletionResult<T>> {
    const completion = await this.complete({ ...input, jsonMode: true });
    const parsed = parseJsonObject(completion.content);
    let value: T;
    try {
      value = input.parse(parsed);
    } catch (error) {
      throw new ModelClientError(
        'protocol',
        'Provider JSON result did not match the required schema',
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    return { value, model: completion.model };
  }

  async *stream(input: ModelCompletionRequest): AsyncIterable<ModelProviderStreamEvent> {
    if (!input.profile.capabilities.stream || !input.profile.streamEnabled) {
      const completed = await this.complete(input);
      if (completed.content.length > 0) yield { type: 'text', text: completed.content };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (input.messages.length === 0 || input.messages.length > 200) {
      throw new ModelClientError('protocol', 'Model messages are invalid');
    }
    if (input.tools !== undefined && !input.profile.capabilities.tools) {
      throw new ModelClientError('protocol', 'Provider does not support tools');
    }
    const validated = await this.#policy.validateBaseUrl(input.profile.normalizedBaseUrl);
    if (validated.normalizedBaseUrl !== input.profile.normalizedBaseUrl) {
      throw new ModelClientError('protocol', 'Stored provider URL is not canonical');
    }
    const targetUrl = buildChatCompletionsUrl(validated.normalizedBaseUrl);
    let apiKey: string;
    try {
      apiKey = await getOriginBoundSecret(this.secretStore, input.profile.keyRef, validated.origin);
    } catch (error) {
      throw new ModelClientError('auth', 'Provider credential is unavailable', error instanceof Error ? { cause: error } : undefined);
    }
    const requestBody = JSON.stringify(buildChatCompletionBody(input, true));
    if (Buffer.byteLength(requestBody, 'utf8') > this.#maxRequestBytes) {
      throw new ModelClientError('protocol', 'Provider request is too large');
    }
    const abortState = createAbortState(input.signal, this.#totalTimeoutMs);
    const safeDispatcher = createSafeDispatcher({
      boundOrigin: validated.origin,
      connectTimeoutMs: this.#connectTimeoutMs,
      developmentLoopback: validated.developmentLoopback,
      policy: this.#policy,
      targetUrl,
    });
    try {
      const response = await request(targetUrl, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream', authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        bodyTimeout: this.#bodyTimeoutMs,
        dispatcher: safeDispatcher.dispatcher,
        headersTimeout: this.#headersTimeoutMs,
        signal: abortState.signal,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw errorForStatus(response.statusCode, await readBoundedBody(response.body, this.#maxResponseBytes));
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let bytesRead = 0;
      for await (const chunk of response.body) {
        bytesRead += chunk.byteLength;
        if (bytesRead > this.#maxResponseBytes) {
          throw new ModelClientError('protocol', 'Provider response exceeded the configured limit');
        }
        buffer += decoder.decode(chunk, { stream: true });
        const split = splitSseLines(buffer);
        buffer = split.rest;
        for (const line of split.lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          for (const event of parseStreamPayload(data)) yield event;
        }
      }
      buffer += decoder.decode();
      for (const line of splitSseLines(`${buffer}\n`).lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data !== '' && data !== '[DONE]') {
          for (const event of parseStreamPayload(data)) yield event;
        }
      }
    } catch (error) {
      throw mapRequestError(error, input.signal, abortState.timedOut());
    } finally {
      abortState.cleanup();
      await safeDispatcher.close().catch(() => undefined);
      apiKey = '';
    }
  }

  async testConnection(
    profile: ModelProviderProfile,
    signal: AbortSignal,
  ): Promise<Omit<ProviderConnectionResult, 'testedAt'>> {
    const completion = await this.complete({
      profile,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      maxTokens: 4,
      signal,
      temperature: 0,
    });
    return {
      status: 'ok',
      model: completion.model,
      capabilities: profile.capabilities,
    };
  }
}
