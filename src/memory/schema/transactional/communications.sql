-- Inbound/outbound communications: email, SMS, voice.
-- messages: all channels, threading, intent detection.
-- calls: Vapi voice sessions with transcripts.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  deal_id TEXT,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT,
  from_name TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  body_html TEXT,
  attachments JSONB NOT NULL DEFAULT '[]',
  drafted_by TEXT,
  approved_by TEXT,
  edit_distance INTEGER,
  original_draft TEXT,
  received_at TEXT,
  drafted_at TEXT,
  approved_at TEXT,
  sent_at TEXT,
  response_to_id TEXT,
  response_time_ms REAL,
  thread_id TEXT,
  intent TEXT,
  parsed_data JSONB,
  confidence REAL,
  confidence_level TEXT,
  platform_message_id TEXT,
  platform_metadata JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_messages_deal_id ON messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec REAL,
  transcript JSONB NOT NULL DEFAULT '[]',
  detected_entities JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  recording_url TEXT,
  recording_expires_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_calls_deal_id ON calls(deal_id);
