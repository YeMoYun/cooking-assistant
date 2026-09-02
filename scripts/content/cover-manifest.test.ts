import { expect, test } from 'vitest';
import * as coverManifest from './cover-manifest.js';

test('rejects retired Hoto image hosts', () => {
  expect(coverManifest.isRetiredCoverUrl('https://res1.hoto.cn/example.jpg!default')).toBe(true);
  expect(coverManifest.isRetiredCoverUrl('https://images.example.com/dish.jpg')).toBe(false);
});

test('serializes checkpoint writes in the order they were requested', async () => {
  expect(coverManifest.createSerializedCoverManifestWriter).toBeTypeOf('function');
  if (typeof coverManifest.createSerializedCoverManifestWriter !== 'function') return;

  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const completed: number[] = [];
  const writer = coverManifest.createSerializedCoverManifestWriter(async (snapshot: readonly number[]) => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, snapshot[0] === 1 ? 20 : 1));
    completed.push(snapshot[0] ?? 0);
    activeWrites -= 1;
  });

  await Promise.all([writer([1]), writer([2]), writer([3])]);

  expect(maximumActiveWrites).toBe(1);
  expect(completed).toEqual([1, 2, 3]);
});
