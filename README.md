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
| `HERMES_PROFILE` | stdio 壳 | stdio 壳 / CLI 使用的 Profile 名；纯 HTTP 直连的 daemon 不读该变量（Profile 走 `X-Hermes-Profile` 头） |
| `QWEATHER_API_HOST` | 天气需要 | QWeather 控制台获取的自定义 API Host |
| `QWEATHER_KEY` | | API KEY 凭据；**回退方案**（官方自 2027-02-01 起逐步限制其每日请求量） |
| `QWEATHER_JWT_KEY_ID` / `QWEATHER_JWT_PROJECT_ID` / `QWEATHER_JWT_DEVELOPER_ID` / `QWEATHER_JWT_PRIVATE_KEY_PATH` | | **推荐**：Ed25519 JWT 认证。前三个是控制台的凭据 ID / 项目 ID / 开发者 ID，第四个是仓库外的私钥 PEM 路径（如 `~/.secrets/qweather-ed25519.pem`，权限 600）。四项**要么全配、要么全不配**：只写一半会启动报错，不会静默退回 API KEY。两者都配时优先 JWT |
| `QWEATHER_JWT_TTL_SECONDS` | | JWT 有效期，默认 `43200`（12 小时），上限 `86400` |
| `DEFAULT_CITY` | | Profile 未设位置时的兜底城市 |
| `HOST` / `PORT` | | 默认 `127.0.0.1:3080`；**非回环地址必须配 `WEB_API_TOKEN`**，否则拒绝启动 |
| `WEB_API_TOKEN` | | 非回环地址必填；保护 `/api/*`（Bearer 或 `?token=`）与 `/mcp`（仅 Bearer） |
| `MCP_DAEMON_TOKEN` | | stdio 壳访问 daemon 用的 token；缺省复用 `WEB_API_TOKEN` |
| `PROFILE_ROUTE_SECRETS_JSON` | 主动推送需要 | `'{"default":"<openssl rand -hex 32>"}'`（整段用单引号包裹） |
| `DAILY_BRIEF_CRON` | | 每日简报时间，默认 `'0 7 * * *'`（含空格需单引号，Asia/Shanghai） |
| `ALERT_WATCH_CRON` | | 气象预警巡检时间，默认 `'*/20 * * * *'` |
| `ALERT_MIN_LEVEL` | | 低于此级别的预警不主动推送，`blue|yellow|orange|red`，默认 `blue`（=全部级别都推） |
| `WORKDAY_WATCH_CRON` | | 调休/补班提醒巡检时间，默认 `'0 7 * * *'` |
| `WORKDAY_REMIND_DAYS_BEFORE` | | 假期首日前几天推放假安排，默认 `3`（上限 30） |
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
- 配了 `WEB_API_TOKEN` 时两者都需凭据：`/api/*` 接受 Bearer 或 `?token=`，
  `/mcp` 只接受 `Authorization: Bearer`（避免凭据出现在 URL/日志里）
- 状态页的 `holidays.failed` 会列出抓取失败的年份与原因（数据未就绪会让
  `workday/holiday` 过滤的日程暂停，这里能直接看出是抓取失败还是尚未发布）

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

导入是**逐行隔离**的：单条坏数据（金额非法、日期无法解析、引用不存在的账本、主键冲突等）
不会中断整次导入，而是被跳过并在最后以 `[表] id：原因` 列出，进程以退出码 2 结束。
合法数据照常入库，不必因为一条脏数据重来。`--force` 会先清除**本次导入涉及**的
Profile / 账本数据再写入（不影响其它 Profile），失败时整体回滚。

## 开发

```bash
npm run dev            # tsx 直接跑 daemon
npm test               # node --test（171 个用例）
npm run lint           # Biome lint（0 警告）
npm run format:check   # Biome 格式检查（CI 也跑）
npm run db:backup      # VACUUM INTO 备份，保留最近 14 份
```

结构：`src/core`（database/registry/auth/http/logger/settings/notify/render/qweather/holiday/recurrence）、`src/modules`（weather/holiday/schedule/bookkeeping/notify，经 `modules/index.ts` 注册，核心不反向依赖）、`src/server`（status/page/details，状态页与只读 API）、`src/daemon.ts`、`src/stdio.ts`、`src/import-v1.ts`、`src/backup.ts`。

## 设计要点

