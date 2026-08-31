import { randomUUID } from 'node:crypto';
import {
  AppError,
  providerProfileSchema,
  type CreateProviderProfileInput,
  type ModelErrorCode,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderUrlValidation,
  type UpdateProviderProfileInput,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import {
  JsonModelClient,
  ModelClientError,
} from './json-model-client.js';
import {
  OutboundUrlPolicy,
  OutboundUrlPolicyError,
} from './outbound-url-policy.js';
import { putOriginBoundSecret } from './origin-bound-secret.js';
import {
  ProviderRepository,
  type SaveProviderProfile,
  type StoredProviderProfile,
} from './provider-repository.js';
import type { SecretStore } from './secret-store.js';

export interface ProviderServiceOptions {
  readonly createId?: () => string;
  readonly modelClient?: JsonModelClient;
  readonly now?: () => Date;
  readonly urlPolicy?: OutboundUrlPolicy;
}

const providerNotFound = (): AppError => new AppError(
  'provider_not_found',
  '模型配置不存在',
  404,
);

const MODEL_ERROR_RESPONSES: Readonly<
  Record<ModelErrorCode, { readonly message: string; readonly status: number }>
> = {
  auth: { message: '鉴权失败，请重新输入 API Key', status: 401 },
  model_not_found: { message: '当前 Model ID 不存在', status: 400 },
  quota: { message: '模型服务额度或余额不足', status: 402 },
  rate_limited: { message: '模型服务请求过于频繁，请稍后重试', status: 429 },
  timeout: { message: '模型服务连接超时', status: 504 },
  protocol: { message: '模型服务返回了不兼容的协议内容', status: 502 },
  upstream: { message: '模型服务暂时不可用', status: 502 },
  cancelled: { message: '模型服务请求已取消', status: 408 },
  unknown: { message: '模型服务连接失败', status: 502 },
};

const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof ModelClientError) {
    const response = MODEL_ERROR_RESPONSES[error.code];
    return new AppError(error.code, response.message, response.status);
  }
  if (error instanceof OutboundUrlPolicyError) {
    const message = error.code === 'provider_dns_failed'
      ? '无法解析模型服务地址'
      : '模型服务地址不安全或格式无效';
    return new AppError(error.code, message, 400);
  }
  return new AppError(
    'provider_operation_failed',
    '模型配置操作失败',
    500,
  );
};

const validateMergedProfile = (
  current: StoredProviderProfile,
  input: UpdateProviderProfileInput,
  normalizedBaseUrl: string,
): Omit<SaveProviderProfile, 'id' | 'keyRef' | 'lastTestedAt'> => {
  const candidate = {
    id: current.id,
    protocol: 'openai-chat-completions' as const,
    name: input.name ?? current.name,
    kind: input.kind ?? current.kind,
    template: input.template ?? current.template,
    baseUrl: normalizedBaseUrl,
    modelId: input.modelId ?? current.modelId,
    capabilities: input.capabilities ?? current.capabilities,
    streamEnabled: input.streamEnabled ?? current.streamEnabled,
    enabled: input.enabled ?? current.enabled,
    hasKey: true,
    lastTestedAt: current.lastTestedAt,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
  const parsed = providerProfileSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('validation_error', '模型配置参数无效', 400);
  }
  return {
    name: parsed.data.name,
    kind: parsed.data.kind,
    template: parsed.data.template,
    normalizedBaseUrl: parsed.data.baseUrl,
    modelId: parsed.data.modelId,
    capabilities: parsed.data.capabilities,
    streamEnabled: parsed.data.streamEnabled,
    enabled: parsed.data.enabled,
  };
};

export class ProviderService {
  readonly #createId: () => string;
  readonly #modelClient: JsonModelClient;
  readonly #now: () => Date;
  readonly #repository: ProviderRepository;
  readonly #urlPolicy: OutboundUrlPolicy;

