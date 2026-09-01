# Recipe Covers and Detailed Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为全部 10,520 道食谱提供真实食物封面，并把所有步骤升级为含火候、时长、完成标志和必要提醒的可执行文字教程。

**Architecture:** 内容层先从 MIRecipe 原始步骤照片生成可恢复的封面清单，对缺图项执行联网搜索，再通过确定性烹饪规则增强步骤并生成规范化 JSONL。运行时由 Fastify 同源封面路由按需下载、校验、压缩和缓存外部图片；API 对所有食谱层级返回完整步骤指导，React 卡片采用已确认的文字叠图样式。

**Tech Stack:** TypeScript 6、Node.js 24、Zod、Fastify 5、better-sqlite3、undici、sharp、React 19、Vite 8、PowerShell 本地启动器。

**Testing constraint:** 用户明确要求不扩写大量测试案例。本计划只增加必要的内容校验和小范围确定性检查，并以 `npm run typecheck`、`npm run build`、全目录校验及人工抽查作为交付门槛。

---

## 文件结构

### 新建

- `scripts/content/step-enricher.ts`：解析原步骤并生成统一的时间、火候、完成状态、常见错误和安全要求。
- `scripts/content/model-step-enricher.ts`：仅对无法从原文和相邻步骤确定动作的模糊步骤调用已配置模型。
- `scripts/content/cover-manifest.ts`：定义封面清单类型、逐行读取、原子写入与断点续跑规则。
- `scripts/content/build-cover-manifest.ts`：提取原图并为缺图菜执行联网图片搜索和候选验证。
- `packages/shared/src/recipe-cover.ts`：集中定义 HTTPS 源地址和同源封面路径模式，避免详情与搜索模式循环依赖。
- `apps/server/src/features/recipes/recipe-cover-cache.ts`：安全下载、限制大小、压缩和缓存封面。
- `apps/server/src/features/recipes/recipe-cover-routes.ts`：提供同源 `GET /api/recipe-covers/:recipeId`。
- `content/canonical/recipe-covers.jsonl`：10,520 条可重复使用的封面来源记录。

### 修改

- `packages/shared/src/recipes.ts`：要求每个导入步骤具有完整指导字段。
- `packages/shared/src/recipe-detail.ts`：所有食谱层级对外返回完整步骤指导，并允许同源封面路径。
- `packages/shared/src/recipe-search.ts`：允许卡片使用同源封面路径。
- `packages/shared/src/index.ts`：导出共享封面模式。
- `scripts/content/convert-mirecipe.ts`：读取封面清单、调用步骤增强器、提升内容版本。
- `scripts/content/validate-catalog.ts`：校验真实封面覆盖率和完整步骤字段覆盖率。
- `fixtures/recipes/mini-catalog.jsonl`：补齐标准和视频食谱步骤字段。
- `apps/server/src/features/providers/outbound-url-policy.ts`：增加资源 URL 校验入口，复用现有 DNS/私网阻断规则。
- `apps/server/src/features/recipes/search-repository.ts`：把外部封面地址转换为同源封面路由。
- `apps/server/src/features/recipes/recipe-repository.ts`：所有层级返回结构化步骤，并统一生成同源封面地址。
- `apps/server/src/app.ts`：接收封面缓存目录并注册路由。
- `apps/server/src/index.ts`：把 `%LOCALAPPDATA%\XiaoChu\cover-cache` 注入应用。
- `apps/web/src/features/recipes/RecipeCard.tsx`：实现文字叠图卡片。
- `apps/web/src/features/recipes/recipe-catalog.css`：实现渐变、叠加信息、稳定宽高和响应式样式。
- `apps/web/src/features/recipes/RecipeSteps.tsx`：所有食谱展示完整步骤指导。
- `apps/web/src/features/recipes/recipe-detail.css`：优化提示标签、完成状态和安全提醒布局。
- `scripts/content/catalog-status.ts`：报告增强内容版本覆盖数。
- `scripts/start-local.ps1`：旧目录存在时也能在后台导入新版增强食谱。
- `package.json`：增加封面清单和增强目录命令。
- `README.md`：记录生成、启动和人工验收方式。

---

### Task 1: 统一完整步骤与同源封面的数据契约

