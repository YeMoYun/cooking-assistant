CREATE TABLE recipes (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 100),
  source_key TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK(length(source_key) BETWEEN 1 AND 200),
  content_version TEXT NOT NULL
    CHECK(length(content_version) BETWEEN 1 AND 50),
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK(schema_version = 1),
  title TEXT NOT NULL
    CHECK(length(title) BETWEEN 1 AND 100),
  aliases_json TEXT NOT NULL DEFAULT '[]'
    CHECK(length(aliases_json) <= 4000 AND json_valid(aliases_json)),
  summary TEXT NOT NULL
    CHECK(length(summary) BETWEEN 1 AND 500),
  tier TEXT NOT NULL
    CHECK(tier IN ('standard', 'video', 'detailed')),
  difficulty TEXT NOT NULL
    CHECK(difficulty IN ('easy', 'medium', 'hard')),
  servings REAL NOT NULL
    CHECK(servings > 0),
  prep_minutes INTEGER NOT NULL
    CHECK(prep_minutes >= 0),
  cook_minutes INTEGER NOT NULL
    CHECK(cook_minutes > 0),
  cover_remote_url TEXT,
  cover_alt TEXT NOT NULL
    CHECK(length(cover_alt) BETWEEN 1 AND 200),
  is_active INTEGER NOT NULL DEFAULT 1
    CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK(length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL
    CHECK(length(updated_at) BETWEEN 20 AND 40),
  imported_at TEXT NOT NULL
    CHECK(length(imported_at) BETWEEN 20 AND 40),
  deactivated_at TEXT,
  CHECK(cover_remote_url IS NULL OR (
    length(cover_remote_url) <= 2048 AND cover_remote_url LIKE 'https://%'
  )),
  CHECK(deactivated_at IS NULL OR is_active = 0)
);

CREATE INDEX recipes_active_title_idx
  ON recipes(is_active, title, id);
CREATE INDEX recipes_active_filters_idx
  ON recipes(is_active, tier, difficulty, prep_minutes, cook_minutes, id);
CREATE INDEX recipes_content_version_idx
  ON recipes(content_version);

CREATE TABLE recipe_media (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 120),
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL
    CHECK(position >= 0),
  kind TEXT NOT NULL
    CHECK(kind IN ('html5', 'iframe', 'external')),
  url TEXT NOT NULL
    CHECK(length(url) BETWEEN 9 AND 2048 AND url LIKE 'https://%'),
  provider TEXT NOT NULL
    CHECK(length(provider) BETWEEN 1 AND 50),
  poster_url TEXT,
  health_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK(health_status IN ('unchecked', 'healthy', 'degraded', 'unavailable')),
  last_checked_at TEXT,
  last_healthy_at TEXT,
  failure_code TEXT
    CHECK(failure_code IS NULL OR length(failure_code) <= 100),
  is_active INTEGER NOT NULL DEFAULT 1
    CHECK(is_active IN (0, 1)),
  CHECK(poster_url IS NULL OR (
    length(poster_url) <= 2048 AND poster_url LIKE 'https://%'
  )),
  UNIQUE(recipe_id, position)
);

CREATE INDEX recipe_media_recipe_active_idx
  ON recipe_media(recipe_id, is_active, position);
CREATE INDEX recipe_media_health_idx
  ON recipe_media(is_active, health_status, last_checked_at);