- **单写者**：所有 SQLite 写入收敛到 daemon，WAL + 严格 schema（STRICT 表、CHECK、外键）。
- **模块契约**：模块注册 `tools / jobs / tick / onStart` 四个扩展点；调度保证 tick 不重叠；核心不 import 模块内部。
- **recurrence 引擎**：自研纯函数替代 rrule，只覆盖 daily/weekly/monthly/yearly × 农历 + 工作日过滤；漏触发只补最近一次。
- **outbox**：通知 + 投递记录同事务写入；发布即触发投递；静默时段只拦主动推送。
- **时区**：全部调度固定 Asia/Shanghai，无 DST。
- **QWeather 请求治理**：按数据类型短 TTL 缓存（`CACHE_TTL_MS`：实时 20min / 逐天 2h 且取 `min(2h, 距本地次日 00:00)` / 预警 10min / 空气质量 45min，只有成功响应才写缓存）；同进程并发上限 3；仅对 429/5xx 与网络故障做指数退避（`2^c` 秒 + 抖动，c 上限 10），**4xx 一律立即抛出** —— 官方明确反复重试错误请求会被判定为攻击并冻结账号。认证优先 JWT（EdDSA），API KEY 保留回退。**GeoAPI 结果不得落盘缓存/批量存储/建索引**（官方版权限制），只允许进程内 memo。
- **主动推送**：定时任务组装**确定性**通知（无 LLM），走 outbox 投递：每日天气简报与调休/补班提醒 07:00、气象预警巡检每 20 分钟、月报每月 1 号 09:00；节假日数据刷新 02:00、历史 occurrence 回收 04:30。预警与补班都靠 `dedupe_key` 去重（预警按「id + 级别」，级别升级会再推一次；补班按「事件 + 日期」），静默时段在投递层统一拦截、不为任何类型开例外。
- **物化窗口**：occurrence 只物化到 `now + 62 天`。若某日程此刻一条 `pending` 都没有（远期生日、远期一次性待办），额外豁免**恰好 1 条**越过窗口的 occurrence，保证「下一条」在 `list`/`upcoming`/状态页始终可见；豁免资格取自入库状态，补上第一条即失效，因此不会随时间累积增长。
- **历史回收**：`schedule.occurrence_cleanup`（每日 04:30）只清理 90 天前的 `notified`/`done`/`cancelled` 行 —— `pending` 永不删；使用 `recurrence.count` 的日程整条豁免（发生次数上限依赖历史行数，删历史会让已达上限的循环复活）。上线或调参前可用 `previewOccurrenceCleanup(db, days)` 只读预演将删除的行数与涉及日程。

### 已知取舍与后续优化（尚未实施）

按收益排序，均为「已识别但未做」的项，当前实现是正确的、只是不够省：

1. ~~**QWeather 天气数据无缓存/限流/退避**~~ —— **已实施（2026-09-18）**：按官方推荐值加短 TTL 缓存、并发上限 3、仅对 429/5xx 指数退避（4xx 绝不重试），并停止把 GeoAPI 结果落盘（官方版权限制）。
2. ~~**认证方式建议迁移 JWT**~~ —— **已实施（2026-09-18）**：支持 Ed25519 JWT（`Authorization: Bearer`，URL 不再带 `key=`）并优先使用，API KEY 保留回退。官方口径：自 **2027-02-01** 起逐步限制 API KEY 的每日请求量，SDK v5+ 仅支持 JWT。
3. **v7 城市版端点已宣布弃用**：迁移到 v1 `/weather/v1/...` 时注意 `humidity` 在 v1 是 0–1 小数
   （v7 是百分数），且数值包在 `{value, unit}` 里 —— 直接换路径会静默错报湿度。
4. **`summarizeExpenses` 不是单快照**：三条独立语句，跨进程并发写入时「合计」可能与分类明细不一致；
   加 `BEGIN DEFERRED` 读事务即可。
5. **契约测试名不副实**：`tests/registry.test.ts` 的注释声称「核心不 import 模块内部由该测试强制」，
   但它只在运行时检查重名。若要真正强制，需加静态 import 图检查或 lint 规则。
6. **`schedules.version` 列未参与并发控制**：每次更新 +1，但没有乐观校验；单写者下风险低，
   可删列或落实校验。
7. **节假日刷新节奏**：`FETCH_COOLDOWN_MS` 是 6h，但主动重试点仍是每天 02:00 的 job（`requiredYears()` 到 10 月才要求下一年），实际重试间隔为 24h。物化撞到未就绪年份的路径已改为由 `tick()` 触发按需补齐、真正受 6h 冷却约束；若要提前拿到下一年数据，可把 job 改为 `0 */3 * * *`。
8. **`status` 页面无鉴权**（`/` 只有静态 HTML，数据走受保护的 `/api/status`），
   如需对外暴露建议一并加保护。
