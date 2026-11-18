# Quotlet Cloud 技术设计（草案）

> 2026-11-17 起草。

## 0. 已定的事

| 事项 | 决定 |
|---|---|
| 用户范围 | 先给自己用，以后开放给所有人，所以从一开始就按多用户设计 |
| 域名 | 2026-11-18 买了 `quotlet.com`（Cloudflare 注册）。门户 `quotlet.com`，网站和 API 在 `app.quotlet.com`（同一个 Worker `app`）；旧地址 `app.quotabar.workers.dev` 还能用 |
| Mac 端 | 联网功能默认关闭；登录后上报额度、会话和状态 |
| 会话状态 | 设置里加一个开关“精确的会话状态”，打开后往 Claude Code 里装 hooks。**必须先登录才能打开**；退出登录时自动卸载 hooks |
| 远程指令 | 要做（二期）。默认关闭，必须登录后在那台 Mac 上手动开启 |
| iOS | SwiftUI 原生 |
| Android | 一期先用网站（PWA），页面开着时每分钟拉一次，不做后台推送 |
| 登录 | Apple + Google + GitHub。邮箱验证码先不做（原因见第 3 节） |

## 1. 整体结构

```
Mac (Quotlet.app)
  ├─ 额度：Anthropic /usage（已有）
  ├─ 会话/token：~/.claude/projects（已有）
  ├─ hooks → Quotlet --hook → events.jsonl → app 监听（新增）
  └─ HTTPS 上报 ──────────────┐   （二期再加 WebSocket，接收指令）
                              ▼
Cloudflare Worker  app.quotlet.com
  ├─ /api/*      接口（Hono 路由）
  ├─ /*          网站静态文件（Workers Static Assets，免费且不计请求数）
  ├─ D1          持久数据
  ├─ Durable Object UserHub（每个用户一个）：WebSocket 广播、二期的指令队列
  ├─ APNs        iOS 推送、灵动岛更新（Worker 用 WebCrypto 签 ES256 JWT）
  └─ Cron        每天清理过期数据
                              ▲
网站 / PWA（安卓）：页面开着时连 WebSocket；连不上就每分钟拉一次
iOS App：前台用 WebSocket，后台靠 APNs 推送
```

### 免费额度估算（单个用户）

- Mac 上报：额度变化最多每 5 分钟一次，会话变化每分钟最多一次，状态事件即时发送，没有变化时每 2 分钟发一次心跳。一台 Mac 一天约 1–2 千次请求
- Workers 免费额度：每天 10 万次请求；D1：每天 500 万行读、10 万行写、总共 5GB
- 结论：自己用绰绰有余；开放后大约能撑几十个活跃用户，再往上就要加钱（Workers 付费版每月 5 美元起），或者提供“部署到自己的 Cloudflare 账号”

## 2. 会话状态：hooks

### 装什么

在 `~/.claude/settings.json` 的 `hooks` 里加以下几项，命令都是同一个：

```
'/Applications/Quotlet.app/Contents/MacOS/Quotlet' --hook   # quotlet-hook
```

| hook 事件 | 状态变成 | 说明 |
|---|---|---|
| `SessionStart` | 空闲 | 记下会话、cwd |
| `UserPromptSubmit` | 执行中 | 记下提示词摘录（前 80 字，只在开了“上传会话标题”时上传） |
| `Notification`（`permission_prompt`） | 等待授权 | 记下 message，比如“想运行 npm test” |
| `PostToolUse` | 执行中 | 用来把状态从“等待授权”改回来。触发很频繁，但只写本地文件，状态没变就不上传 |
| `Stop` | 已完成 | 一轮回复结束 |
| `SessionEnd` | 已结束 | 退出 claude |

已知不准的地方：用户点了允许以后，要等这个工具跑完、`PostToolUse` 触发，状态才会变回“执行中”。工具跑得久（比如测试跑 5 分钟），这段时间会一直显示“等待授权”。按 Esc 中断不会触发 `Stop`，所以兜底规则是：显示“执行中”但日志 10 分钟没动静，就改成“空闲”。

### `--hook` 模式

