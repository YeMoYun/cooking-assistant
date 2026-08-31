import {
  AppError,
  VISION_CONFIRM_MAX_BYTES,
  confirmRecognitionInputSchema,
  normalizeUnit,
  visionCandidateSchema,
  visionResultSchema,
  type ConfirmRecognitionInput,
  type ConfirmRecognitionResult,
  type KitchenCategory,
  type RecognitionPreview,
  type VisionCandidate,
  type VisionConfirmationReason,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { PreparedVisionImage } from './image-pipeline.js';
import {
  RecognitionDraftRepository,
} from './recognition-draft-repository.js';
import type { VisionAdapter } from './vision-adapter.js';

interface IngredientMatchRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly category: KitchenCategory;
}

export interface RecognizeVisionInput {
  readonly image: PreparedVisionImage;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface ConfirmVisionInput {
  readonly recognitionId: string;
  readonly sessionId: string;
  readonly body: ConfirmRecognitionInput;
}

export interface VisionServiceOptions {
  readonly drafts?: RecognitionDraftRepository;
}

const normalizeName = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, ' ')
  .trim();

const displayName = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim();

export class VisionService {
  readonly #drafts: RecognitionDraftRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly adapter: VisionAdapter,
    options: VisionServiceOptions = {},
  ) {
    this.#drafts = options.drafts ?? new RecognitionDraftRepository(db);
  }

  async recognize(input: RecognizeVisionInput): Promise<RecognitionPreview> {
    let modelResult;
    try {
      modelResult = visionResultSchema.parse(
        await this.adapter.recognize({
          image: input.image,
          signal: input.signal,
        }),
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        'vision_result_invalid',
        '视觉服务返回了无法使用的识别结果，请重试或手动录入',
        502,
      );
    }

    const candidates = modelResult.items.map((item): VisionCandidate => {
      const normalizedName = normalizeName(item.name);
      const matches = this.#findIngredientMatches(normalizedName);
      const ingredient = matches.length === 1 ? matches[0] : undefined;
      const unit = normalizeUnit(item.unit);
      const reasons: VisionConfirmationReason[] = [];
      if (item.confidence < 0.75) {
        reasons.push('low_confidence');
      }
      if (matches.length > 1) {
        reasons.push('ingredient_mapping_ambiguous');
      } else if (ingredient === undefined) {
        reasons.push('ingredient_unmapped');
      }
      if (unit === undefined) {
        reasons.push('unknown_unit');
      }

      return visionCandidateSchema.parse({
        name: ingredient?.canonical_name ?? displayName(item.name),
        quantity: item.quantity,
        unit: unit ?? item.unit,
        confidence: item.confidence,
        ingredientId: ingredient?.id ?? null,
        category: ingredient?.category ?? 'other',
        needsConfirmation: true,
        reasons,
      });
    });

    return this.#drafts.create({
      candidates,
      sessionId: input.sessionId,
    });
  }

  confirm(input: ConfirmVisionInput): ConfirmRecognitionResult {
    const parsed = confirmRecognitionInputSchema.safeParse(input.body);
    if (!parsed.success) {
      throw new AppError(
        'validation_error',
        '确认的食材名称、数量、单位或分类无效',
        400,
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
      > VISION_CONFIRM_MAX_BYTES
    ) {
      throw new AppError(
        'payload_too_large',
        '确认内容过大，请减少食材数量后重试',
        413,
      );
    }
    return this.#drafts.confirm({
      recognitionId: input.recognitionId,
      sessionId: input.sessionId,
      items: parsed.data.items,
    });
  }

  #findIngredientMatches(normalizedName: string): IngredientMatchRow[] {
    if (normalizedName.length === 0) {
      return [];
    }
    return this.db.prepare(`
      SELECT id, canonical_name, category
      FROM ingredients
      WHERE is_active = 1 AND normalized_name = ?
      UNION
      SELECT i.id, i.canonical_name, i.category
      FROM ingredient_aliases a
      JOIN ingredients i ON i.id = a.ingredient_id
      WHERE i.is_active = 1 AND a.normalized_alias = ?
      LIMIT 2
    `).all(normalizedName, normalizedName) as IngredientMatchRow[];
  }
}
