CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 36),
  ingredient_id TEXT
    REFERENCES ingredients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  canonical_name TEXT NOT NULL
    CHECK(length(canonical_name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL
    CHECK(length(normalized_name) BETWEEN 1 AND 80),
  quantity REAL NOT NULL
    CHECK(quantity > 0),
  unit TEXT NOT NULL
    CHECK(unit IN (
      'g', 'kg', 'ml', 'L', '个', '只', '枚', '根', '片', '瓣',
      '茶匙', '汤匙', '少许', '适量'
    )),
  category TEXT NOT NULL
    CHECK(category IN (
      'produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other'
    )),
  source TEXT NOT NULL
    CHECK(source IN ('manual', 'vision', 'shopping')),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
    CHECK(version > 0)
);

CREATE INDEX inventory_items_name_idx
  ON inventory_items(normalized_name, unit, id);
CREATE INDEX inventory_items_ingredient_idx
  ON inventory_items(ingredient_id, unit, id);
CREATE INDEX inventory_items_updated_idx
  ON inventory_items(updated_at DESC, id);

CREATE TABLE shopping_items (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 36),
  ingredient_id TEXT
    REFERENCES ingredients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  canonical_name TEXT NOT NULL
    CHECK(length(canonical_name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL
    CHECK(length(normalized_name) BETWEEN 1 AND 80),
  quantity REAL NOT NULL
    CHECK(quantity > 0),
  unit TEXT NOT NULL
    CHECK(unit IN (
      'g', 'kg', 'ml', 'L', '个', '只', '枚', '根', '片', '瓣',
      '茶匙', '汤匙', '少许', '适量'
    )),
  category TEXT NOT NULL
    CHECK(category IN (
      'produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other'
    )),
  requires_review INTEGER NOT NULL DEFAULT 0
    CHECK(requires_review IN (0, 1)),
  is_checked INTEGER NOT NULL DEFAULT 0
    CHECK(is_checked IN (0, 1)),
  sources_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(sources_json) AND length(sources_json) <= 10000),
  source TEXT NOT NULL
    CHECK(source IN ('manual', 'generated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
    CHECK(version > 0)
);

CREATE INDEX shopping_items_checked_category_idx
  ON shopping_items(is_checked, category, normalized_name, id);
CREATE INDEX shopping_items_ingredient_idx
  ON shopping_items(ingredient_id, unit, id);

CREATE TABLE ingredient_unit_conversions (
  ingredient_id TEXT NOT NULL
    REFERENCES ingredients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  from_unit TEXT NOT NULL
    CHECK(from_unit IN (
      'g', 'kg', 'ml', 'L', '个', '只', '枚', '根', '片', '瓣',
      '茶匙', '汤匙', '少许', '适量'
    )),
  to_unit TEXT NOT NULL
    CHECK(to_unit IN (
      'g', 'kg', 'ml', 'L', '个', '只', '枚', '根', '片', '瓣',
      '茶匙', '汤匙', '少许', '适量'
    )),
  factor REAL NOT NULL
    CHECK(factor > 0),
  note TEXT
    CHECK(note IS NULL OR length(note) <= 500),
  CHECK(from_unit <> to_unit),
  PRIMARY KEY(ingredient_id, from_unit, to_unit)
);

CREATE TABLE recipe_variants (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 36),
  source_recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 1 AND 100),
  request_json TEXT NOT NULL
    CHECK(json_valid(request_json) AND length(request_json) <= 100000),
  result_json TEXT NOT NULL
    CHECK(json_valid(result_json) AND length(result_json) <= 500000),
  validator_version TEXT NOT NULL
    CHECK(length(validator_version) BETWEEN 1 AND 50),
  created_at TEXT NOT NULL
);

CREATE INDEX recipe_variants_source_idx
  ON recipe_variants(source_recipe_id, created_at DESC, id);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 36),
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL
    CHECK(kind IN ('text', 'vision')),
  template TEXT NOT NULL
    CHECK(length(template) BETWEEN 1 AND 50),
  normalized_base_url TEXT NOT NULL
    CHECK(
      length(normalized_base_url) BETWEEN 9 AND 2048
      AND normalized_base_url LIKE 'https://%'
    ),
  model_id TEXT NOT NULL
    CHECK(length(model_id) BETWEEN 1 AND 200),
  capabilities_json TEXT NOT NULL
    CHECK(json_valid(capabilities_json) AND length(capabilities_json) <= 10000),
  stream_enabled INTEGER NOT NULL DEFAULT 1
    CHECK(stream_enabled IN (0, 1)),
  key_ref TEXT NOT NULL UNIQUE
    CHECK(length(key_ref) BETWEEN 1 AND 200),
  is_enabled INTEGER NOT NULL DEFAULT 1
    CHECK(is_enabled IN (0, 1)),
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX provider_profiles_kind_enabled_idx
  ON provider_profiles(kind, is_enabled, name, id);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 43),
  action_kind TEXT NOT NULL
    CHECK(action_kind IN ('shopping_items', 'recipe_variant', 'note')),
  tool_name TEXT NOT NULL
    CHECK(length(tool_name) BETWEEN 1 AND 100),
  payload_json TEXT NOT NULL
    CHECK(json_valid(payload_json) AND length(payload_json) <= 1000000),
  arguments_hash TEXT NOT NULL
    CHECK(length(arguments_hash) = 64 AND arguments_hash NOT GLOB '*[^0-9a-f]*'),
  session_binding_hash TEXT NOT NULL
    CHECK(length(session_binding_hash) = 64 AND session_binding_hash NOT GLOB '*[^0-9a-f]*'),
  turn_id TEXT
    CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 100),
  data_version_scope TEXT NOT NULL
    CHECK(length(data_version_scope) BETWEEN 1 AND 100),
  data_version_value INTEGER NOT NULL
    CHECK(data_version_value >= 0),
  data_versions_json TEXT NOT NULL
    CHECK(json_valid(data_versions_json) AND length(data_versions_json) <= 4000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > created_at),
  CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX pending_actions_expiry_idx
  ON pending_actions(consumed_at, expires_at, id);

CREATE TABLE recognition_drafts (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 43),
  session_binding_hash TEXT NOT NULL
    CHECK(length(session_binding_hash) = 64 AND session_binding_hash NOT GLOB '*[^0-9a-f]*'),
  candidates_json TEXT NOT NULL
    CHECK(json_valid(candidates_json) AND length(candidates_json) <= 1000000),
  inventory_version INTEGER NOT NULL
    CHECK(inventory_version >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > created_at),
  CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX recognition_drafts_expiry_idx
  ON recognition_drafts(consumed_at, expires_at, id);

INSERT INTO app_data_versions(scope, version) VALUES
  ('inventory', 0),
  ('shopping', 0),
  ('variants', 0);
