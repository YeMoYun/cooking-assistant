# 小厨（XiaoChu）本地食谱与烹饪助手

小厨是一个仅在本机运行的手机优先 PWA。食谱教程和 AI 助手是两个独立模块：食谱页负责浏览、搜索、视频和详细文字步骤；助手页负责做饭过程中的实时文字/语音问答、受控上下文和待确认操作。

## 当前功能

- 多卡片食谱搜索、筛选、收藏、最近浏览、视频与完整文字教程
- 冰箱照片识别后编辑确认、库存和购物清单
- 结构化 AI 改菜谱，确认后保存且不修改原食谱
- DeepSeek、通义千问和自定义 OpenAI 兼容模型配置，Key 由 Windows DPAPI 加密保存
- 独立文字/语音助手，支持打断、静音、模型切换和显式上下文授权
- 一键清空个人数据和模型密钥，同时保留内置食谱

## 本地启动

要求 Windows 10/11、Node.js 24.x 和 npm。首次运行：

```powershell
Set-Location 'D:\Codex\cooking-assistant-pwa'
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

脚本会构建前后端、导入食谱并在浏览器打开 `http://localhost:4173`。服务只监听 `127.0.0.1:4173`。日志和 PID 位于 `%LOCALAPPDATA%\XiaoChu\runtime`，SQLite、加密密钥和临时数据位于 `%LOCALAPPDATA%\XiaoChu`。

开发模式：

```powershell
npm install
npm run dev
```

## 导入大规模食谱包

每行一个符合共享契约的 JSON 食谱：

```powershell
npm run content:validate -- --input content/canonical/recipes.jsonl --min-recipes 10000 --min-videos 1000 --min-detailed 100
npm run content:video-health -- --input content/canonical/recipes.jsonl --output content/reports/video-health.json --probe
npx tsx scripts/content/import-catalog.ts --input content/canonical/recipes.jsonl --mode replace
```

仓库当前内置由 MIRecipe 规范化得到的 10,520 道中文标准文字食谱；原始压缩包不入库，来源地址、SHA-256 和转换脚本均可复现。视频与超详细教程使用独立质量门槛，当前不会把图片步骤冒充成视频。若规范内容包缺失，启动脚本才会退回三道示例菜用于功能测试。

重新生成正文库：

```powershell
# 先按 content/sources.json 下载并校验原始压缩包，解压到 content/raw/mirecipe
npm run content:convert-mirecipe
npm run content:validate -- --input content/canonical/recipes.jsonl --min-recipes 10000
```

视频采用独立的稳定匹配清单，清单每行包含食谱 `sourceKey` 和一个可嵌入的 HTML5/YouTube/Bilibili 媒体对象。准备好清单后执行：

```powershell
npm run content:apply-videos -- --recipes content/canonical/recipes.jsonl --manifest content/canonical/video-manifest.jsonl --output content/canonical/recipes-with-video.jsonl --min-videos 1000
npm run content:video-health -- --input content/canonical/recipes-with-video.jsonl --output content/reports/video-health.json --probe
npx tsx scripts/content/import-catalog.ts --input content/canonical/recipes-with-video.jsonl --mode replace
```

格式参见 `content/canonical/video-manifest.example.jsonl`。只有能通过固定域名和 URL 规则的媒体才会进入正式内容包。

## 模型设置

打开“我的厨房 → 管理模型密钥与连接”，选择 DeepSeek、通义千问或自定义 OpenAI 兼容接口，填写 Base URL、Model ID 和 Key 后先执行连接测试。Key 不进入前端存储、日志或 SQLite；它只保存在当前 Windows 用户的 DPAPI 加密文件中。

详细运行和手动验收见 [本地运行手册](docs/operations/local-runbook.md) 与 [手动验收清单](docs/acceptance/manual-smoke.md)。
