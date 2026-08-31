import {
  providerCapabilitiesSchema,
  providerProfileSchema,
  type ProviderCapabilities,
  type ProviderKind,
  type ProviderProfile,
  type ProviderTemplate,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';

interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly template: ProviderTemplate;
  readonly normalized_base_url: string;
  readonly model_id: string;
  readonly capabilities_json: string;
  readonly stream_enabled: number;
  readonly key_ref: string;
  readonly is_enabled: number;
  readonly last_tested_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface StoredProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly template: ProviderTemplate;
  readonly normalizedBaseUrl: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  readonly streamEnabled: boolean;
  readonly keyRef: string;
  readonly enabled: boolean;
  readonly lastTestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly template: ProviderTemplate;
  readonly normalizedBaseUrl: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  readonly streamEnabled: boolean;
  readonly keyRef: string;
  readonly enabled: boolean;
  readonly lastTestedAt: string | null;
}

const parseCapabilities = (value: string): ProviderCapabilities => {
  try {
    return providerCapabilitiesSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('Stored provider capabilities are invalid');
  }
};

const mapStoredProfile = (row: ProviderRow): StoredProviderProfile => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  template: row.template,
  normalizedBaseUrl: row.normalized_base_url,
  modelId: row.model_id,
  capabilities: parseCapabilities(row.capabilities_json),
  streamEnabled: row.stream_enabled === 1,
  keyRef: row.key_ref,
  enabled: row.is_enabled === 1,
  lastTestedAt: row.last_tested_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toPublicProviderProfile = (
  profile: StoredProviderProfile,
): ProviderProfile => providerProfileSchema.parse({
  id: profile.id,
  protocol: 'openai-chat-completions',
  name: profile.name,
  kind: profile.kind,
  template: profile.template,
  baseUrl: profile.normalizedBaseUrl,
  modelId: profile.modelId,
  capabilities: profile.capabilities,
  streamEnabled: profile.streamEnabled,
  enabled: profile.enabled,
  hasKey: true,
  lastTestedAt: profile.lastTestedAt,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const PROVIDER_COLUMNS = `
  id, name, kind, template, normalized_base_url, model_id,
  capabilities_json, stream_enabled, key_ref, is_enabled, last_tested_at,
  created_at, updated_at
`;

export class ProviderRepository {
  constructor(private readonly db: Database.Database) {}

  list(): ProviderProfile[] {
    const rows = this.db.prepare(`
      SELECT ${PROVIDER_COLUMNS}
      FROM provider_profiles
      ORDER BY is_enabled DESC, kind ASC, name COLLATE NOCASE ASC, id ASC
    `).all() as ProviderRow[];
    return rows.map((row) => toPublicProviderProfile(mapStoredProfile(row)));
  }

  get(providerId: string): StoredProviderProfile | undefined {
    const row = this.db.prepare(`
      SELECT ${PROVIDER_COLUMNS}
      FROM provider_profiles WHERE id = ?
    `).get(providerId) as ProviderRow | undefined;
    return row === undefined ? undefined : mapStoredProfile(row);
  }

  insert(profile: SaveProviderProfile, now: string): ProviderProfile {
    this.db.prepare(`
      INSERT INTO provider_profiles(
        id, name, kind, template, normalized_base_url, model_id,
        capabilities_json, stream_enabled, key_ref, is_enabled,
        last_tested_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.id,
      profile.name,
      profile.kind,
      profile.template,
      profile.normalizedBaseUrl,
      profile.modelId,
      JSON.stringify(profile.capabilities),
      profile.streamEnabled ? 1 : 0,
      profile.keyRef,
      profile.enabled ? 1 : 0,
      profile.lastTestedAt,
      now,
      now,
    );
    return this.requirePublic(profile.id);
  }

  update(profile: SaveProviderProfile, now: string): ProviderProfile {
    const result = this.db.prepare(`
      UPDATE provider_profiles SET
        name = ?, kind = ?, template = ?, normalized_base_url = ?,
        model_id = ?, capabilities_json = ?, stream_enabled = ?,
        key_ref = ?, is_enabled = ?, last_tested_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      profile.name,
      profile.kind,
      profile.template,
      profile.normalizedBaseUrl,
      profile.modelId,
      JSON.stringify(profile.capabilities),
      profile.streamEnabled ? 1 : 0,
      profile.keyRef,
      profile.enabled ? 1 : 0,
      profile.lastTestedAt,
      now,
      profile.id,
    );
    if (result.changes !== 1) {
      throw new Error('Provider profile disappeared during update');
    }
    return this.requirePublic(profile.id);
  }

  markTested(
    providerId: string,
    capabilities: ProviderCapabilities,
    testedAt: string,
  ): ProviderProfile {
    const result = this.db.prepare(`
      UPDATE provider_profiles SET
        capabilities_json = ?, last_tested_at = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(capabilities), testedAt, testedAt, providerId);
    if (result.changes !== 1) {
      throw new Error('Provider profile disappeared during connection test');
    }
    return this.requirePublic(providerId);
  }

  delete(providerId: string): StoredProviderProfile | undefined {
    const existing = this.get(providerId);
    if (existing === undefined) {
      return undefined;
    }
    const result = this.db.prepare(`
      DELETE FROM provider_profiles WHERE id = ?
    `).run(providerId);
    if (result.changes !== 1) {
      throw new Error('Provider profile disappeared during deletion');
    }
    return existing;
  }

  private requirePublic(providerId: string): ProviderProfile {
    const stored = this.get(providerId);
    if (stored === undefined) {
      throw new Error('Provider profile could not be read back');
    }
    return toPublicProviderProfile(stored);
  }
}