**Files:**
- Modify: `packages/shared/src/recipes.ts`
- Create: `packages/shared/src/recipe-cover.ts`
- Modify: `packages/shared/src/recipe-detail.ts`
- Modify: `packages/shared/src/recipe-search.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `fixtures/recipes/mini-catalog.jsonl`

- [ ] **Step 1: 将导入步骤的六个指导字段改为必填**

在 `packages/shared/src/recipes.ts` 中把步骤模式定义为：

```ts
const stepSchema = z.object({
  number: z.number().int().positive(),
  instruction: canonicalText(2_000),
  ingredientNames: z.array(canonicalText(80)).max(30),
  durationSecondsMin: z.number().int().positive(),
  durationSecondsMax: z.number().int().positive(),
  heatOrDevice: canonicalText(200),
  completionCue: canonicalText(500),
  commonMistake: canonicalText(500),
  safetyRequirement: canonicalText(500),
}).strict().refine(
  (step) => step.durationSecondsMin <= step.durationSecondsMax,
  {
    path: ['durationSecondsMax'],
    message: 'Maximum duration cannot be less than minimum duration',
  },
);
```

删除“只有 `detailed` 层级才要求完整字段”的条件分支，保留步骤编号、食材引用和时间范围校验。

- [ ] **Step 2: 让所有详情层级复用完整步骤模式**

在 `packages/shared/src/recipe-detail.ts` 中将 `standardRecipeStepSchema` 和 `detailedRecipeStepSchema` 合并为 `recipeStepSchema`。`standardRecipeDetailSchema`、`videoRecipeDetailSchema` 和 `detailedRecipeDetailSchema` 的 `steps` 均使用该模式。

新建 `packages/shared/src/recipe-cover.ts`，避免 `recipe-detail.ts` 与 `recipe-search.ts` 相互导入：

```ts
const sameOriginCoverPathSchema = z.string().regex(
  /^\/api\/recipe-covers\/[A-Za-z0-9_-]{1,140}$/u,
);

export const recipeCoverUrlSchema = z.union([
  z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  sameOriginCoverPathSchema,
]);
```

详情封面 `url` 使用 `recipeCoverUrlSchema.nullable()`；`packages/shared/src/recipe-search.ts` 的 `coverUrl` 使用同一个导出模式。`packages/shared/src/index.ts` 导出 `./recipe-cover.js`。

- [ ] **Step 3: 补齐启动夹具**

为 `fixtures/recipes/mini-catalog.jsonl` 中所有缺失字段的步骤补入以下完整结构，字段内容应按该步骤动作填写，而不是复制空泛句子：

```json
{
  "durationSecondsMin": 60,
  "durationSecondsMax": 120,
  "heatOrDevice": "无需开火，使用砧板和厨刀",
  "completionCue": "食材切配均匀并分别放置。",
  "commonMistake": "切块大小差异过大会导致后续成熟速度不一致。",
  "safetyRequirement": "刀具远离手指，处理生肉后清洗刀具和砧板。"
}
```

- [ ] **Step 4: 执行契约检查**

Run:

```powershell
npm run typecheck -w @xiaochu/shared
```

Expected: shared 工作区类型检查退出 0。全仓检查留到仓储和 UI 完成后执行，避免重复运行已知会受跨任务契约变更影响的检查。

- [ ] **Step 5: 提交数据契约**

```powershell
git add packages/shared/src/recipes.ts packages/shared/src/recipe-cover.ts packages/shared/src/recipe-detail.ts packages/shared/src/recipe-search.ts packages/shared/src/index.ts fixtures/recipes/mini-catalog.jsonl
git commit -m "feat: require actionable guidance for every recipe step"
```

---

### Task 2: 实现确定性的烹饪步骤增强器

**Files:**
- Create: `scripts/content/step-enricher.ts`
- Create: `scripts/content/model-step-enricher.ts`
- Modify: `scripts/content/convert-mirecipe.ts`

- [ ] **Step 1: 定义步骤分析结果和动作分类**

在 `scripts/content/step-enricher.ts` 中导出：

```ts
import type { RecipeImport } from '@xiaochu/shared';

export type RecipeIngredient = RecipeImport['ingredients'][number];
export type EnrichedStep = RecipeImport['steps'][number];

export interface StepEnrichmentInput {
  readonly instruction: string;
  readonly number: number;
  readonly ingredients: readonly RecipeIngredient[];
  readonly previousInstruction?: string;
  readonly nextInstruction?: string;
}

