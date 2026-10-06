# 小厨（XiaoChu）— 本地优先的新手食谱与 AI 烹饪助手

小厨是一个**仅在本机运行、手机优先的 PWA**，为中文新手厨师打造。它把两件事做扎实：

1. **食谱教程**——10,520 道中文食谱，每道菜都有真实食物封面图和"能照着做"的引导式文字步骤（预计时间、火候/设备、完成判断、易错点、安全提示）；
2. **做饭时的 AI 助手**——独立于食谱页的实时文字/语音问答，模型只能"起草"操作，任何写入都需你确认。

没有账号、没有云端依赖、没有数据上传：所有个人数据存在本机 SQLite，模型密钥用 Windows DPAPI 加密，服务只监听 `127.0.0.1:4173`。

> 需要 Windows 10/11 + Node.js 24.x。克隆本仓库约 70 MB（食谱正文库直接入库，开箱即用）。

---

## 功能总览

### 📖 食谱库
- **10,520 道食谱、84,431 个引导式步骤**，全部经规范化管线校验后导入本地 SQLite。
- **实物封面图**：浏览器只读本机封面地址；服务端首次访问时下载原图、压缩为 960×720 WebP 并缓存到 `%LOCALAPPDATA%\XiaoChu\cover-cache`，支持 ETag 协商缓存。
- **中文全文搜索**：SQLite FTS5 + 自定义中文分词器，支持多关键词组合、标签筛选、收藏和最近浏览。
- **视频教程**：部分食谱附带 HTML5 / YouTube / Bilibili 可嵌入视频，只有通过固定域名与 URL 规则校验的媒体才会进入内容包。

### 🍳 引导式烹饪步骤
每个文字步骤都结构化地包含：
- 预计耗时与火候/设备要求
- **完成判断**（做到什么程度算这一步完成）
- **易错点**与**安全提示**（防烫、防溢、生熟分开等）

### 🤖 独立 AI 助手（做饭时用）
- 文字/语音双通道：浏览器端 Web Speech API 语音识别（zh-CN）+ 逐句 TTS 播报，支持**随时打断**和**静音**。
- 服务端 **NDJSON 流式**响应（`turn.started` / `text.delta` / `tool.draft` / `turn.finished`），带序号与中止绑定，模型可中途切换。
- **受控工具调用**：助手可搜索食谱、读取库存、起草购物清单和笔记——但所有写入类操作都只是"草稿"，必须经你逐条确认才会生效。
- 显式上下文授权：助手只能看到你明确授权的上下文。

### 🧊 冰箱照片识别
- 拍照/上传冰箱食材照片（≤10 MiB），由 Qwen-VL 视觉模型识别食材、数量与置信度。
- 识别结果先进入**草稿区**，你编辑确认后才会写入库存——模型永远不直接改数据。

### 🛒 库存与购物清单
- 库存管理与购物清单 CRUD，内置常见食材单位换算。

### ✏️ AI 改菜谱
- 在原食谱基础上让 AI 调整（换食材、减辣、改份量……），生成**预览版**。
- 食品安全规则拦截（如禁止生食建议），确认后另存为新版本，**绝不修改原食谱**。

### 🔑 模型配置（自带 BYOK）
- 内置模板：**DeepSeek**、**通义千问**（DashScope 兼容模式）、**自定义 OpenAI 兼容接口**；填写 Base URL / Model ID / Key 后可一键连接测试。
- API Key **不进前端存储、不进日志、不进 SQLite**——只保存在当前 Windows 用户的 DPAPI 加密文件中（`%LOCALAPPDATA%\XiaoChu\secrets.dat`），数据库里只存 keyRef 引用。

### 🧹 隐私与安全设计
| 设计点 | 实现 |
| --- | --- |
| 仅本机访问 | 服务只监听 `127.0.0.1:4173`，无任何对外暴露 |
| 密钥加密 | Windows DPAPI（CurrentUser 作用域），用后清零缓冲区 |
| CSRF 防护 | Cookie 会话 + `/api/bootstrap` 下发 CSRF Token |
| 速率限制 | 按路由分级（模型流 30/min、视觉上传 6/min、连接测试 6/min 等） |
| SSRF 防护 | 出站请求统一走 URL 策略校验 + DNS 固定，重定向 ≤3 跳、体积 ≤8 MiB |
| 日志脱敏 | apiKey / cookie / 会话转录等字段自动打码 |
| 严格 CSP | Helmet 强 CSP，脚本只允许 `'self'`，媒体/框架域名白名单 |
| 一键清空 | 「我的厨房 → 清空个人数据」抹掉库存/清单/会话/密钥，保留内置食谱 |

---

## 技术架构

