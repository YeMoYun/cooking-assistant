import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  noExternal: ['@xiaochu/shared'],
});