type ActionKind =
  | 'prep' | 'rest' | 'stir-fry' | 'pan-fry' | 'deep-fry'
  | 'boil' | 'stew' | 'steam' | 'bake' | 'serve';
```

动作判定按优先级匹配：`炸`、`煎/烙`、`炒/爆香/翻炒`、`炖/焖/卤`、`蒸`、`烤`、`煮/烧开`、`腌/泡/醒/静置`、`装盘/出锅/享用`，未命中时归为 `prep`。

- [ ] **Step 2: 解析原文已有时长**

支持“30 秒”“1-2 分钟”“半小时”“1 小时左右”“十分钟”等常见中文表达。解析结果优先于默认规则，并限制在 10 秒到 8 小时范围内。默认时间表：

```ts
const DEFAULT_DURATION_SECONDS = {
  prep: [60, 300],
  rest: [600, 1_800],
  'stir-fry': [60, 180],
  'pan-fry': [120, 300],
  'deep-fry': [180, 360],
  boil: [300, 900],
  stew: [1_800, 5_400],
  steam: [600, 1_800],
  bake: [900, 1_800],
  serve: [30, 60],
} as const;
```

- [ ] **Step 3: 生成火候、完成状态、错误和安全要求**

规则必须至少覆盖：

```ts
const GUIDANCE = {
  prep: {
    heat: '无需开火，使用合适的备料工具',
    cue: '食材处理到原步骤要求的大小和状态，并分别放置。',
    mistake: '切配大小差异过大会让后续成熟速度不一致。',
    safety: '刀具远离手指；接触生肉后清洗双手、刀具和砧板。',
  },
  'stir-fry': {
    heat: '燃气灶中大火，炒锅',
    cue: '食材受热均匀、香气明显，水汽减少且没有焦黑。',
    mistake: '锅温不足或一次放入过多食材会大量出水，影响香味和口感。',
    safety: '食材下锅前沥干表面水分，避免热油飞溅。',
  },
  'deep-fry': {
    heat: '中火，油温约 160–180°C',
    cue: '表面颜色均匀金黄，内部完全熟透。',
    mistake: '油温过低会吸油，油温过高会外焦里生。',
    safety: '锅内油量不超过锅深的一半，带水食材不得直接下油锅。',
  },
} as const;
```

其余动作使用以下明确规则：

| 动作 | 火候/设备 | 默认完成状态 | 主要错误 | 安全要求 |
|---|---|---|---|---|
| `pan-fry` | 中小火，平底锅 | 两面均匀上色，中心达到对应食材熟度 | 火过大导致外焦里生 | 翻面时避免油滴飞溅 |
| `boil` | 大火烧开后转中火 | 液体稳定沸腾，食材达到原步骤要求的软硬度 | 全程大火使汤汁浑浊或溢锅 | 锅盖留缝并防止蒸汽烫伤 |
| `stew` | 烧开后小火保持微沸 | 汤汁浓缩、食材软熟但不散碎 | 沸腾过猛造成肉柴和汤汁过快蒸发 | 中途检查液面，避免干烧 |
| `steam` | 蒸锅上汽后大火或中大火 | 中心熟透且表面没有生粉或血水 | 冷水入锅后直接计时造成时间不足 | 开盖时让蒸汽朝远离身体方向散出 |
| `bake` | 烤箱预热至 180°C | 表面均匀上色，中心熟透 | 未预热或频繁开门导致受热不均 | 使用隔热手套并远离加热管 |
| `rest` | 无需开火，按原文要求室温或冷藏 | 达到入味、泡软、醒发或冷却状态 | 静置不足或环境温度错误 | 肉类腌制超过 20 分钟时冷藏 |
| `serve` | 无需开火，使用洁净餐具 | 装盘完整且无多余汤水污染台面 | 放置过久影响温度和口感 | 热菜使用隔热工具，生熟餐具分开 |

肉、禽、蛋步骤额外覆盖内部熟度；木耳和含水食材覆盖沥水防溅；烤制步骤必须包含预热。

- [ ] **Step 4: 扩写自然语言 instruction**

原文已经包含火候和时间时不重复。缺失时在原句后追加一条自然句：

```ts
const instruction = hasExplicitHeatAndDuration
  ? normalizedOriginal
  : action === 'prep' || action === 'serve'
    ? `${normalizedOriginal} 这一步约需 ${durationText}，${completionCue}`
    : `${normalizedOriginal} 使用${heatOrDevice}操作 ${durationText}，${completionCue}`;