- `App.swift` 在 SwiftUI 启动之前先检查参数：有 `--hook` 就走命令行分支，不启动界面
- 从 stdin 读 hook 的 JSON（最多读 64KB），只留 `hook_event_name`、`session_id`、`cwd`、`notification_type`、`message`、`tool_name` 和时间戳，追加一行到 `~/Library/Application Support/Quotlet/events.jsonl`
- **不联网**、不阻塞，永远 `exit 0`，目标是 20ms 内退出，不拖慢 Claude Code
- app 用 `DispatchSource` 盯着这个文件，读到新行就更新本地状态；登录了就上报。文件超过 1MB 时轮转

### 安装和卸载

- 写入前先把 settings.json 备份成 `settings.json.quotlet-bak`；只合并，不覆盖用户已有的 hooks；用临时文件 + rename 的方式原子写入
- 用命令末尾的 `# quotlet-hook` 标记认出我们加的条目，卸载时只删这些
- app 每次启动检查一次：如果 app 换了位置导致路径不对，自动修好；用户手动删掉了，就把开关显示为关闭
- 已知代价：用 `JSONSerialization` 重写会打乱 settings.json 里键的顺序和缩进，设置界面上要说明这一点

## 3. 登录

### 为什么先不做邮箱验证码

发验证码邮件需要一个能发信的域名。Resend 这类服务不验证自己的域名就只能发给自己；Cloudflare 自带的发信也只能发到已验证的地址。没有域名，就没法给别人发验证码。Apple、Google、GitHub 登录都不用发邮件，正好绕开这个问题。以后买了域名再加邮箱登录。

另外，App Store 规定：App 里提供了 Google 登录，就必须同时提供 Sign in with Apple。两个都做正好满足。

### 流程

所有客户端都用同一个网页登录页 `/login`，上面有 Apple、Google、GitHub 三个按钮：

- **网站**：Google 和 GitHub 走 OAuth 授权码流程（Google 加 PKCE）；Apple 走 `form_post` 回调。GitHub 没有 id_token，用 access token 调 `/user` 和 `/user/emails` 拿用户 id 和已验证邮箱，用完就丢，不保存。服务端校验 id_token（用 WebCrypto 验 RS256 签名，公钥从 Google/Apple 的 JWKS 拉取并缓存）。登录成功后设置 cookie `qb_session`（HttpOnly、Secure、SameSite=Lax）
- **Mac**：用 `ASWebAuthenticationSession` 打开 `/login?client=mac&state=…&code_challenge=…`。登录后跳回 `quotlet://auth?code=…`，Mac 拿 code 加 verifier 调 `/api/auth/exchange`，换回一个设备 token，存进 Quotlet 自己的钥匙串条目。这个方式不用在 Info.plist 里注册 URL scheme，也不用第三方 SDK
- **iOS**：Apple 用原生的 `ASAuthorizationAppleIDProvider`，拿到 identityToken 后调 `/api/auth/apple`；Google 和 GitHub 和 Mac 一样走 `ASWebAuthenticationSession`，不用引入第三方 SDK
- token 是 32 字节随机数，数据库只存它的 SHA-256。每次登录都对应 `devices` 表里的一行，可以在网站上逐个吊销

### 要先验证的风险（第一步就做）

- Apple 网页登录要在 Apple Developer 后台登记 Services ID、域名和回调地址。`*.workers.dev` 能不能登记，要先实际试一次
- Google OAuth 的授权域名填 `<sub>.workers.dev`（workers.dev 在公共后缀列表里，所以子域名算独立域名），也要先试一次
- App Store 要求“能在 App 里删除账号”，删除时还要调 Apple 的接口撤销 token。所以一期就要做删除账号

## 4. 数据库（D1）

```sql
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
```

时间一律存 Unix 毫秒。`Format.swift` 里的日历已经是 `autoupdatingCurrent`，按本机时区算日期，面向全球用户没问题。

## 5. 接口

所有接口都在 `/api` 下，返回 JSON。认证：网站用 cookie，App 和 Mac 用 `Authorization: Bearer <token>`。所有改数据的请求都检查 `Origin`（网站）或 Bearer。

### 登录 / 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/google/start`、`/auth/google/callback` | 网页 Google 登录 |
| GET | `/auth/apple/start`；POST `/auth/apple/callback` | 网页 Apple 登录 |
| GET | `/auth/github/start`、`/auth/github/callback` | 网页 GitHub 登录 |
| POST | `/api/auth/apple` | iOS 原生：`{identity_token, nonce, device:{name,kind}}` → `{token, user}` |
| POST | `/api/auth/exchange` | Mac/iOS：`{code, code_verifier, device:{name,kind}}` → `{token, user}` |
| POST | `/api/auth/logout` | 吊销当前设备 |
| GET | `/api/me` | 当前用户和设置 |
| PATCH | `/api/me` | 改通知偏好 |
| DELETE | `/api/me` | 删除账号（会撤销 Apple token） |

