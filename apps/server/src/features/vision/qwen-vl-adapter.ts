import { promises as fs } from 'node:fs';
import {
  AppError,
  visionResultSchema,
  type VisionResult,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import {
  JsonModelClient,
  ModelClientError,
} from '../providers/json-model-client.js';
import {
  ProviderRepository,
  type StoredProviderProfile,
} from '../providers/provider-repository.js';
import type {
  VisionAdapter,
  VisionRecognitionRequest,
} from './vision-adapter.js';

const VISION_SYSTEM_PROMPT = [
  '你是冰箱食材识别器。只识别图片中实际可见的食材。',
  '只返回一个 JSON 对象，不要 Markdown、代码围栏、说明或额外字段。',
  '对象必须严格为 {"items":[{"name":string,"quantity":number,"unit":string,"confidence":number,"needs_confirmation":boolean}]}。',
  'quantity 必须是大于 0 的估计值；confidence 必须在 0 到 1；needs_confirmation 必须为 true。',
  '优先使用 g、kg、ml、L、个、只、枚、根、片、瓣、茶匙、汤匙、少许、适量。',
  '不能可靠判断时降低 confidence，但不要臆造看不见的食材。',
].join('\n');

export interface VisionProviderSource {
  getEnabledProfile(): StoredProviderProfile | undefined;
}

export class DatabaseVisionProviderSource implements VisionProviderSource {
  readonly #repository: ProviderRepository;

  constructor(private readonly db: Database.Database) {
    this.#repository = new ProviderRepository(db);
  }

  getEnabledProfile(): StoredProviderProfile | undefined {
    const row = this.db.prepare(`
      SELECT id
      FROM provider_profiles
      WHERE kind = 'vision' AND is_enabled = 1
      ORDER BY last_tested_at DESC NULLS LAST, created_at ASC, id ASC
      LIMIT 1
    `).get() as { readonly id: string } | undefined;
    return row === undefined ? undefined : this.#repository.get(row.id);
  }
}

const providerFailure = (error: ModelClientError): AppError => {
  switch (error.code) {
    case 'auth':
      return new AppError(
        'vision_provider_auth',
        '视觉服务鉴权失败，请重新填写 Qwen-VL API Key',
        502,
      );
    case 'model_not_found':
      return new AppError(
        'vision_model_not_found',
        '未找到已配置的 Qwen-VL 模型，请检查 Model ID',
        502,
      );
    case 'quota':
      return new AppError(
        'vision_provider_quota',
        '视觉服务额度不足，请检查服务账户或改用手动录入',
        503,
      );
    case 'rate_limited':
      return new AppError(
        'vision_provider_rate_limited',
        '视觉服务请求过于频繁，请稍后重试或手动录入',
        429,
      );
    case 'timeout':
      return new AppError(
        'vision_provider_timeout',
        '视觉服务响应超时，请重试或手动录入',
        504,
      );
    case 'protocol':
      return new AppError(
        'vision_result_invalid',
        '视觉服务返回了无法使用的识别结果，请重试或手动录入',
        502,
      );
    case 'cancelled':
      return new AppError('cancelled', '图片识别已取消', 499);
    case 'upstream':
    case 'unknown':
    default:
      return new AppError(
        'vision_provider_unavailable',
        '视觉服务暂时不可用，请稍后重试或手动录入',
        502,
      );
  }
};

export class QwenVlAdapter implements VisionAdapter {
  constructor(
    private readonly providers: VisionProviderSource,
    private readonly modelClient: JsonModelClient,
  ) {}

  async recognize(request: VisionRecognitionRequest): Promise<VisionResult> {
    const profile = this.providers.getEnabledProfile();
    if (
      profile === undefined
      || profile.kind !== 'vision'
      || !profile.enabled
      || !profile.capabilities.vision
      || !profile.capabilities.json
    ) {
      throw new AppError(
        'vision_provider_missing',
        '请先配置并启用支持 JSON 的 Qwen-VL 视觉服务，或手动添加食材',
        503,
      );
    }
    if (request.signal.aborted) {
      throw new AppError('cancelled', '图片识别已取消', 499);
    }

    const imageBytes = await fs.readFile(request.image.path);
    try {
      const imageUrl = `data:${request.image.mimeType};base64,${imageBytes.toString('base64')}`;
      const completion = await this.modelClient.completeJson({
        profile,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '识别这张图片中可见的食材，并严格按约定 JSON 返回。',
              },
              {
                type: 'image_url',
                image_url: { detail: 'high', url: imageUrl },
              },
            ],
          },
        ],
        maxTokens: 4_096,
        parse: (value) => visionResultSchema.parse(value),
        signal: request.signal,
        temperature: 0,
      });
      return completion.value;
    } catch (error) {
      if (error instanceof ModelClientError) {
        throw providerFailure(error);
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        'vision_provider_unavailable',
        '视觉服务暂时不可用，请稍后重试或手动录入',
        502,
      );
    } finally {
      imageBytes.fill(0);
    }
  }
}
