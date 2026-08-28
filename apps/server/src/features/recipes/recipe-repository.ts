import {
  AppError,
  favoriteMutationResultSchema,
  favoriteRecipePageSchema,
  recentRecipeListSchema,
  recentViewMutationResultSchema,
  recipeDetailSchema,
  recipeNoteSchema,
  type CreateRecipeNoteInput,
  type FavoriteRecipePage,
  type RecentRecipeList,
  type RecipeDetail,
  type RecipeNote,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';

type RecipeTier = 'standard' | 'video' | 'detailed';
type Difficulty = 'easy' | 'medium' | 'hard';

interface RecipeRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly tier: RecipeTier;
  readonly difficulty: Difficulty;
  readonly servings: number;
  readonly prep_minutes: number;
  readonly cook_minutes: number;
  readonly cover_remote_url: string | null;
  readonly cover_alt: string;
  readonly is_favorite: number;
}

interface IngredientRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly category: 'produce' | 'meat_egg_dairy' | 'staple' | 'seasoning' | 'other';
  readonly quantity: number;
  readonly unit: string;
  readonly is_optional: number;
  readonly note: string | null;
}

interface StepRow {
  readonly id: string;
  readonly step_number: number;
  readonly instruction: string;
  readonly duration_seconds_min: number | null;
  readonly duration_seconds_max: number | null;
  readonly heat_or_device: string | null;
  readonly completion_cue: string | null;
  readonly common_mistake: string | null;
  readonly safety_requirement: string | null;
}

interface StepIngredientRow {
  readonly recipe_step_id: string;
  readonly canonical_name: string;
}

interface MediaRow {
  readonly id: string;
  readonly kind: 'html5' | 'iframe' | 'external';
  readonly url: string;
  readonly provider: string;
  readonly poster_url: string | null;
  readonly health_status: 'unchecked' | 'healthy' | 'degraded' | 'unavailable';
  readonly last_checked_at: string | null;
}

interface TagRow {
  readonly tag_kind: 'tag' | 'taste' | 'technique';
  readonly value: string;
}

interface NoteRow {
  readonly id: string;
  readonly recipe_id: string;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CollectionRow {
  readonly recipe_id: string;
  readonly title: string;
  readonly summary: string;
  readonly cover_url: string | null;
  readonly total_minutes: number;
  readonly difficulty: Difficulty;
  readonly tier: RecipeTier;
  readonly has_video: number;
  readonly event_at: string;
}

interface FavoriteCursor {
  readonly favoritedAt: string;
  readonly recipeId: string;
}

const recipeNotFound = (): AppError => new AppError(
  'recipe_not_found',
  '食谱不存在',
  404,
);

const noteNotFound = (): AppError => new AppError(
  'note_not_found',
  '笔记不存在',
  404,
);

const mapNote = (row: NoteRow): RecipeNote => recipeNoteSchema.parse({
  id: row.id,
  recipeId: row.recipe_id,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapCollectionCard = (row: CollectionRow) => ({
  id: row.recipe_id,
  title: row.title,
  summary: row.summary,
  ...(row.cover_url === null ? {} : { coverUrl: row.cover_url }),
  totalMinutes: row.total_minutes,
  difficulty: row.difficulty,
  tier: row.tier,
  hasVideo: row.has_video === 1,
});

const encodeFavoriteCursor = (cursor: FavoriteCursor): string => Buffer.from(
  JSON.stringify(cursor),
  'utf8',
).toString('base64url');

const decodeFavoriteCursor = (value: string): FavoriteCursor => {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof decoded !== 'object'
      || decoded === null
      || Array.isArray(decoded)
      || Object.keys(decoded).length !== 2
      || !('favoritedAt' in decoded)
      || typeof decoded.favoritedAt !== 'string'
      || Number.isNaN(Date.parse(decoded.favoritedAt))
      || !('recipeId' in decoded)
      || typeof decoded.recipeId !== 'string'
      || decoded.recipeId.length < 1
      || decoded.recipeId.length > 100
    ) {
      throw new TypeError('Invalid cursor shape');
    }
    return {
      favoritedAt: decoded.favoritedAt,
      recipeId: decoded.recipeId,
    };
  } catch {
    throw new AppError('validation_error', '收藏游标无效', 400);
  }
};

export class RecipeRepository {
  constructor(private readonly db: Database.Database) {}