### 设备

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/devices` | 列表，带在线状态（3 分钟内有心跳算在线） |
| PATCH | `/api/devices/:id` | 改名；`remote_enabled` 只接受目标 Mac 自己的 token |
| DELETE | `/api/devices/:id` | 吊销 |
| PUT | `/api/devices/self/push` | iOS 上报 APNs token |

### Mac 上报（只接受 kind = mac 的 token）

| 方法 | 路径 | 内容 |
|---|---|---|
| POST | `/api/ingest/heartbeat` | `{app_version}`，更新 last_seen |
| PUT | `/api/ingest/usage` | `{plan, limits[], fetched_at}`，额度变了才发 |
| POST | `/api/ingest/sessions` | `{sessions:[…]}`，只发有变化的，单次最多 100 条 |
| POST | `/api/ingest/events` | `{events:[{session_id, ts, status, detail}]}`，状态一变就发 |
| PUT | `/api/ingest/daily` | `{full?, rows[]}`：app 启动 / 登录后第一次发 `full: true` 全量（服务端先清掉这台 Mac 的旧行），之后只发变了的行 |

免费套餐每次请求最多 50 条 D1 查询，所以批量写入都是一条语句 + `json_each(?)`，不按行拆。会话状态以 Mac 上报的为准（没开 hooks 时 Mac 按日志估算：3 分钟内有新回复算“执行中”，否则“已完成”）；只有状态变化时才记一条 `session_events`。

Worker 写完 D1 以后（里程碑 3 起）：调用这个用户的 UserHub 广播给在线的网站和 App；遇到下面的事件就发 APNs 推送。

### 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 每台 Mac 的额度 + Mac 在线状态 + 最近 30 个会话。PWA 每分钟拉一次。原计划的 `since` 增量没做：整包只有十几 KB，免费额度算的是请求数不是流量 |
| GET | `/api/sessions?status=&device=&days=&cursor=` | 会话列表 |
| GET | `/api/sessions/:id` | 会话详情 + 状态时间线 |
| GET | `/api/stats?from=YYYY-MM-DD` | 每日、按项目、按模型的 token（所有 Mac 加起来）。`from` 由浏览器按本地时区算；没传就用 `?days=30` 按 UTC 推 |
| GET | `/api/ws` | WebSocket，转给 UserHub；消息格式 `{type:'session'\|'usage'\|'device', data}` |

### 二期

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/commands` | `{device_id, session_id?, project?, prompt}`；目标 Mac 没开远程指令就返回 403 |
| GET | `/api/commands?session=` | 指令历史 |
| POST | `/api/commands/:id/status` | Mac 回报进度和结果 |

## 6. 推送规则

| 事件 | 推送 | 防打扰 |
|---|---|---|
| 进入“等待授权” | ◆ 等你授权 · 项目名 | 同一个会话 1 分钟内只推一次 |
| 进入“已完成” | ✓ 已完成 · 用时、token | 这一轮跑了不到 1 分钟就不推；手机正在看这个会话也不推 |
| 额度超过阈值、用满、重置 | 和 Mac 现在的通知一样 | 每个重置周期只推一次；和 Mac 本机通知是两套开关 |

灵动岛：App 发现有会话在执行中时，自己开启 Live Activity，并把 push token 上报给服务端；之后由服务端通过 APNs 推送更新，会话完成就结束。

## 7. 远程指令（二期）

- Mac 开启后和 UserHub 保持一个 WebSocket 连接。指令先存进 DO 的存储里，Mac 连上就发过去
- 执行方式：在会话的 cwd 下运行 `claude -p --resume <session_id> "<prompt>" --output-format stream-json`，权限沿用用户自己 Claude Code 的设置。如果这个会话正在终端里交互着，就拒绝执行，提示改用 `--fork-session` 开一个分支会话
- 安全措施：每台 Mac 单独开启，只有那台 Mac 自己能打开开关；可以选“每条指令都要在 Mac 上弹窗确认”；所有指令都留记录；只允许在近 30 天出现过的项目目录里执行
- 在手机上直接点“允许”：用 Claude Code 的 `PermissionRequest` hook 等服务端的决定，超时就退回在终端里点。开工前先确认当前 Claude Code 版本支持这个 hook 的行为

