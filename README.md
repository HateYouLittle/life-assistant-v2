# Life Assistant v2

个人生活助理 MCP 服务（[v1](https://github.com/HateYouLittle/life-assistant) 的全面重构版），面向 Hermes Agent。

单守护进程架构：一个常驻进程承载 **MCP over Streamable HTTP**、**定时调度**、**outbox 主动推送** 与**状态页**；SQLite（Node ≥22 内置 `node:sqlite`）单写者，无跨进程并发防护。

| 能力 | 说明 |
|---|---|
| 天气 | QWeather 实时 / 7 日预报 / 官方预警 |
| 空气质量 | QWeather 国标 AQI（cn-mee）、PM2.5/PM10 |
| 每日简报 | 每日 07:00（可配）确定性组装，无 LLM |
| 日程 | 待办/生日/纪念日，公历+农历（闰月策略、腊月三十顺延）、按法定工作日/节假日重复 |
| 节假日 | 大陆法定节假日/调休日历，每日 02:00 自动抓取校验 |
| 记账 | 全局多账本、只记支出（可改可删），月度账单推送 |
| 通知 | SQLite outbox + HMAC V2 回环 webhook、静默时段、`notify.pull` 兜底 |

相对 v1 的主要变化：**单守护进程**（去掉 stdio 查询进程与 scheduler 的双进程并发防护）；**46 个工具收敛为 7 个**（域内 action 参数化）；**舍弃**油价、共享账本角色、生活指数、自动化 DSL、Open-Meteo 多源回退、React 仪表盘；通知改为 **Markdown 表格**渲染（微信/企业微信）。

## 安装

要求 Node.js ≥ 22.13。

```bash
npm install
cp .env.example .env   # 编辑配置；chmod 600 .env
npm run typecheck && npm test
npm run build
```

`npm start` / `npm run dev` / `npm run db:backup` / `npm run import:v1` 会用 Node 的
`--env-file-if-exists=.env` 自动读取同目录 `.env`（已存在的环境变量优先，systemd 的
`EnvironmentFile` 不受影响）。手工执行其他命令时可 `set -a; source .env; set +a`。

### 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATA_DIR` | ✅ | 绝对路径；SQLite 与备份所在地 |
| `HERMES_PROFILE` | ✅ | stdio 壳 / CLI 使用的 Profile 名 |
| `QWEATHER_API_HOST` / `QWEATHER_KEY` | 天气需要 | QWeather 控制台获取 |
| `DEFAULT_CITY` | | Profile 未设位置时的兜底城市 |
| `HOST` / `PORT` | | 默认 `127.0.0.1:3080`；**非回环地址必须配 `WEB_API_TOKEN`**，否则拒绝启动 |
| `WEB_API_TOKEN` | | 非回环地址必填；同时保护 `/api/*` 与 `/mcp`（Bearer 或 `?token=`） |
| `MCP_DAEMON_TOKEN` | | stdio 壳访问 daemon 用的 token；缺省复用 `WEB_API_TOKEN` |
| `PROFILE_ROUTE_SECRETS_JSON` | 主动推送需要 | `'{"default":"<openssl rand -hex 32>"}'`（整段用单引号包裹） |
| `DAILY_BRIEF_CRON` | | 每日简报时间，默认 `'0 7 * * *'`（含空格需单引号，Asia/Shanghai） |
| `MCP_DAEMON_URL` | | stdio 壳连接的 daemon 地址，默认 `http://127.0.0.1:3080` |
| `LOG_LEVEL` | | `debug`/`info`/`warn`/`error`，默认 `info` |

> 安全默认：daemon 只应绑定回环地址。要跨机访问，请用 SSH 隧道或反代，并把
> `WEB_API_TOKEN` 同时配给调用方（MCP 直连用 `Authorization: Bearer`，stdio 壳用 `MCP_DAEMON_TOKEN`）。

## 启动

```bash
npm start            # node --env-file-if-exists=.env dist/daemon.js
```

daemon 就绪后：

- MCP 端点：`http://127.0.0.1:3080/mcp`（Streamable HTTP）
- 状态页：`http://127.0.0.1:3080/`（`/api/status` 同源）
- `X-Hermes-Profile` 头决定 Profile；缺省为 `default`
- `/mcp` 与 `/api/*` 共用鉴权：配置了 `WEB_API_TOKEN` 时两者都需要凭据

### 注册到 Hermes

**方式 A（推荐）：stdio 兼容壳**——daemon 常驻，Hermes 按标准 stdio 方式拉起轻量转发壳：

```bash
hermes mcp add life-assistant --command node \
  --env DATA_DIR=/abs/path/data HERMES_PROFILE=default MCP_DAEMON_URL=http://127.0.0.1:3080 \
  --args /abs/path/dist/stdio.js
```

每个 Profile 注册一次（各自的 `HERMES_PROFILE`），共用同一 daemon 与 `DATA_DIR`。
若 daemon 设了 `WEB_API_TOKEN`，这里再补一个 `MCP_DAEMON_TOKEN=<同值>`（或缺省复用 `WEB_API_TOKEN`）。

**方式 B：HTTP 直连**（若 Hermes 支持远程 MCP）：直接填 `http://127.0.0.1:3080/mcp`，headers 里加 `X-Hermes-Profile`；配了 token 时再加 `Authorization: Bearer <WEB_API_TOKEN>`。

Skill 安装：将 `skill/SKILL.md` 复制到该 Profile 的 `skills/life-assistant/` 目录。

### 主动推送（微信/企业微信等）

1. Hermes 侧启用 Webhook platform（`gateway setup`），各 Profile 端口不同；
2. 生成 secret：`openssl rand -hex 32`，写入 `.env` 的 `PROFILE_ROUTE_SECRETS_JSON`；
3. 在对话中或直接调用：`notify {action: "route", url: "http://127.0.0.1:<gateway端口>/...", platform: "wechat"}`；
4. 用一条临时日程做端到端验证。

投递协议与 v1 完全兼容：`POST`（deliver-only）、`X-Webhook-Signature-V2 = hex(HMAC-SHA256(secret, "timestamp.body"))`、`X-Webhook-Timestamp`、`X-Request-ID`、10s 超时、有界重试（确认失败 ≤5 次退避 60s→1h；传输不确定 ≤3 次），at-least-once、55 分钟幂等窗口。

### systemd

```ini
[Unit]
Description=Life Assistant v2 daemon
After=network-online.target

[Service]
Type=simple
User=life-assistant
Group=life-assistant
Restart=always
RestartSec=10
EnvironmentFile=/abs/path/life-assistant/.env
WorkingDirectory=/abs/path/life-assistant
ExecStart=/usr/bin/node --env-file-if-exists=.env /abs/path/life-assistant/dist/daemon.js
# 可选加固（数据目录需可写）
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now life-assistant
```

### 每日自动备份（建议）

daemon 不会自己备份，用一个 timer 每天跑一次 `db:backup`（VACUUM INTO，保留最近 14 份）：

```ini
# /etc/systemd/system/life-assistant-backup.service
[Unit]
Description=Life Assistant v2 backup

[Service]
Type=oneshot
User=life-assistant
EnvironmentFile=/abs/path/life-assistant/.env
WorkingDirectory=/abs/path/life-assistant
ExecStart=/usr/bin/node /abs/path/life-assistant/dist/backup.js
```

```ini
# /etc/systemd/system/life-assistant-backup.timer
[Unit]
Description=Daily Life Assistant v2 backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload && systemctl enable --now life-assistant-backup.timer
```

备份落在 `$DATA_DIR/backups`，与数据库同盘：重要数据建议再同步到别的机器/盘（如 `rsync` 到 NAS）。

## 从 v1 迁移

```bash
npm run import:v1 -- --from /旧/DATA_DIR [--force]
```

一次性导入旧库的 Profile、静默时段、日程、账本（变全局可编辑）、支出账目、节假日数据。旧 occurrence 不迁移（v2 按规则重新物化）；收入/转账账目、deadline 提醒、共享账本角色不迁移，均会在报告中列明。建议先对旧库做备份。

## 开发

```bash
npm run dev            # tsx 直接跑 daemon
npm test               # node --test（114 个用例）
npm run lint           # Biome（0 警告）
npm run db:backup      # VACUUM INTO 备份，保留最近 14 份
```

结构：`src/core`（database/registry/notify/render/qweather/holiday/recurrence/http/auth）、`src/modules`（weather/holiday/schedule/bookkeeping/notify，经 `modules/index.ts` 注册，核心不反向依赖）、`src/daemon.ts`、`src/stdio.ts`、`src/import-v1.ts`、`src/backup.ts`。

## 设计要点

- **单写者**：所有 SQLite 写入收敛到 daemon，WAL + 严格 schema（STRICT 表、CHECK、外键）。
- **模块契约**：模块注册 `tools / jobs / tick / onStart` 四个扩展点；调度保证 tick 不重叠；核心不 import 模块内部。
- **recurrence 引擎**：自研纯函数替代 rrule，只覆盖 daily/weekly/monthly/yearly × 农历 + 工作日过滤；漏触发只补最近一次。
- **outbox**：通知 + 投递记录同事务写入；发布即触发投递；静默时段只拦主动推送。
- **时区**：全部调度固定 Asia/Shanghai，无 DST。