  getRecipeDetail(recipeId: string): RecipeDetail {
    const read = this.db.transaction(() => {
      const recipe = this.db.prepare(`
        SELECT
          r.id, r.title, r.summary, r.tier, r.difficulty, r.servings,
          r.prep_minutes, r.cook_minutes, r.cover_remote_url, r.cover_alt,
          CASE WHEN f.recipe_id IS NULL THEN 0 ELSE 1 END AS is_favorite
        FROM recipes r
        LEFT JOIN favorites f ON f.recipe_id = r.id
        WHERE r.id = ? AND r.is_active = 1
      `).get(recipeId) as RecipeRow | undefined;
      if (recipe === undefined) {
        throw recipeNotFound();
      }

      const ingredients = this.db.prepare(`
        SELECT
          ri.id, i.canonical_name, i.category, ri.quantity, ri.unit,
          ri.is_optional, ri.note
        FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = ?
        ORDER BY ri.position ASC, ri.id ASC
      `).all(recipeId) as IngredientRow[];
      const steps = this.db.prepare(`
        SELECT
          id, step_number, instruction, duration_seconds_min,
          duration_seconds_max, heat_or_device, completion_cue,
          common_mistake, safety_requirement
        FROM recipe_steps
        WHERE recipe_id = ?
        ORDER BY step_number ASC, id ASC
      `).all(recipeId) as StepRow[];
      const stepIngredientRows = this.db.prepare(`
        SELECT rsi.recipe_step_id, i.canonical_name
        FROM recipe_step_ingredients rsi
        JOIN recipe_steps rs
          ON rs.id = rsi.recipe_step_id AND rs.recipe_id = rsi.recipe_id
        JOIN recipe_ingredients ri
          ON ri.id = rsi.recipe_ingredient_id AND ri.recipe_id = rsi.recipe_id
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE rsi.recipe_id = ?
        ORDER BY rs.step_number ASC, rsi.position ASC, ri.id ASC
      `).all(recipeId) as StepIngredientRow[];
      const tags = this.db.prepare(`
        SELECT tag_kind, value
        FROM recipe_tags
        WHERE recipe_id = ?
        ORDER BY tag_kind ASC, position ASC, id ASC
      `).all(recipeId) as TagRow[];
      const notes = this.db.prepare(`
        SELECT id, recipe_id, body, created_at, updated_at
        FROM notes
        WHERE recipe_id = ?
        ORDER BY updated_at DESC, id ASC
      `).all(recipeId) as NoteRow[];
      const media = recipe.tier === 'standard'
        ? []
        : this.db.prepare(`
          SELECT
            id, kind, url, provider, poster_url, health_status,
            last_checked_at
          FROM recipe_media
          WHERE recipe_id = ? AND is_active = 1
          ORDER BY position ASC, id ASC
        `).all(recipeId) as MediaRow[];

      const ingredientNamesByStep = new Map<string, string[]>();
      for (const row of stepIngredientRows) {
        const names = ingredientNamesByStep.get(row.recipe_step_id) ?? [];
        names.push(row.canonical_name);
        ingredientNamesByStep.set(row.recipe_step_id, names);
      }

      const base = {
        id: recipe.id,
        title: recipe.title,
        summary: recipe.summary,
        difficulty: recipe.difficulty,
        servings: recipe.servings,
        prepMinutes: recipe.prep_minutes,
        cookMinutes: recipe.cook_minutes,
        totalMinutes: recipe.prep_minutes + recipe.cook_minutes,
        cover: { url: recipe.cover_remote_url, alt: recipe.cover_alt },
        favorite: recipe.is_favorite === 1,
        tags: tags.filter((tag) => tag.tag_kind === 'tag').map((tag) => tag.value),
        tastes: tags.filter((tag) => tag.tag_kind === 'taste').map((tag) => tag.value),
        techniques: tags
          .filter((tag) => tag.tag_kind === 'technique')
          .map((tag) => tag.value),
        ingredients: ingredients.map((ingredient) => ({
          id: ingredient.id,
          name: ingredient.canonical_name,
          category: ingredient.category,
          quantity: ingredient.quantity,
          unit: ingredient.unit,
          optional: ingredient.is_optional === 1,
          note: ingredient.note,
        })),
        notes: notes.map(mapNote),
      };
      const standardSteps = steps.map((step) => ({
        id: step.id,
        number: step.step_number,
        instruction: step.instruction,
        ingredientNames: ingredientNamesByStep.get(step.id) ?? [],
      }));

      if (recipe.tier === 'standard') {
        return recipeDetailSchema.parse({
          ...base,
          tier: 'standard',
          steps: standardSteps,
        });
      }

      const publicMedia = media.map((item) => ({
        id: item.id,
        kind: item.kind,
        provider: item.provider,
        posterUrl: item.poster_url,
        health: {
          healthStatus: item.health_status,
          lastCheckedAt: item.last_checked_at,
        },
        ...(item.kind === 'iframe'
          ? { embedUrl: item.url }
          : { url: item.url }),
      }));
      if (recipe.tier === 'video') {
        return recipeDetailSchema.parse({
          ...base,
          tier: 'video',
          media: publicMedia,
          steps: standardSteps,
        });
      }

      return recipeDetailSchema.parse({
        ...base,
        tier: 'detailed',
        media: publicMedia,
        steps: steps.map((step) => ({
          id: step.id,
          number: step.step_number,
          instruction: step.instruction,
          ingredientNames: ingredientNamesByStep.get(step.id) ?? [],
          durationSecondsMin: step.duration_seconds_min,
          durationSecondsMax: step.duration_seconds_max,
          heatOrDevice: step.heat_or_device,
          completionCue: step.completion_cue,
          commonMistake: step.common_mistake,
          safetyRequirement: step.safety_requirement,
        })),
      });
    });

    return read.deferred();
  }

