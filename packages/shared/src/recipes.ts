import { z } from 'zod';

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const HTML_ELEMENT = /<\/?[a-z][^<>]*>/giu;
const HTML5_VIDEO_EXTENSION = /\.(?:mp4|webm|ogv|ogg)$/iu;

const decodeHtmlEntities = (value: string): string => value.replace(
  /&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/giu,
  (entity) => {
    const named: Readonly<Record<string, string>> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&nbsp;': ' ',
    };
    const lower = entity.toLowerCase();
    const namedValue = named[lower];
    if (namedValue !== undefined) {
      return namedValue;
    }

    const isHex = lower.startsWith('&#x');
    const digits = lower.slice(isHex ? 3 : 2, -1);
    const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
    if (
      !Number.isInteger(codePoint)
      || codePoint < 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  },
);

/** Converts imported display text to canonical plain text. */
export const normalizeRecipeText = (value: string): string => decodeHtmlEntities(value)
  .replace(HTML_COMMENT, ' ')
  .replace(HTML_ELEMENT, ' ')
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim();

const canonicalText = (maximumLength: number, minimumLength = 1) => z.string()
  .superRefine((value, context) => {
    const decoded = decodeHtmlEntities(value);
    if (FORBIDDEN_CONTROL_CHARACTERS.test(decoded)) {
      context.addIssue({
        code: 'custom',
        message: 'Text contains forbidden control characters',
      });
    }
  })
  .transform(normalizeRecipeText)
  .pipe(z.string().min(minimumLength).max(maximumLength));

const httpsUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    context.addIssue({
      code: 'custom',
      message: 'Remote URLs must use HTTPS and must not contain credentials',
    });
  }
}).transform((value) => {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
});

export const iframeProviderAllowlist = {
  youtube: {
    canonicalHost: 'www.youtube-nocookie.com',
    inputHosts: [
      'www.youtube-nocookie.com',
      'youtube-nocookie.com',
      'www.youtube.com',
      'youtube.com',
      'youtu.be',
    ],
  },
  bilibili: {
    canonicalHost: 'player.bilibili.com',
    inputHosts: [
      'player.bilibili.com',
      'www.bilibili.com',
      'bilibili.com',
    ],
  },
} as const;

export type IframeProvider = keyof typeof iframeProviderAllowlist;

const normalizeYouTubeIframe = (url: URL): string | undefined => {
  const host = url.hostname.toLowerCase();
  let videoId: string | undefined;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0];
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v') ?? undefined;
  } else {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'embed') {
      videoId = segments[1];
    }
  }
  if (videoId === undefined || !/^[\w-]{6,20}$/u.test(videoId)) {
    return undefined;
  }

  const normalized = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  const start = url.searchParams.get('start');
  if (start !== null && /^\d{1,7}$/u.test(start)) {
    normalized.searchParams.set('start', String(Number(start)));
  }
  return normalized.toString();
};

const normalizeBilibiliIframe = (url: URL): string | undefined => {
  const host = url.hostname.toLowerCase();
  let bvid = url.searchParams.get('bvid') ?? undefined;
  let aid = url.searchParams.get('aid') ?? undefined;
  const cid = url.searchParams.get('cid') ?? undefined;
  const page = url.searchParams.get('page') ?? url.searchParams.get('p') ?? undefined;

  if (host !== 'player.bilibili.com') {
    const videoMatch = /^\/video\/(BV[\da-z]+)\/?$/iu.exec(url.pathname);
    bvid = videoMatch?.[1];
    aid = undefined;
  }

  const hasBvid = bvid !== undefined && /^BV[\da-z]{8,20}$/iu.test(bvid);
  const hasAid = aid !== undefined && /^\d{1,20}$/u.test(aid);
  const hasCid = cid !== undefined && /^\d{1,20}$/u.test(cid);
  if (!hasBvid && !(hasAid && hasCid)) {
    return undefined;
  }

  const normalized = new URL('https://player.bilibili.com/player.html');
  if (hasBvid) {
    normalized.searchParams.set('bvid', bvid as string);
  } else {
    normalized.searchParams.set('aid', aid as string);
    normalized.searchParams.set('cid', cid as string);
  }
  if (page !== undefined && /^\d{1,4}$/u.test(page) && Number(page) > 0) {
    normalized.searchParams.set('page', String(Number(page)));
  }
  normalized.searchParams.set('high_quality', '1');
  normalized.searchParams.set('danmaku', '0');
  return normalized.toString();
};

