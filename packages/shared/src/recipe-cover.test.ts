import { expect, test } from 'vitest';
import { recipeCoverUrlSchema } from './recipe-cover.js';

test('accepts the same-origin recipe cover endpoint', () => {
  expect(recipeCoverUrlSchema.parse(
    '/api/recipe-covers/recipe_0005297474f93644e9e0e8036572cb2b',
  )).toBe('/api/recipe-covers/recipe_0005297474f93644e9e0e8036572cb2b');
});