## 8. 代码放哪里

```
quotabar/
├─ Sources/Quotlet/          # 现有 Mac app
│   ├─ Cloud/CloudClient.swift    登录、上报、钥匙串
│   ├─ Cloud/HookInstaller.swift  装 / 卸 / 修复 hooks
│   └─ Cloud/HookEvents.swift     --hook 命令行分支 + 监听 events.jsonl
├─ cloud/                     # Worker（TypeScript）
│   ├─ src/                   路由、鉴权、ingest、UserHub、apns
│   ├─ migrations/            D1 建表脚本
│   ├─ web/                   网站前端（Vite），构建产物给 Worker 托管
│   └─ wrangler.jsonc
└─ ios/                       # SwiftUI App
```

Worker 只依赖 Hono（路由）。JWT 签名和校验都用 WebCrypto 自己写，不引入 jose。网站前端用 Vite + Preact，打出来的包小。iOS 想复用 `Theme.swift` 和 `Format.swift` 的话，得先把里面的 `NSColor`/AppKit 抽成跨平台写法。

服务端代码放在开源仓库里没问题，密钥都放 `wrangler secret`。以后提供“部署到自己的 Cloudflare 账号”也方便。

## 9. 里程碑

| # | 内容 | 状态 |
|---|---|---|
| 1 | **打通登录**：Worker 骨架 + D1 建表 + GitHub 登录（网页 + Mac） | ✅ 2026-11-17 完成。Apple / Google 登录还没做 |
| 2 | **Mac 上报 + 网站**：额度、会话、每日 token 上报，网站概览页和会话页（每分钟轮询） | ✅ 2026-11-18 代码完成、本地测通；线上部署见 10.6 |
| 3 | **hooks + 实时**：Mac 设置里的 hooks 开关（登录后才能开）、`--hook` 命令行分支、状态事件上报，UserHub 实时广播 | |
| 4 | **iOS App**：登录、概览、会话详情、APNs 推送、灵动岛，提交 TestFlight | |
| 5 | **二期**：远程指令、在手机上点允许、Apple / Google 登录、安卓原生 App（看需要再定） | |

## 10. 交接说明（新会话从这里开始）

### 10.1 需求原文（用户 2026-11-17 提出）

1. 使用 Cloudflare 的免费服务（服务器、数据库）
2. 开发在线网站、iOS App、Android App
3. Quotlet 能登录注册
4. Quotlet 上报数据和会话状态（执行中、执行完）
5. 网站和 App 能查看详情、知道会话状态，通过服务器交互
6. App 能下发指令，比如在外面让某个会话执行（二期）

### 10.2 用户拍板过的决定（不要再问）

- 先给自己用，以后开放给所有人，按多用户设计
- 域名：原定不买、用 workers.dev；改名后买了 `quotlet.com`。门户 `https://quotlet.com`，仪表盘和 API `https://app.quotlet.com`
- 目标是全球用户；国内直连 workers.dev 不通，但 `quotlet.com` 和 `app.quotlet.com` 国内不开代理也能打开（2026-11-18 实测）。Mac 端照样沿用已有的代理设置
- 登录：Apple + Google + GitHub，**先只做 GitHub**；邮箱验证码要等有域名能发信时再说
- iOS 用 SwiftUI 原生；Android 先用网站 PWA，页面开着时每分钟拉一次，不要求实时推送
- hooks 开关**必须登录后才能开**（没登录时 hooks 没用处）
- 远程指令要做（二期），默认关闭，必须登录后在那台 Mac 上手动开启
- **改名为 Quotlet**（2026-11-18）：quotabar.app 是另一个同名同类的开源工具 QuotaBar。新名 = quota + -let（小），取“低调、小巧”。门户 `quotlet.com`、仪表盘 `app.quotlet.com` 已上线（.com 续费 $11.17/年，比 .app 便宜）。GitHub 仓库已改名 `tluo-github/quotlet`（旧地址自动跳转），OAuth App 回调已改。**保留不改**：Mac bundle id `app.quotabar`、钥匙串条目 “Quotabar Cloud”、公证配置名 `quotabar-notary`、D1 库名 `quotabar`、Cloudflare 账号子域名 `quotabar`。`quotabar://` 回调过渡期继续认

