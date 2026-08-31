import type { ProviderCapabilities, ProviderTemplate } from '@xiaochu/shared'
export const providerTemplates: Record<ProviderTemplate, { readonly defaultBaseUrl?: string; readonly capabilities: ProviderCapabilities }> = {
  deepseek: { defaultBaseUrl: 'https://api.deepseek.com', capabilities: { chat: true, stream: true, tools: true, json: true, reasoning: true, vision: false } },
  qwen: { defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', capabilities: { chat: true, stream: true, tools: true, json: true, reasoning: false, vision: false } },
  custom: { capabilities: { chat: true, stream: false, tools: false, json: false, reasoning: false, vision: false } },
}
