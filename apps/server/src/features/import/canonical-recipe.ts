import {
  parseRecipeCatalog,
  recipeCatalogSchema,
  recipeImportSchema,
  type RecipeCatalog,
  type RecipeImport,
} from '@xiaochu/shared';

/** Canonical parsing boundary shared by all server-side recipe import paths. */
export const canonicalizeRecipe = (input: unknown): RecipeImport => recipeImportSchema.parse(input);

/** Validates the complete input set so duplicate source keys fail before persistence. */
export const canonicalizeRecipeCatalog = (input: unknown): RecipeCatalog => parseRecipeCatalog(input);

export const safeCanonicalizeRecipe = (input: unknown) => recipeImportSchema.safeParse(input);

export const safeCanonicalizeRecipeCatalog = (input: unknown) => recipeCatalogSchema.safeParse(input);

export type { RecipeCatalog, RecipeImport };