```

最终文本先去除重复句号和空白，再限制为 2,000 字符。

- [ ] **Step 5: 实现模糊步骤模型补写器**

在 `scripts/content/model-step-enricher.ts` 中定义 `needsModelEnrichment`：原文去除标点后少于 4 个字符，或未识别出动作且没有命中任何食材时返回 `true`。该文件复用 `ProviderRepository`、`JsonModelClient` 和 `DpapiSecretStore`，通过可选 `--provider-id` 读取用户已经在应用中保存并测试过的 DeepSeek/OpenAI 兼容文本模型；不得从命令行接收明文 API Key。

模型只返回一个步骤对象，解析模式固定为：

```ts
const modelStepSchema = z.object({
  instruction: z.string().min(8).max(2_000),
  durationSecondsMin: z.number().int().min(10).max(28_800),
  durationSecondsMax: z.number().int().min(10).max(28_800),
  heatOrDevice: z.string().min(2).max(200),
  completionCue: z.string().min(4).max(500),
  commonMistake: z.string().min(4).max(500),
  safetyRequirement: z.string().min(4).max(500),
}).strict().refine(
  (step) => step.durationSecondsMin <= step.durationSecondsMax,
  { path: ['durationSecondsMax'], message: 'Invalid duration range' },
);
```

提示词只提供原步骤、相邻步骤和已声明食材，并明确禁止新增食材、改变顺序或臆造设备。模型结果再次经过食材名称和食品安全规则检查。未提供 `--provider-id` 时使用确定性规则结果并在转换报告记录 `modelSkipped`；提供后只处理 `needsModelEnrichment` 返回 `true` 的步骤。

- [ ] **Step 6: 接入 MIRecipe 转换器**

在 `scripts/content/convert-mirecipe.ts` 中：

- 将 `contentVersion` 提升为 `mirecipe-rich2`。
- 在构造 `steps` 时调用 `enrichRecipeStep`。
- 通过步骤文本与食材名称的规范化包含关系填充 `ingredientNames`。
- 保留原步骤编号和顺序。

核心映射：

```ts
steps: instructions.map((step, index) => enrichRecipeStep({
  instruction: text(step.description),
  number: index + 1,
  ingredients,
  previousInstruction: index > 0
    ? text(instructions[index - 1]?.description)
    : undefined,
  nextInstruction: index + 1 < instructions.length
    ? text(instructions[index + 1]?.description)
    : undefined,
  })),
```

- [ ] **Step 7: 对小样执行确定性检查**

Run:

```powershell
npx tsx scripts/content/convert-mirecipe.ts --input content/raw/mirecipe/recipeData-new1.json --output content/reports/recipes-rich-preview.jsonl --report content/reports/mirecipe-rich-conversion.json
Get-Content content/reports/recipes-rich-preview.jsonl -TotalCount 3
```

Expected: 输出至少 10,000 条；前三条每个步骤都包含六个指导字段，原步骤顺序不变。

- [ ] **Step 8: 提交步骤增强器**

```powershell
git add scripts/content/step-enricher.ts scripts/content/model-step-enricher.ts scripts/content/convert-mirecipe.ts
git commit -m "feat: enrich every recipe step with cooking guidance"
```

---

### Task 3: 建立真实封面清单并自动补齐缺图食谱

**Files:**
- Create: `scripts/content/cover-manifest.ts`
- Create: `scripts/content/build-cover-manifest.ts`
- Create: `content/canonical/recipe-covers.jsonl`
- Modify: `apps/server/src/features/providers/outbound-url-policy.ts`
- Modify: `scripts/content/convert-mirecipe.ts`
- Modify: `package.json`

- [ ] **Step 1: 定义可恢复封面记录**

`scripts/content/cover-manifest.ts` 使用以下严格结构：

```ts
import { z } from 'zod';

export const coverManifestRowSchema = z.object({
  sourceKey: z.string().min(1).max(200),
  title: z.string().min(1).max(100),
  url: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  source: z.enum(['mirecipe', 'mirecipe-title-match', 'openverse']),
  matchedTerms: z.array(z.string().min(1).max(80)).min(1).max(10),
  checkedAt: z.string().datetime({ offset: true }),
}).strict();

