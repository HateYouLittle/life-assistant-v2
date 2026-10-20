# Life Assistant v2

个人生活助理 MCP 服务（[v1](https://github.com/HateYouLittle/life-assistant) 的全面重构版），面向 Hermes Agent。

单守护进程架构：一个常驻进程承载 **MCP over Streamable HTTP**、**定时调度**、**outbox 主动推送** 与**状态页**；SQLite（Node ≥22 内置 `node:sqlite`）单写者，无跨进程并发防护。

| 能力 | 说明 |
|---|---|
| 天气 | QWeather 实时 / 7 日预报 / 官方预警；出行模式（行程期间自动切到目的地） |
| 空气质量 | QWeather 国标 AQI（cn-mee）、PM2.5/PM10 |
| 每日简报 | 每日 07:00（可配）确定性组装，无 LLM；含今日日程/逾期未完成与下个假期倒计时；21:00 晚报（可配）给明日天气、明日日程与今日未完成 |
| 日程 | 待办/生日/纪念日，公历+农历（闰月策略、腊月三十顺延）、按法定工作日/节假日重复；`snooze`/`skip` 处置单次，`complete` 对循环默认只完成当前一次（`all: true` 才结束系列） |
| 节假日 | 大陆法定节假日/调休日历，每日 02:00 自动抓取校验（数据源 `NateScarlet/holiday-cn` 的 jsDelivr / GitHub raw；无外网时 `workday/holiday` 过滤的日程会暂停并在状态页 `holidays.failed` 显示原因；次年数据未发布记 `pending` 而不是失败） |
| 记账 | 家庭/个人多账本、只记支出（可编辑已记支出，编辑不触发回执/预算提醒）、CSV 导出，账本/分类月度预算与 80%/100% 跨阈值提醒（按支出所属月份判定）、月度账单推送；默认账本/常用分类降低摩擦 |
| 通知 | SQLite outbox + 可扩展投递通道（HMAC V2 回环 webhook / 本地 log）、静默时段、`notify.pull` 兜底 |
| 备份 | daemon 内置每日 03:00 `VACUUM INTO` 备份（保留 14 份，时间与份数可配），产物自校验；schema 升级前自动留快照；`npm run db:restore` 校验并留底后一键恢复 |
| 任务可靠性 | 每个定时任务写 `job_runs`（running→ok/failed/skipped）；停机期间错过的每日任务在启动时按白名单补发；状态页「定时任务」卡片与 `doctor --live` 可见 |
| 部署安全 | 单实例锁、umask 077（库/备份 0600）、Host/Origin 守卫（DNS rebinding 防护）、`REQUIRE_AUTH` 强制鉴权、`WEB_ALLOWED_HOSTS` 放行名单 |

相对 v1 的主要变化：**单守护进程**（去掉 stdio 查询进程与 scheduler 的双进程并发防护）；**46 个工具收敛为 7 个**（域内 action 参数化）；**舍弃**油价、共享账本角色、生活指数、自动化 DSL、Open-Meteo 多源回退、React 仪表盘；通知改为 **Markdown 表格**渲染（微信/企业微信）。

阶段进度与后续路线图见 [ROADMAP.md](ROADMAP.md)（当前：v2.0.0 / schema v4，阶段一「可靠性 + 安全基线 + 每日闭环」已完成）。

## 安装

要求 Node.js ≥ 22.16（`node:sqlite` 的 `isOpen` / `isTransaction` 需要该版本）。

```bash
npm install
cp .env.example .env   # 编辑配置；chmod 600 .env
npm run typecheck && npm test
npm run build
```

`npm start` / `npm run dev` / `npm run db:backup` / `npm run db:cleanup:preview` /
`npm run db:restore` / `npm run doctor` / `npm run import:v1` 会用 Node 的 `--env-file-if-exists=.env` 自动读取同目录 `.env`
（已存在的环境变量优先，systemd 的 `EnvironmentFile` 不受影响）。手工执行其他命令时可
`set -a; source .env; set +a`。

### 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATA_DIR` | ✅ | 绝对路径；SQLite 与备份所在地 |
| `HERMES_PROFILE` | stdio 壳 | stdio 壳 / CLI 使用的 Profile 名；纯 HTTP 直连的 daemon 不读该变量（Profile 走 `X-Hermes-Profile` 头） |
| `QWEATHER_API_HOST` | 天气需要 | QWeather 控制台获取的自定义 API Host |
| `QWEATHER_KEY` | | API KEY 凭据；**回退方案**（官方自 2027-02-01 起逐步限制其每日请求量） |
| `QWEATHER_JWT_KEY_ID` / `QWEATHER_JWT_PROJECT_ID` / `QWEATHER_JWT_DEVELOPER_ID` / `QWEATHER_JWT_PRIVATE_KEY_PATH` | | **推荐**：Ed25519 JWT 认证。前三个是控制台的凭据 ID / 项目 ID / 开发者 ID，第四个是仓库外的私钥 PEM **绝对路径**（如 `/home/you/.secrets/qweather-ed25519.pem`，权限 600；`~` 不会被展开）。四项**要么全配、要么全不配**：只写一半会启动报错，不会静默退回 API KEY。注意启动阶段只校验"四项是否齐全"——私钥文件不存在/不可读/非 Ed25519 PKCS8 时报错发生在**第一次天气请求**，不在启动时。两者都配时优先 JWT |
| `QWEATHER_JWT_TTL_SECONDS` | | JWT 有效期，默认 `43200`（12 小时），上限 `86400` |
| `DEFAULT_CITY` | | Profile 未设位置时的兜底城市，默认 `北京` |
| `HOST` / `PORT` | | 默认 `127.0.0.1:3080`；**非回环地址必须配 `WEB_API_TOKEN`**，否则拒绝启动。`HOST` 只写主机（可含 scheme，如 `http://127.0.0.1`；IPv6 回环可写 `[::1]` 或 `::1`），端口一律用 `PORT` 指定，误写成 `127.0.0.1:3080` 会报错 |
| `WEB_API_TOKEN` | | 非回环地址必填且**至少 32 字符**（回环地址下短 token 只告警不拦截）；保护 `/api/*`（Bearer 或 `?token=`）与 `/mcp`（仅 Bearer） |
| `MCP_DAEMON_TOKEN` | | stdio 壳访问 daemon 用的 token；缺省复用 `WEB_API_TOKEN` |
| `REQUIRE_AUTH` | | 设为 `1` 时即使只绑回环也强制要求 `WEB_API_TOKEN`，缺失则拒绝启动（默认关闭，保留本地零配置） |
| `WEB_ALLOWED_HOSTS` | | 额外放行的 Host 名单（逗号分隔；带端口则精确匹配，裸主机不限端口）。绑定 `0.0.0.0` 或经反代/DNS 名访问时必须配置，否则请求被 403 |
| `PROFILE_ROUTE_SECRETS_JSON` | 主动推送需要 | `'{"default":"<openssl rand -hex 32>"}'`（整段用单引号包裹；每个 secret **至少 32 字符**） |
| `DAILY_BRIEF_CRON` | | 每日简报时间，默认 `'0 7 * * *'`（含空格需单引号，Asia/Shanghai） |
| `EVENING_BRIEF_CRON` | | 晚报时间，默认 `'0 21 * * *'`；内容为明日天气/明日日程/今日未完成/明天补班或放假 |
| `ALERT_WATCH_CRON` | | 气象预警巡检时间，默认 `'*/20 * * * *'` |
| `ALERT_MIN_LEVEL` | | 低于此级别的预警不主动推送，`blue|yellow|orange|red`，默认 `blue`（=全部级别都推） |
| `WORKDAY_WATCH_CRON` | | 调休/补班提醒巡检时间，默认 `'0 7 * * *'` |
| `WORKDAY_REMIND_DAYS_BEFORE` | | 假期首日前几天推放假安排，默认 `3`（上限 30）；`0` 表示关闭「假期临近」提醒（首日当天也不推） |
| `BACKUP_CRON` | | daemon 内置每日备份时间，默认 `'0 3 * * *'`（含空格需单引号，Asia/Shanghai）；非法 cron 拒绝启动 |
| `BACKUP_KEEP` | | 备份保留份数，默认 `14`（1..365）；超出部分按文件名时间戳清理最旧的 |
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
- 存活探针：`http://127.0.0.1:3080/healthz`（**不鉴权**，只回 `{ok, version, uptime_s}`，库打不开时 503）——给 systemd / uptime 监控用，别用需要 token 的 `/api/status`
- 只读 API（同样受 `WEB_API_TOKEN` 保护；`/api/*` 一律 `Cache-Control: no-store`）：

  | 端点 | 参数 | 内容 |
  |---|---|---|
  | `/api/status` | — | 概览（首屏数据源） |
  | `/api/expenses` | `month`（YYYY-MM）、`limit` | 分类/按天/逐笔支出 |
  | `/api/expenses.csv` | `month`（YYYY-MM） | 家庭账本支出 CSV（UTF-8 BOM、附件下载；与看板口径一致，不含个人账本） |
  | `/api/schedules` | `limit` | 跨 Profile 的活跃日程与下次触发 |
  | `/api/deliveries` | `limit` | 投递计数、近 7 天分布与记录 |
  | `/api/holidays` | `year` | 假期/调休安排与接下来的假期 |

- `X-Hermes-Profile` 头决定 Profile；缺省为 `default`
- MCP 会话：空闲 2 小时回收、最多 200 个；daemon 重启后旧 `mcp-session-id` 一律返回 404，
  调用方需重新 `initialize`（stdio 壳会自动重连重试，HTTP 直连的客户端要自行处理）
- 状态页带 CSP（`script-src 'nonce-…'`），页面脚本每次请求一个新 nonce
- 配了 `WEB_API_TOKEN` 时两者都需凭据：`/api/*` 接受 Bearer 或 `?token=`，
  `/mcp` 只接受 `Authorization: Bearer`（避免凭据出现在 URL/日志里）。
  看板只需用 `http://127.0.0.1:3080/?token=<WEB_API_TOKEN>` 打开一次：页面会把
  凭据记进浏览器 `localStorage` 并立刻从地址栏抹掉，之后直接访问 `/` 即可
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
   `channel` 缺省为 `webhook`（HMAC V2 回环投递）；本地联调可传 `channel: "log"`，此时不需要 URL 与 secret，通知只写进程日志并标记为已投递；
4. 用一条临时日程做端到端验证。

注意：路由是「从此刻起生效」，不会把配置之前已产生的通知补推一遍（那些仍可由
`notify.pull` 取到）；配置后新产生的通知才会走已配置的通道。

`webhook` 通道的投递协议与 v1 完全兼容：`POST`（deliver-only）、`X-Webhook-Signature-V2 = hex(HMAC-SHA256(secret, "timestamp.body"))`、`X-Webhook-Timestamp`、`X-Request-ID`、10s 超时、有界重试（确认失败 ≤5 次退避 60s→1h；传输不确定 ≤3 次），at-least-once、55 分钟幂等窗口。

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

### 备份

daemon 内置每日备份 job（`BACKUP_CRON`，默认 `'0 3 * * *'` Asia/Shanghai）：用 `VACUUM INTO`
生成 `$DATA_DIR/backups/life-assistant-<时间戳>.db`，只保留最近 `BACKUP_KEEP`（默认 14）份。
备份是只读快照，daemon 运行中执行是安全的，不需要停服。

- 想立刻备份：`npm run db:backup`（与内置 job 共用同一实现，CLI 会打印产物路径，同样执行保留清理）。
- **daemon 停机期间不会产生备份**：如果机器会长期停机、或希望备份与运行解耦，可以继续用外部
  timer 每天跑一次 `db:backup`（与内置 job 共用保留策略），两者并存不会互相破坏：

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

### 恢复备份

优先用内置 CLI：它会先校验备份、把当前库留底，并拒绝在 daemon 运行时操作。

```bash
systemctl stop life-assistant          # launchd 下用 launchctl stop/bootout
npm run db:restore -- --latest         # 默认取最近一份规范备份；--file 指定，--dry-run 只预演
systemctl start life-assistant
```

恢复会做四件事：校验（`quick_check` + 可读 `meta.schema_version` 且不高于当前程序，坏备份/高版本备份一律拒绝，绝不覆盖现库）→ 检测 `daemon.lock`（daemon 仍存活则拒绝）→ 把当前库复制为 `$DATA_DIR/backups/life-assistant-pre-restore-<时间戳>.db` → 覆盖并清掉 `-wal`/`-shm`、重新校验、权限收紧到 0600。因此不需要手工 `cp`/`rm`。

CLI 不可用时的兜底步骤：

```bash
systemctl stop life-assistant
cp $DATA_DIR/life-assistant.db $DATA_DIR/life-assistant.db.broken   # 留一份现场
rm -f $DATA_DIR/life-assistant.db-wal $DATA_DIR/life-assistant.db-shm
cp $DATA_DIR/backups/life-assistant-<时间戳>.db $DATA_DIR/life-assistant.db
systemctl start life-assistant
```

备份文件是 `VACUUM INTO` 产物，可直接用 `sqlite3 <备份> "PRAGMA integrity_check;"`
自检，也可以只从里面捞单条数据（`ATTACH` 后 `INSERT ... SELECT`）而不整库回滚。`doctor --live`
会把最近备份的年龄（>36h warn、>7 天 fail）与非规范文件（`*-pre-v3-*.db`、`*-pre-restore-*.db`
等）一并列出。

### 故障排查

| 症状 | 原因与处置 |
|---|---|
| 启动即退出，日志 `DATA_DIR 未设置/必须是绝对路径` | `.env` 没被读到（换过工作目录？）或写成了相对路径 |
| 启动即退出，`schema 版本 N 高于程序支持的 M` | 用旧程序打开了新库：升级到对应版本的程序，不要改 `meta.schema_version` |
| 状态页一直「未授权」 | 用 `http://127.0.0.1:3080/?token=<WEB_API_TOKEN>` 打开一次（页面会把凭据记进 localStorage 并抹掉地址栏） |
| 状态页 `date-line` 变红报错 | 与上面同源：浏览器里存的凭据失效（换过 token），重新用 `?token=` 引导一次 |
| stdio 壳报 `daemon 不可达` | daemon 没起或 `MCP_DAEMON_URL` 指错；壳只连 daemon、不自己开库 |
| MCP 直连报 `Session not found` | daemon 重启过：重新 `initialize`（stdio 壳会自动做） |
| 收不到主动推送 | 依次查：`notify {action:"quiet_hours"}`（静默时段）→ `notify {action:"route"}`（路由与 `secretConfigured`）→ 状态页「投递」卡片的 queued/failed/fallback 计数 |
| 天气工具报 `UNAUTHORIZED` / `NO CREDIT` | JWT 私钥或 API KEY 问题：换 JWT 前请确认私钥是 Ed25519 PKCS8、路径为绝对路径（首次请求才校验） |
| `holidays.failed` 列出年份 | 抓取失败（无外网/CDN 不可达/数据校验不通过），原因就在该行；期间 `workday/holiday` 过滤的日程会暂停而不是猜 |
| 通知没收到 | 先 `notify.pull`（只返回未读：静默时段/投递失败/无路由的通知可拉到；已成功投递的通知会被标记已读，pull 不再返回） |
| 没有生成新备份 | daemon 没在运行（内置 job 不会执行）/ 未到 `BACKUP_CRON` / `DATA_DIR` 不可写；日志搜「每日备份」。手工补一份：`npm run db:backup` |
| 启动报「另一个 daemon 已在运行」 | 同机已有实例，或残留 `daemon.lock` 里的 pid 仍存活。`ps -p <pid>` 确认；进程已死会被自动接管，不需要手工删锁 |
| 访问返回 403 `Host 不被允许` / `Origin 不被允许` | 用域名或局域网 IP 访问却没写进 `WEB_ALLOWED_HOSTS`（DNS rebinding / 跨站防护）。把实际 Host 加进去后重启；浏览器跨站请求会被「Origin 不被允许」拦下，属预期 |
| `doctor --live` 报任务停更 / 备份过期 | 看状态页「定时任务」卡片或 `GET /api/jobs`：任务停更说明 cron 没在跑（daemon 未运行/系统时间异常）；备份 >36h 是 warn、>7 天是 fail |
| 日志 `节假日刷新失败: 2027: 数据尚未发布` | 次年安排通常 11 月后才公布：该年份现在是 `pending`（不是失败），状态页只列 `failed`；数据发布后自动升级为 ready |
| `db:restore` 报「daemon 仍在运行」 | 先停 daemon；锁文件里的 pid 必须真的不存活才允许恢复（防止 WAL 里还有未合并数据时被覆盖） |


## 从 v1 迁移

```bash
npm run import:v1 -- --from /旧/DATA_DIR [--force]
```

导入在单个写事务中完成。若目标 daemon 正在运行，建议先停掉它（或留足维护窗口）：导入持锁期间 daemon 的写入可能等满 `busy_timeout`（5s）后报错。

一次性导入旧库的 Profile、静默时段、日程、账本（导入为**家庭账本**，所有 Profile 可编辑）、支出账目、节假日数据。旧 occurrence 不迁移（v2 按规则重新物化）；收入/转账账目、deadline 提醒、共享账本角色不迁移，均会在报告中列明。建议先对旧库做备份。

导入是**逐行隔离**的：单条坏数据（金额非法、日期无法解析、引用不存在的账本、主键冲突等）
不会中断整次导入，而是被跳过并在最后以 `[表] id：原因` 列出，进程以退出码 2 结束。
合法数据照常入库，不必因为一条脏数据重来。若旧库的某一整张表读不出来（例如某行是超出
JS 安全整数范围的 int64、或旧库仍被 v1 进程占用），该表会整表跳过并同样记入上面这份
`原因` 清单 —— 不会伪装成「旧库没有这张表」的成功报告。唯一例外是 `profiles` 表：
它读不出来时整个导入直接中止（退出码 1、目标库不被修改），而不是在缺 Profile 的前提下
继续写日程。

`--force` 只覆盖**本次成功写入的同主键行**（日程按 id 精确替换并清掉其旧 occurrence，账目按 id 替换；账本按 id upsert，因此不影响其上的月度预算）。读取失败或逐行校验失败的行不会先删除目标库原行——旧库某行坏掉时，目标库里同 id 的既有数据保持原样。导入从不写入的数据不会被清 —— 目标库里已有的通知/投递历史、v2 期间新增的日程与账目、以及任意账本的预算都会保留；只有整个事务级别的致命失败（例如 profiles 表读不出来）才会整体回滚。

例外是节假日两张表：`cn_holiday_days` / `cn_holiday_years` 始终用 `INSERT OR IGNORE`
写入，既不参与 `--force` 的清除，也不会覆盖目标库中已由 daemon 抓取的更新数据，
因此它们只增不改（报告里的「已导入 N 天」只统计真正写入的行，被忽略的不计入）。

## 开发

```bash
npm run dev            # tsx 直接跑 daemon
npm test               # node --test（全部用例）
npm run lint           # Biome lint（error 级诊断才让命令失败；warn 不会）
npm run format:check   # Biome 格式检查（CI 也跑）
npm run doctor         # 自检：配置/目录/库完整性/鉴权/JWT 私钥/备份（--network 另有连通性检查；--live 连运行中的 daemon：/healthz、任务新鲜度 /api/jobs、备份新鲜度）
npm run db:backup      # VACUUM INTO 备份，按 BACKUP_KEEP 保留（默认 14 份），产物自校验
npm run db:restore     # 从备份恢复（--latest 缺省 / --file 指定 / --dry-run 预演；daemon 运行中拒绝）
npm run db:cleanup:preview   # 零业务删除预演：occurrence 与保留策略会删掉哪些行（数字与 job 同一份判定；打开旧库时可能做附加式 schema 升级）
```

> `db:backup` / `db:restore` / `db:cleanup:preview` / `doctor` / `import:v1` 跑的是 `dist/` 里的构建产物，先
> `npm run build`（或改用对应的 `dev:*` 变体直接跑源码）。

结构：`src/core`（database/registry/jobs/lock/security/auth/http/logger/settings/notify/channels/render/qweather/qweather-jwt/holiday/recurrence/retention/backup）、`src/modules`（weather/holiday/schedule/bookkeeping/notify/maintenance，经 `modules/index.ts` 注册，核心不反向依赖）、`src/server`（status/page/details，状态页与只读 API）、`src/daemon.ts`、`src/stdio.ts`、`src/config.ts`、`src/time.ts`、`src/import-v1.ts`、`src/backup.ts`、`src/restore.ts`、`src/cleanup-preview.ts`。

## 设计要点

- **单写者**：所有 SQLite 写入收敛到 daemon，WAL + 严格 schema（STRICT 表、CHECK、外键）。schema 版本记在 `meta.schema_version`，启动时逐级自动升级（只做附加式加列/加表，升级失败即拒绝启动）；库版本高于程序时同样拒绝启动。注意 `schedules.escalation_json` 是有意只走幂等补列、不提升版本的（重建 `schedules` 会牵动 `occurrences` 外键与 `kind` 的 CHECK），因此 `schema_version` 表示「升级阶梯走到了哪一级」，而非表结构的完整指纹。迁移整体包在单个事务里（失败整笔回滚，不会留下「版本号前滚了、列还没补」的半升级库）；前滚前若传了备份目录，会先 `VACUUM INTO` 一份 `life-assistant-pre-v<旧版本>-<时间戳>.db` 快照，备份失败则拒绝启动；活动账本名唯一索引建不出来同样拒绝启动（宁可停，也不让同名账本串范围）。schema v4 新增 `job_runs` 与 `expenses/schedules.client_token`（写路径幂等键）。
- **模块契约**：模块注册 `tools / jobs / tick / onStart` 四个扩展点；调度保证 tick 不重叠；核心不 import 模块内部。
- **recurrence 引擎**：自研纯函数替代 rrule，只覆盖 daily/weekly/monthly/yearly × 农历 + 工作日过滤；漏触发只补最近一次。
- **outbox**：通知 + 投递记录同事务写入；发布即触发投递；静默时段只拦主动推送；带 `expiresAt` 的通知（气象预警）到点仍未投出即作废，不会在静默时段结束后补投一条已经失效的告警（通知本身保留，`notify.pull` 仍可取到）。投递通道由 `src/core/channels.ts` 抽象：`webhook` 逐字保留原 HMAC V2 协议与重试语义，`log` 只写进程日志（本地联调用）；路由的 `channel` 字段缺省为 `webhook`，旧 `push_route` 数据不需要迁移。
- **时区**：全部调度固定 Asia/Shanghai，无 DST。
- **任务运行记录与启动补发**：每次 job 执行写一行 `job_runs`（cron/startup/catchup/manual，running→ok/failed/skipped；进程崩溃遗留的 running 行在下次启动收敛为 failed），状态页「定时任务」卡片、`GET /api/jobs` 与 `doctor --live` 共用这份事实。启动补发只针对 `CATCHUP_POLICY` 白名单内的每日任务（早报、晚报、预警巡检、调休提醒、节假日刷新、备份、WAL checkpoint、occurrence 清理、保留策略）：用自写的 cron 反向求值算出「上一次应触发时刻」，超窗口不补、已有成功记录不补，执行前再确认一次以避开与 cron 的竞态；单个失败只记日志。`job_runs` 由保留策略顺带清理 30 天前的行。cron 的日/月/星期字段不是 `*` 时不做反向求值（宁可漏补，不猜）。
- **部署安全基线**：启动先取 `daemon.lock`（`open(..., "wx")` + PID 存活探测，死进程/损坏锁自动接管）再开库 —— 两个 daemon 同时跑会让 outbox 重复投递；`umask(0o077)` 并把数据目录/库/备份收紧到 0700/0600；HTTP 入口统一校验 Host（缺失或不在允许名单即 403）与 Origin（存在时必须同源，CLI/agent 这类无 Origin 的请求放行），挡 DNS rebinding 与跨站请求；`REQUIRE_AUTH=1` 让回环部署也强制 token。
- **QWeather 请求治理**：按数据类型短 TTL 缓存（`CACHE_TTL_MS`：实时 20min / 逐天 2h 且取 `min(2h, 距本地次日 00:00)` / 空气质量 45min，只有成功响应才写缓存；预警的缓存 TTL 跟随 `ALERT_WATCH_CRON` 间隔 +30s（复杂 cron 回退 15min）——工具查询仍用 10min，巡检不再每轮穿透缓存、日请求量约减半）；同进程并发上限 3；仅对 429/5xx 与网络故障做指数退避（`2^c` 秒 + 抖动，c 上限 10），**4xx 一律立即抛出** —— 官方明确反复重试错误请求会被判定为攻击并冻结账号。认证优先 JWT（EdDSA），API KEY 保留回退。**GeoAPI 结果不得落盘缓存/批量存储/建索引**（官方版权限制），只允许进程内 memo —— 唯一例外是用户经 `weather locate` **显式选定的位置会作为该 Profile 的配置长期保存**（`settings.location`），属用户主动设置而非缓存/批量索引，供后续查询与每日简报复用；`weather travel` 设置的出行计划同理，只保存城市/经纬度与起止日期（`settings.travel_plan`），生效期间直接复用、**不再请求 GeoAPI**。
- **主动推送**：定时任务组装**确定性**通知（无 LLM），走 outbox 投递：每日天气简报与调休/补班提醒 07:00、晚报 21:00（可配）、气象预警巡检每 20 分钟（缓存 TTL 跟随巡检间隔）、月报每月 1 号 09:00；节假日数据刷新 02:00、内置备份 03:00、WAL checkpoint 03:15、历史 occurrence 回收 04:30、保留策略清理 04:50。早报在天气结论之后附「今日日程/逾期未完成」（最多 6 条，日程模块异常只跳过该块、不影响早报发布），晚报给「明日天气/明日日程/今日未完成/明天补班或放假」；**当天补班只由调休模块的独立通知承载**，早报不再重复同一句——两个 job 同在 07:00，谁先跑都不影响结果。预警与补班都靠 `dedupe_key` 去重（预警按「id + 级别」，级别升级会再推一次、降级不重推；补班按「事件 + 日期」），静默时段在投递层统一拦截、不为任何类型开例外。每日简报同时给出**下个假期倒计时**（节假日数据未就绪时显示「未知」而不是猜）；出行模式生效期间，简报与预警巡检自动改用目的地城市，并在简报里显式标注。
- **备份与恢复**：`src/core/backup.ts` 的 `runBackup` 同时服务手动 CLI（`npm run db:backup`）与 `maintenance.daily_backup` job（`BACKUP_CRON`，默认 03:00）：`VACUUM INTO` 生成快照、按 `BACKUP_KEEP`（默认 14）清理最旧文件；产物必须通过 `quick_check` 与 `meta.schema_version` 自校验，否则删除并抛错（坏备份绝不冒充可用）。停机期间错过的备份由启动补发补跑一次。schema 前滚前（daemon 与各 CLI 打开老库）会先落一份 `life-assistant-pre-v<旧版本>-<时间戳>.db`。`npm run db:restore` 复用同一份校验：`--latest`（缺省）只在规范命名的备份里选，`--file` 指定，`--dry-run` 只预演；锁里的 daemon 仍存活时直接拒绝，覆盖前把当前库留底为 `life-assistant-pre-restore-<时间戳>.db`，恢复后清 `-wal`/`-shm` 并重新校验。备份新鲜度（>36h warn、>7 天 fail）与命名异常由 `doctor --live` 检查。
- **用量与保留**：QWeather 上游请求按本地日计数（含重试、缓存命中不计），状态页「今日天气请求」与 `/api/status` 的 `qweather_usage` 可见，daemon 重启从库里的计数继续累加 —— 官方 2027-02-01 起限制 API KEY 日请求量，没有计量就无从判断余量。保留策略（每日 04:50）只删**已读且投递已终结**的通知（含级联的投递记录）与**已取消超 180 天**的日程；未读通知、仍有待投递的通知、使用 `recurrence.count` 的日程一律保留。**月报通知也不清理**：它的 `dedupe_key` 是月报补发判定的唯一持久证据，删掉会让 7~12 个月前的月报被误判成「从未推送过」。
- **记账预算**：账本可设**总额**或**分类**月度预算（`ledger {action:"budget"}`，单位元），按账本每月滚动（对照当月支出）。`expense add` 成功后判定该笔是否**跨越** 80%/100% —— 只推跨越那一刻（而非达到即推）；同一个预算一笔只推**跨过的最高阈值**（一笔从 0% 到 150% 只推 100%，70%→90% 只推 80%），总额与分类各自独立判定；`dedupeKey = budget:<ledger>:<分类|空>:<YYYY-MM>:<80|100>`（总额的分类位是空串、分类用原样名字，分类名恰好叫 `-` 也不会与总额撞键），跨月自动重新判定，同月同阈值不重推；告警标题与对照都按**该笔支出所属月份**（补记两个月前的支出报的是那个月的超支，不会按「本月」口径误报）。设了预算的账本，月报追加预算对照行（附在 notes）；未设预算的账本行为完全不变。个人账本的支出**不触发任何预算提醒**（不推送、也不入通知）。
- **记账摩擦**：`expense add` 不传 `ledger_id` 时按「该 Profile 的默认账本（`expense {action:"set_default_ledger"}` 设置）→ 唯一可写活动账本」解析，仍不唯一才报错并列出候选；未显式传 `category` 时回执附该账本近 90 天 top5「常用分类」。`expense add` 与 `schedule add` 都可带 `request_id`（落 `client_token`，按 Profile/创建人分范围唯一）：MCP 超时重试命中同一 token 时返回首次记录并标 `已存在`，不会重复记账/重复建日程，也不重复推送。
- **账本归属**：`ledgers.owner_profile_id` 为 NULL 表示**家庭账本**（所有 Profile 可见可写，`expense add` 回执与预算提醒走全局推送、月报物化到所有配置了路由的 Profile）；非空为**个人账本**（仅归属人可见可写，他人一律得到「账本不存在」不泄露存在性；不回执、不推预算提醒，月报只发给归属人）。`ledger create` 缺省建家庭账本、`personal: true` 建个人账本；`ledger transfer` 仅当前归属人可把个人账本转给其他 Profile（目标 Profile 须已存在）或省略 `profile` 转回家庭（不可逆）；家庭账本不能转为个人。账本名**分范围唯一**——家庭账本之间唯一、每人自己的个人账本内唯一，跨范围可同名（因此不同人可各用「日常」），也避免「创建失败」泄露他人账本名；转移归属时若目标范围已有同名活跃账本会被拒绝。状态页与 `/api/status`、`/api/expenses` 只统计/展示家庭账本。升级前的既有账本与 v1 导入账本一律为家庭账本（`schema_version` 2→3 时补 `owner_profile_id = NULL`，行为不变）。
- **「本月」的口径**：状态页看板、预算对照、月报的「本月」= **自然月全月**（月初→月末，**含月内尚未到来的日期**）—— `spent_on` 是已录入的记账事实，指定了未来日期就不该因为日历没到那天就从本月数字里消失（否则同一个「本月」会随日期推移忽增忽减，对不上账）。工具侧 `expense summary` 不传区间时的默认区间是「月初 → 今天」，那是「本月至今」的查询默认。`expense` 的 `month` 与 `from`/`to` 互斥（同时传直接报错，`from > to` 也报错）：两者都表达区间，混着传会让 `list` 与 `summary` 得出相反结论。
- **物化窗口**：occurrence 只物化到 `now + 62 天`。若某日程此刻一条 `pending` 都没有（远期生日、远期一次性待办），额外豁免**恰好 1 条**越过窗口的 occurrence，保证「下一条」在 `list`/`upcoming`/状态页始终可见（豁免的那条最远可达 400 天，因此远期生日会显示成明年的日期）；豁免资格取自入库状态，补上第一条即失效，因此不会随时间累积增长。
- **截止型日程（逾期升级）**：给 `todo` 设置 `escalation`（严格升序分钟偏移数组，1-5 项、最大 43200 即 30 天，**首元素必须为 0** 表示截止时刻本身，如 `[0,60,360,1440]`）即可 —— 仅 `kind=todo` 可设，到达截止时刻后按阶梯依次重发升级提醒（第 0 步即截止时刻的提醒，第 1..n 步是逾期加压的 `<event>#N#esc:M`；锚点默认是 `#0`，晚录入/停机导致 `#0` 被 `catchupSweep` 取消时落在保留下来的那条偏移行上），直到 `complete` 才停；设置 `escalation` 时 `resend_minutes` 被忽略。每步各生成一条 occurrence，靠 `INSERT OR IGNORE` + `notified` 状态保证只推一次；改了 `time`/`escalation` 或父事件被删/重排后，残留行在触发前按当前排期校验并作废。`complete` 带 `occurrence_key` 时按**事件前缀**收敛：同一事件的各条提醒偏移（`#0..#4`）与它们的派生行（`:resend`、`#esc:N`）一并终结，因此用哪一条提醒去完成都不会再有同事件的后续推送。`update` 传 `escalation: []` 清除阶梯（空数组在 MCP schema 层合法：长度下限与首元素/升序等语义规则在 service 层判定，否则经真实 MCP 的 `[]` 会在进入 handler 前被拒）。工具/状态页把这类日程的类型显示为「截止」（不新增 `kind` 枚举值，语义由字段表达）。
- **单次处置**：`schedule {action:"snooze"}` 顺延某一次发生的提醒（`minutes` 或 `until`），`skip` 跳过某一次但不结束系列，两者都按 `occurrence_key` 精确定位；`schedule list` 每行附 `待办发生`（最多 5 条 occurrence_key），就是这两个 action 要传的值。`complete` 对循环日程**必须**带 `occurrence_key`（只完成当前一次；同一事件的各条提醒偏移与派生行一并收敛），裸调会被拒绝并提示改用 `all: true` 结束整个系列；一次性日程语义不变。手工 snooze 过的 occurrence 在提醒里显示顺延后的 `due_at`，`dedupeKey` 含该时刻，因此二次提醒不会被 outbox 的幂等窗口吞掉。
- **历史回收**：`schedule.occurrence_cleanup`（每日 04:30）只清理 90 天前的 `notified`/`done`/`cancelled` 行 —— `pending` 永不删；使用 `recurrence.count` 的日程整条豁免（发生次数上限依赖历史行数，删历史会让已达上限的循环复活；漏触发被 `catchupSweep` 收敛为 `cancelled` 的事件同样计入上限——否则漏一次就会补出新事件，上限永远达不到）。上线或调参前用 `npm run db:cleanup:preview` 零业务删除预演将删除的行数与涉及日程（与 job 共用同一份判定；打开旧库时仍可能做附加式 schema 升级）。

### 已知取舍与后续优化

第 1、2、3、4、8、11、13、18 条已实施（保留划线记录）；其余为「已识别但未做」，当前实现是正确的、只是不够省：

1. ~~**QWeather 天气数据无缓存/限流/退避**~~ —— **已实施（2026-09-18）**：按官方推荐值加短 TTL 缓存、并发上限 3、仅对 429/5xx 指数退避（4xx 绝不重试），并停止把 GeoAPI 结果落盘（官方版权限制）。
2. ~~**认证方式建议迁移 JWT**~~ —— **已实施（2026-09-18）**：支持 Ed25519 JWT（`Authorization: Bearer`，URL 不再带 `key=`）并优先使用，API KEY 保留回退。官方口径：自 **2027-02-01** 起逐步限制 API KEY 的每日请求量，SDK v5+ 仅支持 JWT。
3. ~~**v7 城市版端点已宣布弃用**~~ —— **已实施（2026-10-14）**：实时/逐天预报改用 v1
   `GET /weather/v1/current/{lat}/{lon}` 与 `/weather/v1/daily/{lat}/{lon}?days=`（按经纬度，
   不再用 `location=城市ID`）；数值从 `{value, unit}` 解包，`humidity` 由 0–1 小数换算成百分数、
   `wind.speed` 由 m/s 换算成 km/h（单位不识别即报错，绝不静默换算错）。**代价：v1 不再返回观测
   时刻（obsTime）**，天气表改标注「数据获取时间」（数据获取时刻，仍有 20 分钟缓存）。
4. ~~**`summarizeExpenses` 不是单快照**~~ —— **已实施**：三条语句（合计 / 分类明细 / 按人汇总）包进 `withReadTransaction`（`BEGIN DEFERRED`），并发写入落库时不再出现「合计与分类明细对不上」；已在事务内时复用外层快照，不嵌套 BEGIN。
5. **`schedules.version` 列未参与并发控制**：每次更新 +1，但没有乐观校验；单写者下风险低，
   可删列或落实校验。删除列会破坏「只做附加式加列/加表」的迁移约定（见 `AGENTS.md`），
   故保留现状。
6. **节假日刷新节奏**：`FETCH_COOLDOWN_MS` 是 6h，但主动重试点仍是每天 02:00 的 job（`requiredYears()` 到 10 月才要求下一年），实际重试间隔为 24h。物化撞到未就绪年份的路径已改为由 `tick()` 触发按需补齐、真正受 6h 冷却约束；未来年份未发布现在记 `pending`（不再是 `failed`），`pending` 与 `failed` 共用 6h 冷却。若要提前拿到下一年数据，可把 job 改为 `0 */3 * * *`。
7. **`status` 页面本身无鉴权**（`/` 只有静态 HTML，数据走受保护的 `/api/status`）。
   若对外暴露，建议同时开 `REQUIRE_AUTH=1` 强制 token，并把实际访问域名写进
   `WEB_ALLOWED_HOSTS`（Host/Origin 守卫默认已开，缺 Host 或跨站 Origin 一律 403）。
8. ~~**`notifications` / `deliveries` 无保留策略**~~ —— **已实施**：保留策略 job（每日 04:50，`src/core/retention.ts`）删除已读且投递已终结（无 `queued`/`sending`/`failed`）的 180 天前通知，投递随外键级联删除；**月报通知除外**（`dedupe_key` 是补发判定依据）；`npm run db:cleanup:preview` 与 job 共用同一份判定，预演数字与实际删除一致。
9. **server 层直接引用模块的纯函数**：`src/server/details.ts` import 了
   bookkeeping/schedule 的 `monthRange`、`KIND_LABEL` 等常量与纯函数；`src/server/status.ts`
   的 CSV 导出也直接 import 了 bookkeeping 的 `expenseCsv` / `expenseCsvFilename`。契约测试只
   强制 `src/core` 不依赖模块，这条方向没人管 —— 改模块内部签名时要记得同步看板与 CSV 导出。
10. **`notify.pull` 拦不住已经在途的投递**：pull 只把 `queued`/`failed` 的投递置为
    `cancelled`；若某条正处于 `sending`（请求已发出、最多 10s 超时），用户 pull 读到之后
    仍会收到那一次推送。窗口是单次请求的时长，且 webhook 侧还有 55 分钟幂等窗口兜底，
    暂不为此引入「中断在途请求」的机制。
11. ~~**`schedules` 的软删行永不回收**~~ —— **已实施**：`delete` 仍只把状态置为 `cancelled`（使用 `recurrence.count` 的日程保留其 occurrence 历史，其余日程删掉 occurrence），保留策略会删除已取消超 180 天的行。仍在的唯一豁免是 `countProtectedScheduleIds`：使用 `recurrence.count` 的日程（含已取消的）整条不删 —— 这是必要的（否则取消后再激活会让已达上限的循环复活），代价是这些行永久占用清理豁免。体量小，暂不再细分。
12. **看板/`/api/schedules` 跨 Profile 展示日程**：状态页是「家庭看板」，`scheduleDetails` 不按 Profile 过滤，任一持有共享 `WEB_API_TOKEN` 的调用方都能看到所有 Profile 的日程标题与备注（`schedule` 工具本身是 Profile 私有的）。这与「个人账本仅归属人可见」并不一致。`/api/deliveries` 同样跨 Profile 展示通知标题；其中**个人账本的月报标题已脱敏**为「（个人账本月报）」，但其它通知（如日程提醒）仍按看板口径展示。当前定位是单用户单 token，暂按现状；若确实多用户部署，需要给日程/通知也引入可见性（家庭/个人），或让看板只显示家庭范围。
13. ~~**每日简报 / 调休提醒不做错过补发**~~ —— **已实施（2026-10-20）**：`job_runs` 记录 + 启动补发。daemon 启动时对 `CATCHUP_POLICY` 白名单内的 job 反向求值 cron、算出上一次应触发时刻：停机错过且在窗口内（日报/晚报/补班 6h、预警 1h、备份 24h 等）就补跑一次，job 自身的 `dedupeKey` 保证同一天不推两遍；已有成功运行覆盖则不补、超出窗口不补、执行前二次确认。限制：cron 的日/月/星期字段非 `*`（如 `0 7 * * 1-5`）时不做反向求值，宁可漏补不猜，`doctor --live` 会给 warn。
14. **记账编辑只做「更正」，不触发推送、不保留历史**：`expense {action:"update"}` 改金额/分类/备注/日期后不会补发回执、也不会重新判定 80%/100% 预算阈值（避免修正金额时凭空多推一条），且不记录修改前值；如需按新金额触发提醒，只能等下一笔支出或人工核对预算。编辑也不能把账目挪到另一个账本。
15. **出行模式一个 Profile 同时只保留一份计划**：`weather {view:"travel"}` 覆盖式保存，不支持多段行程/多城市串联，也没有历史行程查询；显式传 `city` 的查询始终优先于出行计划。计划只按本地日历日判断生效，跨时区行程仍以 Asia/Shanghai 为准；窗口结束后计划不会自动删除（`show` 显示未生效、可 `clear`）。简报的 `dedupeKey` 含城市名：同一天内把目的地改到另一个城市会再发一条新城市简报（旧城市那条已发出，无法撤回）。
16. **看板 CSV 只导出家庭账本**：`/api/expenses.csv` 与看板同口径（共享 `WEB_API_TOKEN` 下不暴露个人账本），个人账本导出走 MCP `expense {action:"export"}`（仅当前 Profile 可见的账本）；CSV 只支持按月导出，不做任意区间。
17. **投递通道目前只有 `webhook` 与 `log`**：`log` 只写进程日志，不是真正的端到端送达；接 Bark / ntfy / Telegram 等需要在 `src/core/channels.ts` 增加实现（outbox 的重试/幂等可复用）。
18. ~~**内置备份 job 依赖 daemon 运行 / 无完整性校验 / 无恢复入口**~~ —— **已实施（2026-10-20）**：备份产物生成后即自校验（`quick_check` + `meta.schema_version`，坏产物删除并报错）；停机错过的备份由启动补发补跑；新增 `npm run db:restore`（校验 + 留底 + 拒绝在 daemon 运行时操作）；schema 前滚前自动落 `pre-v<旧版本>` 快照；`doctor --live` 检查备份新鲜度与命名异常。仍保留：`VACUUM INTO` 在主进程事件循环上同步执行，库很大时会短暂阻塞 HTTP/MCP（每日一次、个人规模可接受；彻底隔离需要 worker thread）；状态页暂不展示备份卡片。

19. **启动补发只是「最近一次」**：每个白名单 job 只补最近一次错过的触发，且只支持「日/月/星期为 `*`」的 cron；连续停机多天不会逐天补齐（补 3 天前的日报只会打扰用户）。`CATCHUP_POLICY` 的键必须与真实 `module.job` 一致，`tests/jobs.test.ts` 会在键名拼错时立刻变红。
20. **`job_runs` 只保留 30 天、且没有指标导出**：状态页/`/api/jobs` 展示最近几次运行与 24h 失败数，但没有历史成功率曲线、耗时分位或 `/metrics`。数据量小、个人规模够用；要做趋势再引入导出。
21. **单实例锁按本机 PID 判断**：`daemon.lock` 用 `process.kill(pid, 0)` 探测存活，NFS/多主机共享同一个 `DATA_DIR` 时，另一台主机的同号进程可能被误判为「仍存活」（锁里记了 hostname 仅供排障，未参与判定）。单机部署不受影响。
22. **`db:restore` 的运行中检测只认锁**：若有人绕过锁直接跑旧版 daemon，恢复无法感知；同理恢复后删除 `-wal`/`-shm` 依赖「已停机」这个前提。
23. **Host/Origin 守卫对回环主机名不限端口**（Host 头端口不参与路由，DNS rebinding 的边界是主机名），但 Origin 始终要求端口精确 —— 本机其它端口上的页面不会被当成同源。绑定 `0.0.0.0` 时局域网 IP/域名必须显式写进 `WEB_ALLOWED_HOSTS`，否则 403 是预期行为。
