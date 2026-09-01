# 小厨本地运行手册

## 启动与停止

在仓库根目录执行 `powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1`。脚本只启动环回地址服务，并在健康检查成功后打开浏览器。

停止时读取 `%LOCALAPPDATA%\XiaoChu\runtime\server.pid`，在任务管理器中结束对应的 Node.js 进程；或在 PowerShell 中确认 PID 后执行 `Stop-Process -Id <PID>`。不要删除整个 `%LOCALAPPDATA%` 目录。

## 数据位置

- SQLite：`%LOCALAPPDATA%\XiaoChu\xiaochu.sqlite`
- DPAPI 密钥文件：`%LOCALAPPDATA%\XiaoChu\secrets.dat`
- 临时识别图片：`%LOCALAPPDATA%\XiaoChu\vision-temp`
- 运行日志：`%LOCALAPPDATA%\XiaoChu\runtime`

密钥由 Windows CurrentUser DPAPI 保护，绑定当前 Windows 用户和机器。已经以同一 Windows 用户身份运行的恶意进程不在本地 MVP 的保护边界内。

## 常见问题

- 页面无食谱：重新运行启动脚本，或手动执行食谱导入命令。
- 模型连接失败：检查 Base URL、Model ID、Key、余额和网络；本地食谱仍可使用。
- 麦克风不可用：使用同一助手页的文本框，不影响对话流式输出。
- 视频打不开：使用页面下方的完整文字教程。
- 清空数据：在“我的厨房”输入确认短语。该操作保留食谱，删除个人数据、浏览器缓存和模型密钥。