  constructor(
    database: Database.Database,
    private readonly secretStore: SecretStore,
    options: ProviderServiceOptions = {},
  ) {
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#repository = new ProviderRepository(database);
    this.#urlPolicy = options.urlPolicy ?? new OutboundUrlPolicy();
    this.#modelClient = options.modelClient ?? new JsonModelClient(secretStore, {
      policy: this.#urlPolicy,
    });
  }

  list(): ProviderProfile[] {
    return this.#repository.list();
  }

  async validateUrl(baseUrl: string): Promise<ProviderUrlValidation> {
    try {
      return await this.#urlPolicy.validateBaseUrl(baseUrl);
    } catch (error) {
      throw toAppError(error);
    }
  }

  async create(
    input: CreateProviderProfileInput,
    signal: AbortSignal,
  ): Promise<ProviderProfile> {
    let keyRef: string | undefined;
    try {
      const validated = await this.#urlPolicy.validateBaseUrl(input.baseUrl);
      keyRef = await putOriginBoundSecret(
        this.secretStore,
        input.apiKey,
        validated.origin,
      );
      const draft: SaveProviderProfile = {
        id: this.#createId(),
        name: input.name,
        kind: input.kind,
        template: input.template,
        normalizedBaseUrl: validated.normalizedBaseUrl,
        modelId: input.modelId,
        capabilities: input.capabilities,
        streamEnabled: input.streamEnabled,
        keyRef,
        enabled: input.enabled,
        lastTestedAt: null,
      };
      await this.#modelClient.testConnection(draft, signal);
      const testedAt = this.#now().toISOString();
      return this.#repository.insert(
        { ...draft, lastTestedAt: testedAt },
        testedAt,
      );
    } catch (error) {
      if (keyRef !== undefined) {
        await this.secretStore.delete(keyRef).catch(() => undefined);
      }
      throw toAppError(error);
    }
  }

  async update(
    providerId: string,
    input: UpdateProviderProfileInput,
    signal: AbortSignal,
  ): Promise<ProviderProfile> {
    const current = this.#repository.get(providerId);
    if (current === undefined) {
      throw providerNotFound();
    }

    let newKeyRef: string | undefined;
    try {
      const normalizedBaseUrl = input.baseUrl === undefined
        ? current.normalizedBaseUrl
        : (await this.#urlPolicy.validateBaseUrl(input.baseUrl)).normalizedBaseUrl;
      const baseUrlChanged = normalizedBaseUrl !== current.normalizedBaseUrl;
      if (baseUrlChanged && input.apiKey === undefined) {
        throw new AppError(
          'api_key_required',
          'Base URL 已变化，请重新输入 API Key',
          400,
        );
      }

      const merged = validateMergedProfile(current, input, normalizedBaseUrl);
      let keyRef = current.keyRef;
      if (input.apiKey !== undefined) {
        const validated = await this.#urlPolicy.validateBaseUrl(normalizedBaseUrl);
        newKeyRef = await putOriginBoundSecret(
          this.secretStore,
          input.apiKey,
          validated.origin,
        );
        keyRef = newKeyRef;
      }
      const connectionChanged = baseUrlChanged
        || merged.modelId !== current.modelId
        || newKeyRef !== undefined;
      let testedAt = current.lastTestedAt;
      const draft: SaveProviderProfile = {
        id: current.id,
        ...merged,
        keyRef,
        lastTestedAt: testedAt,
      };
      if (connectionChanged) {
        await this.#modelClient.testConnection(draft, signal);
        testedAt = this.#now().toISOString();
      }
      const updatedAt = this.#now().toISOString();
      const updated = this.#repository.update(
        { ...draft, lastTestedAt: testedAt },
        updatedAt,
      );
      if (newKeyRef !== undefined && newKeyRef !== current.keyRef) {
        await this.secretStore.delete(current.keyRef).catch(() => undefined);
      }
      return updated;
    } catch (error) {
      if (newKeyRef !== undefined) {
        await this.secretStore.delete(newKeyRef).catch(() => undefined);
      }
      throw toAppError(error);
    }
  }

  async delete(providerId: string): Promise<void> {
    const deleted = this.#repository.delete(providerId);
    if (deleted === undefined) {
      throw providerNotFound();
    }
    try {
      await this.secretStore.delete(deleted.keyRef);
    } catch (error) {
      throw toAppError(error);
    }
  }

  async test(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ProviderConnectionResult> {
    const profile = this.#repository.get(providerId);
    if (profile === undefined) {
      throw providerNotFound();
    }
    try {
      const result = await this.#modelClient.testConnection(profile, signal);
      const testedAt = this.#now().toISOString();
      this.#repository.markTested(
        providerId,
        result.capabilities,
        testedAt,
      );
      return { ...result, testedAt };
    } catch (error) {
      throw toAppError(error);
    }
  }
}