### 10.3 Mac 端界面上用户定下的细节

- 登录入口在面板**右上角**：没登录是“登录”小按钮；登录后显示首字母头像 + 用户名 + 小箭头，点开是小卡片（头像、名字、邮箱、“在网页上查看”“退出登录”），**不要多余的说明文字**
- 刷新按钮在**底栏**，紧跟“20:50 更新”后面；⌘R 不变
- 登录在**默认浏览器新开标签页**完成（不用 ASWebAuthenticationSession 弹窗），登录后网页通过 `quotlet://auth?code=…&state=…` 回到 app，结果用系统通知提示
- 设置页暂时没有云同步分组；以后的上报开关、hooks 开关再放进设置

### 10.4 已经上线的东西

| 资源 | 值 |
|---|---|
| Worker | `app`，`https://app.quotlet.com`，代码在 `cloud/` |
| D1 | `quotabar`（亚太区），id 写在 `cloud/wrangler.jsonc`；`migrations/0001_init.sql` 已在线上执行 |
| Durable Object | `UserHub` 已声明，还是空类 |
| Cron | 每天 03:17 UTC，清理过期的登录 code |
| Worker secrets | `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（已设好，值不在仓库里） |
| GitHub OAuth App | 名字 Quotlet，回调 `https://app.quotlet.com/auth/github/callback` |
| 门户 Worker | `quotlet`，绑定 `quotlet.com` 和 `www.quotlet.com`（www 301 到主域名），代码在 `site/`，`scripts/deploy-site.sh deploy` 发布 |

已经实现的接口：`/login`、`/auth/github/start`、`/auth/github/callback`、`POST /api/auth/exchange`、`GET /api/me`、`DELETE /api/me`、`POST /api/auth/logout`、`GET /api/devices`、`DELETE /api/devices/:id`、`GET /api/health`。

里程碑 2 新增（代码在 `cloud/src/ingest.ts`、`cloud/src/read.ts`）：`/api/ingest/heartbeat|usage|sessions|events|daily`、`GET /api/overview`、`GET /api/sessions`、`GET /api/sessions/:id`、`GET /api/stats`；迁移 `0002_m2.sql`（只加索引）；Cron 增加清理：状态时间线 30 天、额度趋势 90 天、会话 90 天、每日 token 100 天。

网站（`cloud/web/static/`：`index.html` + `app.js` + `app.css`，原生 JS，不用构建）：概览（额度卡片、Mac 在线、最近会话按状态筛选）、会话列表（状态/设备筛选、加载更多）、会话详情（token 明细、状态时间线）、统计（7/30 天柱状图、按项目/模型）、设备（移除、退出登录）。hash 路由，页面开着时每分钟拉一次，切回前台立即拉。手机宽度下会话表格变成卡片。深色模式图表色用 `#D67352`（通过 dataviz 校验）。

Mac 端：`Sources/Quotlet/Cloud.swift`（登录、退出、校验 token、请求封装、钥匙串；token 缓存在内存），`CloudSync.swift`（上报：记住每样东西上次发出去的签名，变了才发；失败下一轮重试；没变化时 2 分钟一次心跳；401 自动退出），`Store.swift` 在额度刷新和会话扫描后调用 `CloudSync`，`Views.swift` 里的 `AccountButton` 和设置页“云同步”分组（上报开关、上传会话标题，默认都开），`App.swift` 里的 `AppDelegate` 接收 `quotlet://`，`Info.plist` 注册了 `quotlet` 和 `quotabar`（改名前的，过渡用）两个 scheme。

### 10.5 开发环境注意事项

