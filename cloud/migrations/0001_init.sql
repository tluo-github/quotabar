-- 账号
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- ulid
  email       TEXT,
  name        TEXT,
  settings    TEXT NOT NULL DEFAULT '{}',-- 通知偏好等 JSON
  created_at  INTEGER NOT NULL
);

-- 第三方登录身份（一个账号可以同时绑 Apple、Google、GitHub）
CREATE TABLE identities (
  provider    TEXT NOT NULL,             -- 'apple' | 'google' | 'github'
  subject     TEXT NOT NULL,             -- 对方的用户 id（sub）
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- 设备，同时充当登录会话
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,          -- 'mac' | 'ios' | 'web'
  name           TEXT NOT NULL,          -- “MacBook Pro”
  token_hash     TEXT NOT NULL UNIQUE,
  push_token     TEXT,                   -- APNs device token
  push_env       TEXT,                   -- 'sandbox' | 'production'
  remote_enabled INTEGER NOT NULL DEFAULT 0, -- 二期：只有这台 Mac 自己能改
  app_version    TEXT,
  last_seen_at   INTEGER,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

-- 每台 Mac 最近一次的额度（两台 Mac 可能登的是不同的 Claude 账号，所以按设备存）
CREATE TABLE usage_latest (
  device_id   TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  plan        TEXT,                      -- 'Pro' | 'Max' ...
  limits      TEXT NOT NULL,             -- JSON：[{key,title,percent,resets_at,severity}]
  fetched_at  INTEGER NOT NULL
);

-- 额度历史，画趋势图用；同一台设备最多每 15 分钟存一条
CREATE TABLE usage_history (
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  five_hour   REAL,
  weekly      REAL,
  PRIMARY KEY (device_id, ts)
);

-- 会话
CREATE TABLE sessions (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,          -- Claude Code 的 session_id
  device_id      TEXT NOT NULL,
  project        TEXT NOT NULL,          -- 只存目录名，不存完整路径
  title          TEXT,                   -- 关了“上传会话标题”就是 NULL
  model          TEXT,
  status         TEXT NOT NULL,          -- idle|running|waiting|done|ended|offline
  status_detail  TEXT,                   -- “想运行 npm test”
  status_at      INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  requests       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX sessions_recent ON sessions(user_id, last_activity_at DESC);

-- 状态切换记录（会话详情页的时间线），保留 30 天
CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT                       -- 提示词摘录 / 授权内容
);
CREATE INDEX events_session ON session_events(user_id, session_id, ts);

-- 每日 token（统计页），Mac 按本机时区算好日期再上报
CREATE TABLE daily_tokens (
  device_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,             -- 'YYYY-MM-DD'
  project     TEXT NOT NULL,
  model       TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
  tokens_cache_read INTEGER NOT NULL, tokens_cache_write INTEGER NOT NULL,
  requests    INTEGER NOT NULL,
  PRIMARY KEY (device_id, day, project, model)
);

-- 登录中转：一次性 code，5 分钟过期
CREATE TABLE auth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  client         TEXT NOT NULL,          -- 'mac' | 'ios'
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- 二期：远程指令
CREATE TABLE commands (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,            -- 目标 Mac
  session_id   TEXT,                     -- NULL = 在某个项目里开新会话
  project      TEXT,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL,            -- queued|delivered|running|done|failed|rejected|expired
  result       TEXT,                     -- 最后一段回复的摘要
  created_by   TEXT NOT NULL,            -- 发起指令的设备 id
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