export type CoverManifestRow = z.infer<typeof coverManifestRowSchema>;
```

读入现有清单时按 `sourceKey` 去重；每成功一条就追加并刷新，重新运行时跳过已完成项。最终按原食谱顺序原子写入正式清单。

- [ ] **Step 2: 提取 9,722 道原食谱实拍图**

`build-cover-manifest.ts` 先读取当前 `content/canonical/recipes.jsonl`，以其中恰好 10,520 个 `sourceKey` 作为允许列表，再从原始 MIRecipe 数据读取对应记录。对允许列表中的记录读取 `instructions[].imgLink`，过滤非 HTTPS、空值和无法解析的 URL，选择最后一张有效图片。记录 `source: 'mirecipe'`，并把菜名作为 `matchedTerms`。这样不会把原始数据中被转换器拒绝的 46 条记录写进封面清单。

- [ ] **Step 3: 优先复用同名菜的原始实拍图**

对没有自身图片的食谱，先以 NFKC、去标点、去空格后的完整标题查找其他 MIRecipe 记录。只有标题完全一致且候选记录存在有效图片时，才复用其最后一张实拍图，并记录 `source: 'mirecipe-title-match'`。不使用模糊标题复用，避免把“红烧肉”和“笋干红烧肉”混为一张图。

- [ ] **Step 4: 为剩余缺图项查询官方 Openverse 图片搜索**

使用 Openverse 官方公开图片搜索 API；官方文档确认 `/v1/images/` 支持 `q` 查询且可使用未认证客户端。请求：

```ts
const endpoint = new URL('https://api.openverse.org/v1/images/');
endpoint.searchParams.set('q', `"${title}" ${mainIngredients.join(' ')}`);
endpoint.searchParams.set('page_size', '50');
endpoint.searchParams.set('mature', 'false');
```

请求设置 10 秒超时、最多 3 次指数退避重试和明确 User-Agent。遇到 429 时读取限流响应头并延迟后重试。候选读取 `title`、`tags`、`thumbnail`、`url`、`width` 和 `height`；优先使用 `thumbnail`，否则使用 `url`。

参考：`https://docs.openverse.org/packages/js/api_client/index.html` 与 `https://docs.openverse.org/api/reference/search_algorithm.html`。

- [ ] **Step 5: 验证搜索候选**

先在 `OutboundUrlPolicy` 增加 `validateResourceUrl(input: string)`，允许 HTTPS 路径和查询参数，但拒绝凭据、片段、元数据主机、私网地址和超过 2,048 字符的 URL。返回：

```ts
export interface OutboundResourceValidation {
  readonly normalizedUrl: string;
  readonly origin: string;
  readonly developmentLoopback: false;
}
```

封面脚本复用该方法和 `createSafeDispatcher` 连接候选地址；每次重定向都重新校验，最多跟随 3 次，防止公开地址重定向到内网。候选还必须满足：

候选必须同时满足：

- Openverse 的标题或标签包含完整菜名，或同时包含标题中的两个有效词与至少一个主要食材。
- 受限 `GET` 返回 JPEG、PNG 或 WebP；不依赖经常被图片站点拒绝的 `HEAD`。
- 响应不超过 8 MiB，图片解码后宽高至少 480×320。
- `sharp().metadata()` 能正常读取。

验证失败继续下一个候选。30 个候选全部失败时写入 `content/reports/missing-recipe-covers.json`，脚本退出码为 1；失败项不写入正式清单。

- [ ] **Step 6: 让转换器强制读取完整清单**

为 `convert-mirecipe.ts` 增加 `--covers` 参数，默认值为 `content/canonical/recipe-covers.jsonl`。缺少任何 `sourceKey` 时立即失败。构造封面：

```ts
cover: {
  remoteUrl: coverBySourceKey.get(`mirecipe:${id}`)?.url,
  alt: `${title}成品实拍图`,
},
```

在创建食谱前显式检查 `remoteUrl`，防止 `undefined` 进入正式数据。

- [ ] **Step 7: 增加内容命令**

在根 `package.json` 中增加：

```json
{
  "content:covers": "tsx scripts/content/build-cover-manifest.ts",
  "content:build-rich": "npm run content:covers && npm run content:convert-mirecipe && npm run content:validate -- --min-recipes 10520"
}
```

- [ ] **Step 8: 生成并核对封面清单**

Run:

```powershell
npm run content:covers
(Get-Content content/canonical/recipe-covers.jsonl).Count
```

Expected: 命令退出 0，行数为 10,520，报告中的 unresolved 为 0。