- 代码在 `cloud` 分支，还没合并到 main
- `cloud/` 里的 wrangler 已经登录过 Cloudflare 账号；部署用 `cd cloud && npx wrangler deploy`，改了表结构用 `npx wrangler d1 migrations apply quotabar --remote`
- 网络：终端里有 HTTP 代理环境变量。wrangler 偶尔报 `fetch failed`，重试一次一般就好。npm 官方源很慢，装包用 `--registry=https://registry.npmmirror.com`，装完把 `package-lock.json` 里的地址改回 `registry.npmjs.org`
- Mac 开发版：`./build.sh` 打包到 `build/Quotlet.app`，用 `open build/Quotlet.app` 运行（先 `pkill -x Quotlet`），不要覆盖“应用程序”里的正式版
- 开发版是临时签名，每次重编译后第一次读钥匙串会弹授权框，点“始终允许”
- 看 Mac 端联网日志：直接运行 `build/Quotlet.app/Contents/MacOS/Quotlet`，stderr 里有 `[cloud]` 开头的记录
- 截图检查界面：`build/Quotlet.app/Contents/MacOS/Quotlet --snapshot <目录> -stage YES -demo YES -offline YES -scale 2`，加 `-cloudPreviewUser 名字` 可以看已登录的样子。截图模式不读钥匙串
- **本地联调 Mac 上报**：`cd cloud && npx wrangler d1 migrations apply quotabar --local`，往本地 D1 插一个用户和一台 kind=mac 的设备（token_hash = base64url(sha256(token))），`npx wrangler dev --port 8787`，再运行 `build/Quotlet.app/Contents/MacOS/Quotlet -cloudBaseURL http://localhost:8787 -cloudDevToken <token>`。这两个参数只走启动参数，不写 UserDefaults、不碰钥匙串
- 网站截图：无头 Chrome + CDP（`Network.setCookie` 设 `qb_session`），本次用的脚本没进仓库
- `pkill -x Quotlet` 会把“应用程序”里的正式版也关掉，测完记得 `open -a /Applications/Quotlet.app`
- **提交前检查敏感数据**：GitHub secret、Cloudflare 账号 id、个人邮箱都不能进仓库

### 10.6 下一步

**0.5.0（2026-11-18 发布）做了什么**
- 改名 Quotlet；启动时发现 `/Applications/Quotabar.app` 会先退出旧版、问要不要移到废纸篓，开机启动重新登记（`LegacyApp.swift`）
- 界面改成三层（设计稿 https://claude.ai/artifact/RKtmYvfpht48cNTsWdZzMS）：状态栏不变；面板只看配额（Claude + Codex 各一组 + 告急时的建议条）和「今天」（输出、输入、请求、平均 / 峰值速度、API 等值费用）；「历史」打开独立的用量历史窗口（`History.swift`）
- 读 Codex 本机日志（`Codex.swift`）：额度、套餐、每次回复的 token 和耗时；排除 Codex 桌面版从 Claude Code 导入的会话（`~/.codex/external_agent_session_imports.json`）
- 速度 = 输出 token ÷ 回复耗时（输出 < 20 token 的回复不计）；费用按官方 API 价格（`Pricing.swift`），Codex 模型价格未知不算
- 每日汇总和额度读数存在 `~/Library/Application Support/Quotlet/`（`HistoryStore.swift`），Claude Code 清理 30 天前日志后历史还在
- 云同步仍只上报 Claude 的会话和 token（`snap.only(.claude)`），网站还不区分来源
- 演示视频脚本删了，换成 `scripts/make-screenshots.sh`（静态截图，历史窗口用真实窗口截屏）

**之后可以做的**
- 网站仪表盘也显示 Codex 额度和来源（上报加 source 字段）
- Codex 模型价格公开后补进 `Pricing.swift`

**里程碑 3：hooks + 实时**

1. `--hook` 命令行分支（第 2 节）：`App.swift` 启动前判断参数，写 `events.jsonl`
2. `HookInstaller`：装 / 卸 / 修复，设置页“云同步”分组里加“精确的会话状态”开关（登录后才能开）
3. `CloudSync` 监听 `events.jsonl`：hooks 给出的状态覆盖按日志估算的状态（`sessionPayload` 里合并），状态一变就调 `/api/ingest/events`（接口已经有了）
4. UserHub：ingest 写完 D1 后广播；网站连 `/api/ws`，连不上退回每分钟轮询

## 11. 以后要在各家后台做的

- Apple Developer：给 iOS App 建 App ID `app.quotlet.ios`，开通 Sign in with Apple 和 Push Notifications；建 Services ID `app.quotlet.web`（域名 `app.quotlet.com`，回调 `/auth/apple/callback`）；建 APNs Key（.p8）
- Google Cloud：OAuth 同意屏幕 + Web 客户端 ID（回调 `/auth/google/callback`）