  setFavorite(recipeId: string, favorite: boolean, now: string) {
    const mutate = this.db.transaction(() => {
      this.assertActiveRecipe(recipeId);
      if (favorite) {
        this.db.prepare(`
          INSERT INTO favorites(recipe_id, created_at)
          VALUES (?, ?)
          ON CONFLICT(recipe_id) DO NOTHING
        `).run(recipeId, now);
      } else {
        this.db.prepare('DELETE FROM favorites WHERE recipe_id = ?').run(recipeId);
      }
      return favoriteMutationResultSchema.parse({ recipeId, favorite });
    });
    return mutate.immediate();
  }

  listFavorites(cursorValue: string | undefined, limit: number): FavoriteRecipePage {
    const cursor = cursorValue === undefined
      ? undefined
      : decodeFavoriteCursor(cursorValue);
    const rows = this.db.prepare(`
      SELECT
        r.id AS recipe_id, r.title, r.summary,
        r.cover_remote_url AS cover_url,
        r.prep_minutes + r.cook_minutes AS total_minutes,
        r.difficulty, r.tier,
        CASE WHEN EXISTS (
          SELECT 1 FROM recipe_media m
          WHERE m.recipe_id = r.id AND m.is_active = 1
            AND m.kind IN ('html5', 'iframe')
        ) THEN 1 ELSE 0 END AS has_video,
        f.created_at AS event_at
      FROM favorites f
      JOIN recipes r ON r.id = f.recipe_id
      WHERE r.is_active = 1
        AND (
          @cursor_at IS NULL
          OR f.created_at < @cursor_at
          OR (f.created_at = @cursor_at AND f.recipe_id < @cursor_id)
        )
      ORDER BY f.created_at DESC, f.recipe_id DESC
      LIMIT @row_limit
    `).all({
      cursor_at: cursor?.favoritedAt ?? null,
      cursor_id: cursor?.recipeId ?? null,
      row_limit: limit + 1,
    }) as CollectionRow[];
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);