npm workspaces 单仓三包，前后端通过 `@xiaochu/shared` 的 Zod 契约通信：

```
┌───────────────────────────── 浏览器（PWA）─────────────────────────────┐
│  React 19 + React Router 7 + TanStack Query 5                        │
│  Vite 8 + vite-plugin-pwa（Service Worker 对 /api 一律 NetworkOnly）   │
│  Web Speech API：语音识别 / 逐句 TTS / 打断控制                        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ fetch（CSRF）/ NDJSON 流
┌──────────────────────────────▼───────────────────────────────────────┐
│  Fastify 5（仅 127.0.0.1:4173，生产环境静态托管前端产物）                │
│  ├─ 食谱 / 封面缓存（sharp → WebP）  ├─ 库存 / 购物清单                │
│  ├─ 助手编排（≤4 轮工具调用）        ├─ 视觉识别（Qwen-VL）            │
│  └─ 改菜谱（安全规则 + 确认）        └─ 密钥（DPAPI）                  │
├──────────────────────────────────────────────────────────────────────┤
│  better-sqlite3（FTS5 中文搜索）  +  OpenAI 兼容模型客户端（SSE 流式）  │
│  数据：%LOCALAPPDATA%\XiaoChu\  （SQLite、secrets.dat、封面缓存、日志） │
└──────────────────────────────────────────────────────────────────────┘
```

| 模块 | 目录 | 说明 |
| --- | --- | --- |
| 服务端 | `apps/server` | Fastify 5 + better-sqlite3 + sharp + zod 4，82 个 TS 文件 |
| 前端 | `apps/web` | React 19 PWA，9 个页面路由（首页/食谱/详情/改菜谱/库存/识别确认/购物/助手/我的） |
| 共享契约 | `packages/shared` | 全部请求/响应/流帧的 Zod Schema 与类型 |
| 内容管线 | `scripts/content` | 食谱规范化、封面清单构建、视频清单、校验与导入（12 个脚本） |
| 内容包 | `content/` | 规范化食谱 JSONL、封面清单、来源注册表与转换报告 |

```
cooking-assistant-pwa/
├─ apps/
│  ├─ server/src/
│  │  ├─ features/        # recipes · inventory · shopping · providers ·
│  │  │                   # variants · voice · vision · actions · privacy
│  │  ├─ plugins/         # session · request-security · error-handler
│  │  ├─ providers/       # OpenAI 兼容客户端 · SSE 解析 · DPAPI 密钥库
│  │  └─ db/migrations/   # 001_core → 004_agent
│  └─ web/src/
│     ├─ features/        # recipes · assistant · inventory · shopping ·
│     │                   # providers · variants · settings · my
│     └─ app/router.tsx
├─ packages/shared/src/   # Zod 契约（recipes · voice · vision · providers …）
├─ scripts/
│  ├─ start-local.ps1     # 一键启动
│  └─ content/            # 内容管线（转换/封面/视频/校验/导入）
├─ content/
│  ├─ canonical/          # recipes.jsonl（10,520 道）+ 封面清单 + 视频清单
│  ├─ sources.json        # 原始数据源注册（SHA-256 校验）
│  └─ reports/            # 转换报告
└─ docs/                  # 运行手册 · 验收清单 · 设计规格与计划
```

---

## 快速开始

要求 **Windows 10/11**、**Node.js 24.x**、npm。

### 方式一：一键启动（推荐）

```powershell
Set-Location 'D:\Codex\cooking-assistant-pwa'
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

脚本会自动：构建前后端 → 启动服务并探测健康检查 → 先导入少量启动食谱让页面立即可用 → 在浏览器打开 `http://localhost:4173` → **后台导入完整 10,520 道食谱**（首次约需数分钟，期间可正常使用，稍后刷新即可看到全量）。

日志与 PID 位于 `%LOCALAPPDATA%\XiaoChu\runtime`。

### 方式二：开发模式

```powershell
npm install
npm run dev
```

同时启动服务端（tsx watch）与前端 Vite 开发服务器（5173，代理 API）。

### 质量检查

```powershell
npm run verify   # eslint + typecheck + vitest + build + playwright e2e
```

---

## 导入与重建内容包

食谱正文库 `content/canonical/recipes.jsonl` 已随仓库分发，通常无需重建。若要自行从原始数据生成：

```powershell
# 1. 按 content/sources.json 下载原始压缩包（含 SHA-256 校验），解压到 content/raw/mirecipe
npm run content:build-covers        # 搜索并验证真实封面，生成封面清单
npm run content:convert-mirecipe    # MIRecipe → 规范化食谱（含步骤富化）
npm run content:validate -- --input content/canonical/recipes.jsonl `
  --min-recipes 10520 --min-covers 10520 --min-guided-steps 84431
