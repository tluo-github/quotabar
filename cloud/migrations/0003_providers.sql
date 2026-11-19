-- 同一设备分别保存 Claude 和 Codex，保留原有 Claude 数据。
ALTER TABLE usage_latest RENAME TO usage_latest_legacy;
CREATE TABLE usage_latest (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'claude',
  user_id TEXT NOT NULL,
  plan TEXT,
  limits TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, provider)
);
INSERT INTO usage_latest SELECT device_id, 'claude', user_id, plan, limits, fetched_at FROM usage_latest_legacy;
DROP TABLE usage_latest_legacy;
ALTER TABLE usage_history RENAME TO usage_history_legacy;
CREATE TABLE usage_history (
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  ts INTEGER NOT NULL,
  five_hour REAL,
  weekly REAL,
  PRIMARY KEY (device_id, provider, ts)
);
INSERT INTO usage_history SELECT device_id, 'claude', ts, five_hour, weekly FROM usage_history_legacy;
DROP TABLE usage_history_legacy;
CREATE INDEX usage_history_ts ON usage_history(ts);
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE daily_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'claude';