    return favoriteRecipePageSchema.parse({
      items: pageRows.map((row) => ({
        ...mapCollectionCard(row),
        favoritedAt: row.event_at,
      })),
      nextCursor: hasNextPage && lastRow !== undefined
        ? encodeFavoriteCursor({
          favoritedAt: lastRow.event_at,
          recipeId: lastRow.recipe_id,
        })
        : null,
    });
  }

  listRecentViews(limit: number): RecentRecipeList {
    const rows = this.db.prepare(`
      SELECT
        r.id AS recipe_id, r.title, r.summary,
        r.cover_remote_url AS cover_url,
        r.prep_minutes + r.cook_minutes AS total_minutes,
        r.difficulty, r.tier,
        CASE WHEN EXISTS (
          SELECT 1 FROM recipe_media m
          WHERE m.recipe_id = r.id AND m.is_active = 1
            AND m.kind IN ('html5', 'iframe')
        ) THEN 1 ELSE 0 END AS has_video,
        rv.last_viewed_at AS event_at
      FROM recent_views rv
      JOIN recipes r ON r.id = rv.recipe_id
      WHERE r.is_active = 1
      ORDER BY rv.last_viewed_at DESC, rv.recipe_id DESC
      LIMIT ?
    `).all(limit) as CollectionRow[];

    return recentRecipeListSchema.parse({
      items: rows.map((row) => ({
        ...mapCollectionCard(row),
        lastViewedAt: row.event_at,
      })),
    });
  }

  recordRecentView(recipeId: string, now: string) {
    const mutate = this.db.transaction(() => {
      this.assertActiveRecipe(recipeId);
      this.db.prepare(`
        INSERT INTO recent_views(recipe_id, last_viewed_at, view_count)
        VALUES (?, ?, 1)
        ON CONFLICT(recipe_id) DO UPDATE SET
          last_viewed_at = excluded.last_viewed_at
      `).run(recipeId, now);
      return recentViewMutationResultSchema.parse({
        recipeId,
        lastViewedAt: now,
      });
    });
    return mutate.immediate();
  }

  createNote(input: CreateRecipeNoteInput, now: string): RecipeNote {
    const mutate = this.db.transaction(() => {
      this.assertActiveRecipe(input.recipeId);
      const existing = this.getNoteRow(input.noteId);
      if (existing !== undefined) {
        if (
          existing.recipe_id !== input.recipeId
          || existing.body !== input.body
        ) {
          throw new AppError(
            'note_id_conflict',
            '笔记标识已被其他内容使用',
            409,
          );
        }
        return mapNote(existing);
      }

      this.db.prepare(`
        INSERT INTO notes(id, recipe_id, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.noteId, input.recipeId, input.body, now, now);
      const created = this.getNoteRow(input.noteId);
      if (created === undefined) {
        throw new Error('Created note could not be read back');
      }
      return mapNote(created);
    });
    return mutate.immediate();
  }

  updateNote(noteId: string, body: string, now: string): RecipeNote {
    const mutate = this.db.transaction(() => {
      const existing = this.getNoteRow(noteId);
      if (existing === undefined) {
        throw noteNotFound();
      }
      if (existing.body === body) {
        return mapNote(existing);
      }
      this.db.prepare(`
        UPDATE notes SET body = ?, updated_at = ? WHERE id = ?
      `).run(body, now, noteId);
      const updated = this.getNoteRow(noteId);
      if (updated === undefined) {
        throw noteNotFound();
      }
      return mapNote(updated);
    });
    return mutate.immediate();
  }

  deleteNote(noteId: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  }

  private assertActiveRecipe(recipeId: string): void {
    const row = this.db.prepare(`
      SELECT 1 FROM recipes WHERE id = ? AND is_active = 1
    `).get(recipeId);
    if (row === undefined) {
      throw recipeNotFound();
    }
  }

  private getNoteRow(noteId: string): NoteRow | undefined {
    return this.db.prepare(`
      SELECT id, recipe_id, body, created_at, updated_at
      FROM notes WHERE id = ?
    `).get(noteId) as NoteRow | undefined;
  }
}