npx tsx scripts/content/import-catalog.ts --input content/canonical/recipes.jsonl --mode replace
```

视频教程走独立清单：

```powershell
npm run content:apply-videos -- --recipes content/canonical/recipes.jsonl `
  --manifest content/canonical/video-manifest.jsonl `
  --output content/canonical/recipes-with-video.jsonl --min-videos 1000
npm run content:video-health -- --input content/canonical/recipes-with-video.jsonl `
  --output content/reports/video-health.json --probe
npx tsx scripts/content/import-catalog.ts --input content/canonical/recipes-with-video.jsonl --mode replace
```

清单格式参见 `content/canonical/video-manifest.example.jsonl`；只有能通过固定域名与 URL 规则的可嵌入媒体才会进入内容包。

---

## 模型设置

打开 **我的厨房 → 管理模型密钥与连接**：

1. 选择 DeepSeek / 通义千问 / 自定义 OpenAI 兼容接口；
2. 填写 Base URL、Model ID、API Key，先执行**连接测试**；
3. 测试通过后即可在助手页随时切换模型。

Key 只保存在当前 Windows 用户的 DPAPI 加密文件中，卸载清空即失效。视觉识别（冰箱照片）需要支持图片输入的模型（如 Qwen-VL 系列）。

---

## API 概览

所有接口位于 `/api` 下，响应统一 `ApiSuccess` / `ApiProblem` 结构：

| 分组 | 端点 | 说明 |
| --- | --- | --- |
| 系统 | `GET /api/health` · `GET /api/bootstrap` | 健康检查；会话 + CSRF + 能力声明 |
| 食谱 | `GET /api/recipes` · `GET /api/recipes/:recipeId` | 分页搜索（FTS5）；详情 |
| 封面 | `GET /api/recipe-covers/:recipeId` | 本机缓存的 WebP 封面（ETag） |
| 收藏/足迹 | `GET·PUT·DELETE /api/favorites` · `/api/recent-views` | 收藏与最近浏览 |
| 笔记 | `/api/notes`（CRUD） | 个人烹饪笔记 |
| 库存/购物 | `/api/inventory` · `/api/shopping`（CRUD） | 冰箱库存与购物清单 |
| 模型 | `/api/providers`（CRUD）· `/:id/test` · `/validate` | 供应商配置与连接测试 |
| 改菜谱 | `POST /api/recipes/:id/variants/preview·confirm` · `GET /api/recipe-variants` | 预览 → 确认，另存变体 |
| 待确认操作 | `POST /api/pending-actions/:id/confirm·reject` | 工具草稿的确认/拒绝 |
| 助手 | `POST·GET /api/voice/sessions` · `PATCH /:id/provider` · `POST /:id/end` | 会话管理与模型切换 |
| 助手流 | `POST /api/voice/sessions/:sessionId/turns` | NDJSON 流式对话回合 |
| 视觉 | `POST /api/vision/recognize` · `POST /api/vision/:id/confirm` | 冰箱识别草稿 → 确认入库 |
| 隐私 | `POST /api/privacy/clear-all` | 清空个人数据与密钥 |

---

## 测试

- **单元测试**：Vitest 覆盖三个 workspace + 内容管线，共 14 个测试文件（数据库、导入、流生命周期、请求安全、AppShell、助手回合控制、API 客户端、封面清单、步骤富化等）。
- **端到端**：Playwright 已接入 `npm run verify`，用例持续补充中。
- **人工验收**：见 [手动验收清单](docs/acceptance/manual-smoke.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [本地运行手册](docs/operations/local-runbook.md) | 启动/停止、日志与数据位置 |
| [手动验收清单](docs/acceptance/manual-smoke.md) | 核心功能人工验收步骤 |
| [设计规格](docs/superpowers/specs) | 封面与步骤富化、助手流修复、云多用户与 Android 设计 |
| [执行计划](docs/superpowers/plans) | 对应的分步实施计划 |

---

## 路线图

已在设计文档中规划、尚未实施：

- **云端多用户版本**——账号体系与云部署基础（见 [设计文档](docs/superpowers/specs/2026-09-02-cloud-multi-user-android-app-design.md)）
- **Android 应用**——基于 Capacitor 打包现有 PWA

---

## 内容来源与致谢

内置食谱库由 [MIRecipe 数据集](https://github.com/bimissing/recipeData) 规范化而来（来源与 SHA-256 记录于 `content/sources.json`，转换报告见 `content/reports/`）；封面清单由管线自动搜索并逐一验证。感谢开源数据集的贡献者。

## 许可

代码暂未设置开源许可证（`private: true`），数据集版权归原来源所有。如需引用或复用，请先开 issue 联系。