- [ ] **Step 9: 提交封面管线与清单**

```powershell
git add scripts/content/cover-manifest.ts scripts/content/build-cover-manifest.ts scripts/content/convert-mirecipe.ts apps/server/src/features/providers/outbound-url-policy.ts content/canonical/recipe-covers.jsonl package.json
git commit -m "feat: add verified real cover manifest for every recipe"
```

---

### Task 4: 实现安全的同源封面缓存服务

**Files:**
- Create: `apps/server/src/features/recipes/recipe-cover-cache.ts`
- Create: `apps/server/src/features/recipes/recipe-cover-routes.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: 实现封面缓存类**

`recipe-cover-cache.ts` 导出：

```ts
export interface RecipeCoverCacheOptions {
  readonly cacheDirectory: string;
  readonly database: Database.Database;
  readonly maximumBytes?: number;
  readonly timeoutMs?: number;
}

export interface CachedRecipeCover {
  readonly path: string;
  readonly etag: string;
}

export class RecipeCoverCache {
  constructor(options: RecipeCoverCacheOptions);
  get(recipeId: string, signal?: AbortSignal): Promise<CachedRecipeCover>;
}
```

实现规则：

- 从 `recipes.cover_remote_url` 读取当前激活食谱的源地址；不存在时抛出 `recipe_cover_not_found` 404。
- 文件名为 `${recipeId}-${sha256(remoteUrl).slice(0, 16)}.webp`。
- 相同文件已存在时直接返回。
- 使用 `Map<string, Promise<CachedRecipeCover>>` 合并并发下载。
- 下载限制为 8 MiB、总超时 15 秒、仅允许 JPEG/PNG/WebP。
- 用 `sharp` 自动旋转、裁剪为 960×720、输出质量 82 的 WebP。
- 先写同目录临时文件，再原子重命名为正式缓存。
- ETag 使用输出文件 SHA-256。

- [ ] **Step 2: 实现同源封面路由**

`recipe-cover-routes.ts` 注册：

```ts
app.get('/api/recipe-covers/:recipeId', async (request, reply) => {
  const params = recipeIdParamsSchema.safeParse(request.params);
  if (!params.success) throw invalidParameters();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once('aborted', abort);
  try {
    const cover = await cache.get(params.data.recipeId, controller.signal);
    if (request.headers['if-none-match'] === `"${cover.etag}"`) {
      return reply.code(304).send();
    }
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .header('ETag', `"${cover.etag}"`)
      .type('image/webp')
      .send(createReadStream(cover.path));
  } finally {
    request.raw.off('aborted', abort);
  }
});
```

处理 `If-None-Match` 并返回 304。下载失败记录安全错误码，不能把外部响应正文或完整 URL 写入日志。

- [ ] **Step 3: 接入应用启动**

在 `BuildAppOptions` 增加 `recipeCoverCacheDirectory?: string`。数据库和目录存在时构造 `RecipeCoverCache` 并注册路由。现有 `/api` 响应统一 `no-store` hook 必须跳过 `/api/recipe-covers/`，让路由设置的公开缓存头生效。`apps/server/src/index.ts` 注入：

```ts
recipeCoverCacheDirectory: join(paths.dataDirectory, 'cover-cache'),
```

把该目录加入隐私清理的 `temporaryDirectories`，清除个人数据时允许删除可再生成的缓存，但不修改食谱表。

- [ ] **Step 4: 构建并做单路由烟雾检查**

Run:

```powershell
npm run typecheck
npm run build -w @xiaochu/server
```

Expected: 类型检查和服务端构建退出 0。

- [ ] **Step 5: 提交缓存服务**

```powershell
git add apps/server/src/features/recipes/recipe-cover-cache.ts apps/server/src/features/recipes/recipe-cover-routes.ts apps/server/src/app.ts apps/server/src/index.ts
git commit -m "feat: cache recipe covers behind a same-origin route"
```

---

### Task 5: 让搜索和详情 API 返回同源封面与完整步骤

**Files:**
- Modify: `apps/server/src/features/recipes/search-repository.ts`
- Modify: `apps/server/src/features/recipes/recipe-repository.ts`

- [ ] **Step 1: 集中生成公开封面路径**

在两个仓储文件各自的私有映射区域使用相同的小函数；不把外部 URL 返回给浏览器：

```ts
const publicCoverUrl = (
  recipeId: string,
  remoteUrl: string | null,
): string | undefined => remoteUrl === null
  ? undefined
  : `/api/recipe-covers/${encodeURIComponent(recipeId)}`;