CREATE TABLE ingredients (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 100),
  canonical_name TEXT NOT NULL
    CHECK(length(canonical_name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL UNIQUE
    CHECK(length(normalized_name) BETWEEN 1 AND 80),
  category TEXT NOT NULL
    CHECK(category IN ('produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other')),
  is_active INTEGER NOT NULL DEFAULT 1
    CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ingredients_active_category_idx
  ON ingredients(is_active, category, canonical_name);

CREATE TABLE ingredient_aliases (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 120),
  ingredient_id TEXT NOT NULL
    REFERENCES ingredients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  alias TEXT NOT NULL
    CHECK(length(alias) BETWEEN 1 AND 80),
  normalized_alias TEXT NOT NULL UNIQUE
    CHECK(length(normalized_alias) BETWEEN 1 AND 80),
  position INTEGER NOT NULL
    CHECK(position >= 0),
  UNIQUE(ingredient_id, position)
);

CREATE INDEX ingredient_aliases_ingredient_idx
  ON ingredient_aliases(ingredient_id, position);

CREATE TABLE recipe_ingredients (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 140),
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL
    REFERENCES ingredients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  position INTEGER NOT NULL
    CHECK(position >= 0),
  quantity REAL NOT NULL
    CHECK(quantity > 0),
  unit TEXT NOT NULL
    CHECK(length(unit) BETWEEN 1 AND 20),
  is_optional INTEGER NOT NULL DEFAULT 0
    CHECK(is_optional IN (0, 1)),
  note TEXT
    CHECK(note IS NULL OR length(note) <= 200),
  UNIQUE(id, recipe_id),
  UNIQUE(recipe_id, position),
  UNIQUE(recipe_id, ingredient_id)
);

CREATE INDEX recipe_ingredients_ingredient_idx
  ON recipe_ingredients(ingredient_id, recipe_id);

CREATE TABLE recipe_steps (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 140),
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  step_number INTEGER NOT NULL
    CHECK(step_number > 0),
  instruction TEXT NOT NULL
    CHECK(length(instruction) BETWEEN 1 AND 2000),
  duration_seconds_min INTEGER
    CHECK(duration_seconds_min IS NULL OR duration_seconds_min > 0),
  duration_seconds_max INTEGER
    CHECK(duration_seconds_max IS NULL OR duration_seconds_max > 0),
  heat_or_device TEXT
    CHECK(heat_or_device IS NULL OR length(heat_or_device) BETWEEN 1 AND 200),
  completion_cue TEXT
    CHECK(completion_cue IS NULL OR length(completion_cue) BETWEEN 1 AND 500),
  common_mistake TEXT
    CHECK(common_mistake IS NULL OR length(common_mistake) BETWEEN 1 AND 500),
  safety_requirement TEXT
    CHECK(safety_requirement IS NULL OR length(safety_requirement) BETWEEN 1 AND 500),
  CHECK((duration_seconds_min IS NULL) = (duration_seconds_max IS NULL)),
  CHECK(duration_seconds_min IS NULL OR duration_seconds_min <= duration_seconds_max),
  UNIQUE(id, recipe_id),
  UNIQUE(recipe_id, step_number)
);

CREATE INDEX recipe_steps_recipe_idx
  ON recipe_steps(recipe_id, step_number);

CREATE TABLE recipe_step_ingredients (
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  recipe_step_id TEXT NOT NULL,
  recipe_ingredient_id TEXT NOT NULL,
  position INTEGER NOT NULL
    CHECK(position >= 0),
  FOREIGN KEY(recipe_step_id, recipe_id)
    REFERENCES recipe_steps(id, recipe_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY(recipe_ingredient_id, recipe_id)
    REFERENCES recipe_ingredients(id, recipe_id) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY(recipe_step_id, recipe_ingredient_id),
  UNIQUE(recipe_step_id, position)
);

CREATE INDEX recipe_step_ingredients_recipe_ingredient_idx
  ON recipe_step_ingredients(recipe_ingredient_id);

CREATE TABLE recipe_tags (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 140),
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tag_kind TEXT NOT NULL
    CHECK(tag_kind IN ('tag', 'taste', 'technique')),
  value TEXT NOT NULL
    CHECK(length(value) BETWEEN 1 AND 50),
  normalized_value TEXT NOT NULL
    CHECK(length(normalized_value) BETWEEN 1 AND 50),
  position INTEGER NOT NULL
    CHECK(position >= 0),
  UNIQUE(recipe_id, tag_kind, normalized_value),
  UNIQUE(recipe_id, tag_kind, position)
);

CREATE INDEX recipe_tags_filter_idx
  ON recipe_tags(tag_kind, normalized_value, recipe_id);
CREATE INDEX recipe_tags_recipe_idx
  ON recipe_tags(recipe_id, tag_kind, position);