/** Returns a safe canonical embed URL only for a provider/host pair on the fixed allowlist. */
export const normalizeIframeUrl = (
  provider: string,
  input: string,
): string | undefined => {
  if (!(provider in iframeProviderAllowlist)) {
    return undefined;
  }
  const typedProvider = provider as IframeProvider;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const rule = iframeProviderAllowlist[typedProvider];
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || !(rule.inputHosts as readonly string[]).includes(url.hostname.toLowerCase())
  ) {
    return undefined;
  }
  return typedProvider === 'youtube'
    ? normalizeYouTubeIframe(url)
    : normalizeBilibiliIframe(url);
};

export const isPlayableHtml5MediaUrl = (value: string): boolean => {
  const url = new URL(value);
  return url.protocol === 'https:' && HTML5_VIDEO_EXTENSION.test(url.pathname);
};

const html5MediaSchema = z.object({
  kind: z.literal('html5'),
  url: httpsUrlSchema,
  provider: canonicalText(50),
  posterUrl: httpsUrlSchema.optional(),
}).strict();

const iframeMediaSchema = z.object({
  kind: z.literal('iframe'),
  url: httpsUrlSchema,
  provider: canonicalText(50),
  posterUrl: httpsUrlSchema.optional(),
}).strict().transform((media, context) => {
  const provider = media.provider.toLowerCase();
  const normalizedUrl = normalizeIframeUrl(provider, media.url);
  if (normalizedUrl === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'Iframe provider and URL are not on the fixed embed allowlist',
    });
    return z.NEVER;
  }
  return { ...media, provider: provider as IframeProvider, url: normalizedUrl };
});

const externalMediaSchema = z.object({
  kind: z.literal('external'),
  url: httpsUrlSchema,
  provider: canonicalText(50),
  posterUrl: httpsUrlSchema.optional(),
}).strict();

export const recipeMediaSchema = z.union([
  html5MediaSchema,
  iframeMediaSchema,
  externalMediaSchema,
]);

const ingredientSchema = z.object({
  canonicalName: canonicalText(80),
  aliases: z.array(canonicalText(80)).max(20),
  category: z.enum(['produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other']),
  quantity: z.number().finite().positive(),
  unit: canonicalText(20),
  optional: z.boolean(),
  note: canonicalText(200).optional(),
}).strict();

const stepSchema = z.object({
  number: z.number().int().positive(),
  instruction: canonicalText(2000),
  ingredientNames: z.array(canonicalText(80)).max(30),
  durationSecondsMin: z.number().int().positive().optional(),
  durationSecondsMax: z.number().int().positive().optional(),
  heatOrDevice: canonicalText(200).optional(),
  completionCue: canonicalText(500).optional(),
  commonMistake: canonicalText(500).optional(),
  safetyRequirement: canonicalText(500).optional(),
}).strict();

const identityKey = (value: string): string => value.toLocaleLowerCase('zh-CN');

