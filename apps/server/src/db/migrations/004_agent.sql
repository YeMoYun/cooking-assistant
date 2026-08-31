CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('active','ended')),
  provider_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
  provider_name_snapshot TEXT NOT NULL CHECK(length(provider_name_snapshot) BETWEEN 1 AND 100),
  model_id_snapshot TEXT NOT NULL CHECK(length(model_id_snapshot) BETWEEN 1 AND 200),
  context_selection_json TEXT NOT NULL CHECK(json_valid(context_selection_json)),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 12000),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE voice_messages (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 100),
  seq INTEGER NOT NULL CHECK(seq >= 0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL CHECK(length(content) <= 50000),
  status TEXT NOT NULL CHECK(status IN ('complete','cancelled','error')),
  tool_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id, seq)
);
CREATE INDEX voice_sessions_started_idx ON voice_sessions(started_at DESC);
CREATE INDEX voice_messages_history_idx ON voice_messages(session_id, created_at, seq);