CREATE TABLE recipe_search (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT NOT NULL UNIQUE
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  title_normalized TEXT NOT NULL
    CHECK(length(title_normalized) BETWEEN 1 AND 200),
  aliases_normalized TEXT NOT NULL DEFAULT ''
    CHECK(length(aliases_normalized) <= 4000),
  title_terms TEXT NOT NULL DEFAULT ''
    CHECK(length(title_terms) <= 8000),
  ingredient_terms TEXT NOT NULL DEFAULT ''
    CHECK(length(ingredient_terms) <= 16000),
  alias_terms TEXT NOT NULL DEFAULT ''
    CHECK(length(alias_terms) <= 12000),
  summary_terms TEXT NOT NULL DEFAULT ''
    CHECK(length(summary_terms) <= 16000),
  tag_terms TEXT NOT NULL DEFAULT ''
    CHECK(length(tag_terms) <= 12000),
  tier TEXT NOT NULL
    CHECK(tier IN ('standard', 'video', 'detailed')),
  difficulty TEXT NOT NULL
    CHECK(difficulty IN ('easy', 'medium', 'hard')),
  total_minutes INTEGER NOT NULL
    CHECK(total_minutes > 0),
  catalog_version INTEGER NOT NULL
    CHECK(catalog_version >= 0)
);

CREATE INDEX recipe_search_filters_idx
  ON recipe_search(tier, difficulty, total_minutes, recipe_id);
CREATE INDEX recipe_search_title_idx
  ON recipe_search(title_normalized, recipe_id);
CREATE INDEX recipe_search_catalog_idx
  ON recipe_search(catalog_version, recipe_id);

CREATE VIRTUAL TABLE recipe_search_fts USING fts5(
  title_terms,
  ingredient_terms,
  alias_terms,
  summary_terms,
  tag_terms,
  content='recipe_search',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER recipe_search_fts_after_insert
AFTER INSERT ON recipe_search BEGIN
  INSERT INTO recipe_search_fts(
    rowid, title_terms, ingredient_terms, alias_terms, summary_terms, tag_terms
  ) VALUES (
    new.rowid, new.title_terms, new.ingredient_terms, new.alias_terms,
    new.summary_terms, new.tag_terms
  );
END;

CREATE TRIGGER recipe_search_fts_after_delete
AFTER DELETE ON recipe_search BEGIN
  INSERT INTO recipe_search_fts(
    recipe_search_fts, rowid, title_terms, ingredient_terms, alias_terms,
    summary_terms, tag_terms
  ) VALUES (
    'delete', old.rowid, old.title_terms, old.ingredient_terms, old.alias_terms,
    old.summary_terms, old.tag_terms
  );
END;

CREATE TRIGGER recipe_search_fts_after_update
AFTER UPDATE ON recipe_search BEGIN
  INSERT INTO recipe_search_fts(
    recipe_search_fts, rowid, title_terms, ingredient_terms, alias_terms,
    summary_terms, tag_terms
  ) VALUES (
    'delete', old.rowid, old.title_terms, old.ingredient_terms, old.alias_terms,
    old.summary_terms, old.tag_terms
  );
  INSERT INTO recipe_search_fts(
    rowid, title_terms, ingredient_terms, alias_terms, summary_terms, tag_terms
  ) VALUES (
    new.rowid, new.title_terms, new.ingredient_terms, new.alias_terms,
    new.summary_terms, new.tag_terms
  );
END;

CREATE TABLE favorites (
  recipe_id TEXT PRIMARY KEY
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE recent_views (
  recipe_id TEXT PRIMARY KEY
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  last_viewed_at TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 1
    CHECK(view_count > 0)
);

CREATE INDEX recent_views_time_idx
  ON recent_views(last_viewed_at DESC, recipe_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 100),
  recipe_id TEXT NOT NULL
    REFERENCES recipes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  body TEXT NOT NULL
    CHECK(length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX notes_recipe_idx
  ON notes(recipe_id, updated_at DESC, id);

INSERT INTO app_data_versions(scope, version)
VALUES ('recipe_catalog', 0);
