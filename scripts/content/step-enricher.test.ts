import { expect, test } from 'vitest';
import { classifyStepAction, enrichRecipeStep, parseDurationSeconds } from './step-enricher.js';

const eggIngredient = {
  canonicalName: '鸡蛋',
  aliases: ['蛋'],
  category: 'meat_egg_dairy' as const,
  quantity: 2,
  unit: '个',
  optional: false,
};

test('将普通的煮制指令识别为煮', () => {
  expect(classifyStepAction('加入鸡蛋煮两三分钟')).toBe('boil');
});

test('识别中文相邻数字表达的时间范围', () => {
  expect(parseDurationSeconds('煮两三分钟')).toEqual([120, 180]);
});

test('鸡蛋步骤只添加蛋类熟度标准', () => {
  const step = enrichRecipeStep({
    instruction: '加入鸡蛋煮两三分钟',
    number: 1,
    ingredients: [eggIngredient],
  });

  expect(step.completionCue).toContain('蛋液应完全凝固');
  expect(step.completionCue).not.toContain('肉类切开');
});
