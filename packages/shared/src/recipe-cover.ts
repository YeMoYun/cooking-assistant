import { z } from 'zod';

const httpsCoverUrlSchema = z.string().url().refine(
  (value) => value.toLocaleLowerCase('en-US').startsWith('https://'),
  'URL must use HTTPS',
);

const sameOriginCoverPathSchema = z.string().regex(
  /^\/api\/recipe-covers\/[A-Za-z0-9_-]{1,100}$/u,
  'Cover path must use the same-origin recipe cover endpoint',
);

export const recipeCoverUrlSchema = z.union([
  httpsCoverUrlSchema,
  sameOriginCoverPathSchema,
]);