export const recipeImportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKey: canonicalText(200),
  contentVersion: canonicalText(50),
  title: canonicalText(100),
  aliases: z.array(canonicalText(100)).max(30),
  summary: canonicalText(500),
  tier: z.enum(['standard', 'video', 'detailed']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  servings: z.number().finite().positive(),
  prepMinutes: z.number().int().nonnegative(),
  cookMinutes: z.number().int().positive(),
  taste: z.array(canonicalText(50)).max(10),
  techniques: z.array(canonicalText(50)).max(10),
  tags: z.array(canonicalText(50)).max(30),
  cover: z.object({
    remoteUrl: httpsUrlSchema.optional(),
    alt: canonicalText(200),
  }).strict(),
  media: z.array(recipeMediaSchema).max(5),
  ingredients: z.array(ingredientSchema).min(1),
  steps: z.array(stepSchema).min(1),
}).strict().superRefine((recipe, context) => {
  const recipeNames = new Set<string>();
  for (const [index, name] of [recipe.title, ...recipe.aliases].entries()) {
    const key = identityKey(name);
    if (recipeNames.has(key)) {
      context.addIssue({
        code: 'custom',
        path: index === 0 ? ['title'] : ['aliases', index - 1],
        message: 'Recipe title and aliases must be unique after normalization',
      });
    }
    recipeNames.add(key);
  }

  const ingredientNames = new Map<string, number>();
  recipe.ingredients.forEach((ingredient, ingredientIndex) => {
    [ingredient.canonicalName, ...ingredient.aliases].forEach((name, aliasIndex) => {
      const key = identityKey(name);
      const existingIndex = ingredientNames.get(key);
      if (existingIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: aliasIndex === 0
            ? ['ingredients', ingredientIndex, 'canonicalName']
            : ['ingredients', ingredientIndex, 'aliases', aliasIndex - 1],
          message: `Ingredient name collides with ingredient ${existingIndex + 1}`,
        });
      } else {
        ingredientNames.set(key, ingredientIndex);
      }
    });
  });

  recipe.steps.forEach((step, stepIndex) => {
    if (step.number !== stepIndex + 1) {
      context.addIssue({
        code: 'custom',
        path: ['steps', stepIndex, 'number'],
        message: 'Step numbers must be contiguous and start at 1',
      });
    }
    const hasMinimum = step.durationSecondsMin !== undefined;
    const hasMaximum = step.durationSecondsMax !== undefined;
    if (hasMinimum !== hasMaximum) {
      context.addIssue({
        code: 'custom',
        path: ['steps', stepIndex, 'durationSecondsMax'],
        message: 'Step duration minimum and maximum must be supplied together',
      });
    } else if (
      step.durationSecondsMin !== undefined
      && step.durationSecondsMax !== undefined
      && step.durationSecondsMin > step.durationSecondsMax
    ) {
      context.addIssue({
        code: 'custom',
        path: ['steps', stepIndex, 'durationSecondsMax'],
        message: 'Step duration maximum cannot be less than the minimum',
      });
    }

    const stepIngredients = new Set<string>();
    step.ingredientNames.forEach((name, referenceIndex) => {
      const key = identityKey(name);
      if (!ingredientNames.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', stepIndex, 'ingredientNames', referenceIndex],
          message: 'Step ingredient does not resolve to the declared ingredient list',
        });
      }
      if (stepIngredients.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', stepIndex, 'ingredientNames', referenceIndex],
          message: 'Step ingredient references must be unique',
        });
      }
      stepIngredients.add(key);
    });

    if (recipe.tier === 'detailed') {
      const requiredFields = [
        'durationSecondsMin',
        'durationSecondsMax',
        'heatOrDevice',
        'completionCue',
        'commonMistake',
        'safetyRequirement',
      ] as const;
      requiredFields.forEach((field) => {
        if (step[field] === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['steps', stepIndex, field],
            message: `Detailed recipes require ${field} on every step`,
          });
        }
      });
    }
  });

  if (recipe.tier !== 'standard') {
    const hasPlayableMedia = recipe.media.some((media) => (
      media.kind === 'iframe'
      || (media.kind === 'html5' && isPlayableHtml5MediaUrl(media.url))
    ));
    if (!hasPlayableMedia) {
      context.addIssue({
        code: 'custom',
        path: ['media'],
        message: 'Video and detailed recipes require playable embedded media',
      });
    }
  }
});

export const recipeCatalogSchema = z.array(recipeImportSchema).superRefine((recipes, context) => {
  const sourceKeys = new Set<string>();
  recipes.forEach((recipe, index) => {
    const key = identityKey(recipe.sourceKey);
    if (sourceKeys.has(key)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'sourceKey'],
        message: 'Catalog sourceKey values must be unique',
      });
    }
    sourceKeys.add(key);
  });
});

export const parseRecipeCatalog = (input: unknown): RecipeCatalog => recipeCatalogSchema.parse(input);

export type RecipeMedia = z.infer<typeof recipeMediaSchema>;
export type RecipeImport = z.infer<typeof recipeImportSchema>;
export type RecipeCatalog = z.infer<typeof recipeCatalogSchema>;
