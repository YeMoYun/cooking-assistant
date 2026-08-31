import { AppError } from '@xiaochu/shared';
import { JsonModelClient } from './json-model-client.js';
import { OpenAiCompatibleAdapter } from './openai-compatible-adapter.js';
import { ProviderRepository } from './provider-repository.js';

export class ProviderRegistry {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly client: JsonModelClient,
  ) {}

  get(providerId: string) {
    const profile = this.providers.get(providerId);
    if (profile === undefined || !profile.enabled) {
      throw new AppError('provider_unavailable', 'Model configuration is unavailable', 409);
    }
    return { profile, adapter: new OpenAiCompatibleAdapter(profile, this.client) };
  }
}