```

搜索卡片、收藏卡片、最近浏览和详情封面均使用该地址。

- [ ] **Step 2: 对所有食谱层级映射完整步骤**

在 `recipe-repository.ts` 中移除 `standardSteps` 与 `detailedSteps` 的分叉，统一映射：

```ts
const publicSteps = steps.map((step) => ({
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
}));
```

在返回前检查所有六个数据库字段非空；若旧目录尚未升级，抛出 `recipe_guidance_unavailable` 503，避免页面显示半截教程。所有 tier 的返回对象使用 `steps: publicSteps`，媒体字段仍只属于 video/detailed 层级。

- [ ] **Step 3: 执行类型检查**

Run:

```powershell
npm run typecheck -w @xiaochu/server
```

Expected: server 工作区类型检查退出 0。全仓检查在 Task 6 完成 UI 契约迁移后执行。

- [ ] **Step 4: 提交 API 映射**

```powershell
git add apps/server/src/features/recipes/search-repository.ts apps/server/src/features/recipes/recipe-repository.ts
git commit -m "feat: expose cached covers and rich guidance for every recipe"
```

---

### Task 6: 实现文字叠图卡片与全量详细步骤 UI

**Files:**
- Modify: `apps/web/src/features/recipes/RecipeCard.tsx`
- Modify: `apps/web/src/features/recipes/recipe-catalog.css`
- Modify: `apps/web/src/features/recipes/RecipeSteps.tsx`
- Modify: `apps/web/src/features/recipes/RecipeDetailPage.tsx`
- Modify: `apps/web/src/features/recipes/recipe-detail.css`

- [ ] **Step 1: 把卡片信息移入图片叠加层**

`RecipeCard.tsx` 的图片容器内新增：

```tsx
<span className="catalog-card__overlay">
  <strong className="catalog-card__title">{recipe.title}</strong>
  <span className="catalog-card__meta">
    <span>{recipe.totalMinutes} 分钟</span>
    <span>{difficultyLabels[recipe.difficulty]}</span>
  </span>
</span>
```

卡片正文只保留最多两行摘要和教程层级。图片失败仍显示占位，但同一叠加层继续显示标题和元数据。

- [ ] **Step 2: 实现已确认的 B 视觉样式**

在 `recipe-catalog.css` 中设置：

```css
.catalog-card__overlay {
  position: absolute;
  inset: auto 0 0;
  display: grid;
  gap: var(--space-1);
  padding: 3rem var(--space-4) var(--space-3);
  background: linear-gradient(transparent, rgb(0 0 0 / 82%));
  color: #fff;
}

.catalog-card__overlay .catalog-card__meta {
  margin: 0;
  color: rgb(255 255 255 / 86%);
}
```

保持 4:3 图片比例、五列桌面网格和懒加载。为键盘焦点和 hover 保留清晰边框；渐变不能遮住整张图片。

- [ ] **Step 3: 所有食谱显示指导信息**

删除 `RecipeStepsProps.detailed` 和 `isDetailedStep`。`RecipeSteps` 始终渲染 `DetailedGuidance`，详情页改为：

```tsx
<RecipeSteps steps={recipe.steps} />
```

将标题说明统一为“每一步都包含火候、时间和完成判断”。具体步骤不显示步骤图片，也不新增步骤图片字段或 `<img>` 元素。

- [ ] **Step 4: 优化指导信息层级**

在 `recipe-detail.css` 中把前三项做成紧凑提示卡，并让安全提醒横跨整行：

```css
.step-guidance {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.step-guidance__mistake,
.step-guidance__safety {
  grid-column: 1 / -1;
}
```

移动端回到单列。为 `commonMistake` 所在 div 添加 `step-guidance__mistake` 类；安全项继续使用现有类。

- [ ] **Step 5: 执行前端编译检查**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: 所有 workspace 类型检查和生产构建退出 0。允许现有 PWA `inlineDynamicImports` 弃用警告，不允许编译错误。

- [ ] **Step 6: 提交 UI**

```powershell
git add apps/web/src/features/recipes/RecipeCard.tsx apps/web/src/features/recipes/recipe-catalog.css apps/web/src/features/recipes/RecipeSteps.tsx apps/web/src/features/recipes/RecipeDetailPage.tsx apps/web/src/features/recipes/recipe-detail.css
git commit -m "feat: show real-photo cards and actionable recipe steps"
```

---

### Task 7: 生成、导入并验收完整增强目录

**Files:**
- Modify: `scripts/content/validate-catalog.ts`
- Modify: `scripts/content/catalog-status.ts`
- Modify: `scripts/start-local.ps1`
- Modify: `README.md`
- Regenerate: `content/canonical/recipes.jsonl`

- [ ] **Step 1: 扩展内容校验统计**

`validate-catalog.ts` 新增：

```ts
interface Counts {
  recipes: number;
  covers: number;
  steps: number;
  guidedSteps: number;
  videos: number;
  detailed: number;
  invalid: number;
}
```

每个 `cover.remoteUrl` 计入 `covers`；同时具有六个指导字段的步骤计入 `guidedSteps`。通过条件增加：

```ts
counts.covers === counts.recipes
&& counts.guidedSteps === counts.steps
```

- [ ] **Step 2: 让启动器识别增强版目录**

`catalog-status.ts` 增加：

```sql
SUM(CASE WHEN content_version = 'mirecipe-rich2' THEN 1 ELSE 0 END) AS rich
```

`start-local.ps1` 在 `rich -lt 10000` 时启动后台 `replace` 导入，即使旧数据库已有 10,520 道菜。导入进程仍复用现有 PID 和日志机制，不能并发启动第二个导入器。

- [ ] **Step 3: 生成正式目录**

Run:

```powershell
npm run content:covers
npm run content:convert-mirecipe
npm run content:validate -- --min-recipes 10520
```

Expected JSON:

```json
{
  "recipes": 10520,
  "covers": 10520,
  "steps": 84431,
  "guidedSteps": 84431,
  "invalid": 0,
  "passes": true
}
```

- [ ] **Step 4: 导入本地数据库**

Run:

```powershell
node --import tsx scripts/content/import-catalog.ts --input content/canonical/recipes.jsonl --mode replace
node --import tsx scripts/content/catalog-status.ts
```

Expected: import 退出 0；状态中 `active: 10520`、`rich: 10520`。

- [ ] **Step 5: 执行最终编译验证**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: 两条命令退出 0。

- [ ] **Step 6: 执行最小人工抽查**

启动应用：

```powershell
npm run start:local
```

浏览器检查：

1. 列表首屏 20 张卡片均显示真实菜品照片，标题、用时和难度叠在照片底部。
2. 搜索“韭菜炒木耳”，卡片显示实物照片。
3. 打开“韭菜炒木耳”，加热步骤显示中大火、1–2 分钟一类的范围和熟度判断。
4. 打开一道炸、煎、蒸、炖、烤食谱，确认火候、时间与完成状态符合动作类型。
5. 打开一道含切配、腌制或浸泡的食谱，确认显示预计耗时和“无需开火”或环境条件。
6. 详情步骤区域不显示步骤照片。
7. 收藏、购物清单和模型配置仍存在。

- [ ] **Step 7: 更新 README**

记录以下内容：

- 首次打开图片会下载并缓存，后续读取本地 WebP。
- 封面生成命令、目录生成命令和失败报告位置。
- 手工检查火候和时间的步骤。
- 黄色 PWA 弃用警告不影响运行。

- [ ] **Step 8: 提交正式内容与交付文档**

```powershell
git add scripts/content/validate-catalog.ts scripts/content/catalog-status.ts scripts/start-local.ps1 README.md content/canonical/recipes.jsonl
git commit -m "data: publish photo-backed recipes with actionable steps"
```

---

## 最终完成条件

- `content/canonical/recipe-covers.jsonl` 恰好包含 10,520 个唯一 `sourceKey`。
- `content/canonical/recipes.jsonl` 恰好包含 10,520 道有效食谱。
- 所有食谱都有真实 HTTPS 封面源，未解决缺图数为 0。
- 所有步骤都具有完整的时间、火候/设备、完成状态、常见错误和安全要求。
- 浏览器只加载同源封面路由，不直接暴露或依赖外部图片域名。
- 卡片采用用户确认的 B 方案。
- 步骤区域没有图片。
- 本地数据库包含 10,520 道 `mirecipe-rich2` 食谱，个人数据未被清除。
- 类型检查、生产构建、内容校验和七项人工抽查完成。
