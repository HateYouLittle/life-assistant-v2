# AGENTS.md

个人生活助理 MCP 服务，面向 Hermes Agent。单守护进程承载 MCP（Streamable HTTP）+ 定时调度 +
outbox 主动推送 + 状态页，共用一个 SQLite 文件。
`README.md` 是权威设计文档（中文），改行为前先读；`skill/SKILL.md` 是面向用户的工具语义。

## 命令

需要 Node.js **>= 22.16**（使用内置 `node:sqlite`；`isOpen` 需 22.15、`isTransaction` 需 22.16，无外部数据库驱动）。

```bash
npm install
cp .env.example .env               # DATA_DIR 必须是绝对路径
npm run typecheck                  # 对 src 和 tests 分别跑 tsc（两个配置）
npm run lint                       # Biome，error 级诊断会让命令失败
npm run format:check
npm test                           # node:test + tsx 跑 tests/**/*.test.ts
npm run build                      # tsc -> dist/
```

CI（`.github/workflows/ci.yml`）在 Node 22.16.0、22 与 24 上按此顺序运行：
`audit（仅生产依赖，high/critical 即失败）-> typecheck -> lint -> format:check -> test -> build`。
自称完成前先跑完整链路；`npm audit fix` 升级锁定版本后必须重跑全链路（MCP SDK 等在运行时里）。

- 只跑单个测试文件：`node --import tsx/esm --test tests/schedule.test.ts`
- `npm run dev` 用 tsx 跑 `src/daemon.ts`；`npm start` 跑构建产物 `dist/daemon.js`
  （需先 `npm run build`）。`db:backup` / `db:cleanup:preview` / `db:restore` / `db:fingerprint` /
  `doctor` / `import:v1` / `calendar:url` 同理：无前缀脚本依赖 `dist/`，`dev:*` 变体直接跑 TS 源码。
- `.env` 只会被 `start` / `dev` / `db:backup` / `db:cleanup:preview` / `db:restore` /
  `calendar:url` / `db:fingerprint` / `doctor` / `import:v1` 及其 `dev:*` 变体通过
  `--env-file-if-exists` 自动读取。
  其他命令需手动 `set -a; source .env; set +a`。
- 首次运行会创建 `$DATA_DIR/life-assistant.db`；测试使用一次性临时目录。

## 架构

- `src/core/` 是框架层：database/fingerprint/audit/registry/jobs/lock/security/auth/http/logger/
  logrotate/settings/notify/notify-prefs/channels/smtp/render/qweather/qweather-jwt/holiday/recurrence/
  retention/backup/ratelimit/metrics/ics。`src/modules/`
  （weather/holiday/schedule/bookkeeping/notify/maintenance）通过 `src/modules/index.ts` 的
  副作用 import 接入，遵循 `tools / jobs / tick / onStart` 四个契约扩展点。`maintenance`
  注册每日备份（与 `db:backup` CLI 共用 `src/core/backup.ts`）、每日 WAL checkpoint 与日志轮转三个 job。
- `src/core/ratelimit.ts`：`FixedWindowLimiter` 双层固定窗口 —— 每个请求按来源 IP 计一层，
  凭据校验通过且带 Bearer 时再按 token 指纹计一层（无效/缺失凭据只落 IP 桶，轮换伪 token
  不能换桶绕过）；桶数有硬上限（默认 10_000，满时淘汰最旧）。`clientAddress`/`envClientAddress`
  统一地址口径（只有 `TRUST_PROXY=1` 才采信 `X-Forwarded-For`）。
  `src/core/metrics.ts`：进程内计数器（`auth_failed_total` / `auth_forbidden_total` / `rate_limited_total`）。
  `src/core/ics.ts`：日历订阅的签名 URL（HMAC-SHA256(master, `"<profile>.<exp>"`)）与 ICS 文本工具。
  `src/server/quick.ts`（`/quick` + `/api/quick/*`）、`src/server/calendar.ts`（`/calendar.ics`）、
  `src/server/ops.ts`（`/metrics` + `/readyz`）是三个独立子应用，由 `createHttpHandler` 挂到
  同一个 Hono 上（共享 Host/Origin 守卫与限流）；`src/server/budget.ts` 是预算看板的纯函数层。
- `src/core/jobs.ts`：`job_runs` 运行记录（running→ok/failed/skipped）、`CATCHUP_POLICY`
  启动补发白名单、`previousFireTime`（自写 cron 反向求值：支持 `*`、单值、逗号列表、
  `a-b` 范围与 `a-b/n` 步长（步长按 node-cron「展开后取模」语义）；星期 `7` 只允许单值/
  单值列表，含 `7` 的范围/步长与「列表+步长混用」等特殊写法保守放弃；日与月必须为 `*`）、
  `runStartupCatchups`（补发时把
  「原定触发时刻」传给 handler，供早报/晚报/摘要/周报/调休提醒按该时刻取业务日期）；daemon 在 listen
  之后非阻塞调用，停机时与 onStart 一起收敛。
  `src/core/lock.ts`：`daemon.lock` 单实例锁（写完整临时文件后 `link` 原子创建、
  失效锁 rename 原子接管并校验 inode/pid/内容身份；锁内容 = pid + 进程启动时间
  （macOS `ps -o lstart=` / Linux `/proc/<pid>/stat`+`btime`，读不到记 `unavailable`）+ 随机 token；
  接管前三重交叉校验，pid 存活但启动时间不符判为 pid 复用并按失效锁接管并 warn，
  读不到启动时间时保守拒绝启动并给「确认后删锁」指引；release 要求 pid+token 双一致）。
  `src/core/security.ts`：`applySecureUmask`/`hardenDataDir`/`applyCliSecurityBaseline`/
  `createRequestGuard`（umask 077 与目录/库/备份收紧对 daemon 与 `db:backup`/`db:restore`/
  `db:cleanup:preview`/`db:fingerprint` 同口径：库不存在时只设 umask、不 chmod 可能写错的目录；
  `import:v1`/doctor 只设 umask；
  `createRequestGuard` 是 Host/Origin 守卫，daemon 的 `createHttpHandler` 对所有路径统一调用）。
  `src/restore.ts` 是 `npm run db:restore` 的实现（校验/留底/替换，复用 `backupStatus` 的
  规范文件口径；锁文件损坏/不可读时拒绝恢复）。
- **核心层不得 import 模块内部。** 这一点由 `tests/registry.test.ts` 的静态 import 扫描强制，
  而不仅是运行时查重。新模块在 `modules/index.ts` 注册。
- **非 MCP 调用方一律经 `registry.invokeTool(name, args, ctx)` 调工具**（P2-24）：按名取
  `allTools()` 里的 def、用模块自己的 zod raw shape 校验参数、把 handler 抛错转成工具错误结果。
  手机快捷入口 `src/server/quick.ts` 的写路径已改为这条，**不得再 import 模块 index 里的 handler**。
- server 层的既有例外（`tests/registry.test.ts` 扫描 core + server 两层，例外逐条白名单，白名单
  过期即报错）：`src/server/details.ts` 与 `src/server/budget.ts` 直接 import bookkeeping/schedule
  的**纯函数**（monthRange / KIND_LABEL / budgetStatus 等）；`src/server/status.ts` 的 CSV 导出
  import bookkeeping 的 `expenseCsv`；`src/server/quick.ts` 保留两处**只读** service import
  （bootstrap 首屏聚合 + 幂等命中时回读原记录的事件时间——不能从本次请求参数推算，与 P2-4 同因）；
  以及 `import "../modules/index.js"`（模块注册入口，非模块内部实现）。模块间还有一条：
  `src/modules/weather` 直接 import `schedule/service.ts` 的 `agendaForDate`。改这些签名可能
  静默破坏状态页或简报——记得同步检查这几处。
- Runtime 是进程级单例（`src/core/registry.ts` 的 `initRuntime`/`runtime`），只能初始化一次。
  测试必须用 `makeTestEnv()` + `cleanupTestEnv()`（`tests/helpers.ts`），后者会重置 runtime
  并调用 `cancelPendingDrain()`。
- SQLite：STRICT 表、WAL、开启外键。schema 版本存在 `meta.schema_version`，启动时逐级
  附加式升级；库版本高于程序 `SCHEMA_VERSION` 时拒绝启动（`src/core/database.ts`）。
  `schedules.escalation_json` 走幂等补列且**不**提升版本号（重建 `schedules` 会破坏
  `occurrences` 外键与 `kind` 的 CHECK），因此 `schema_version` 并非表结构的完整指纹。
  同理，活动账本名的**分范围**唯一索引（`idx_ledgers_scoped_name`，家庭之间 + 每人个人账本内）
  也是打开时幂等重建并 DROP 掉旧的全局索引 `idx_ledgers_active_name`，不提升版本号。
  v4 新增 `job_runs` 表与 `expenses.client_token` / `schedules.client_token`（写路径幂等键，
  分范围部分唯一索引 `idx_expenses_client_token` / `idx_schedules_client_token`，NULL 不参与约束）。
  v5 新增 `audit_log` 表（写接口审计，`/api/audit` 按身份过滤）与 `meta.schema_fingerprint`
  （结构指纹：`db:fingerprint` CLI/doctor 可查；启动时对比并更新，漂移会 warn）。
  迁移整体包在单个事务里（失败整笔回滚）；升级前若 `openDatabase` 传了 `backupDir` 会先
  `VACUUM INTO` 一份 `life-assistant-pre-v<旧版本>-<时间戳>.db`，备份失败拒绝启动。
  活动账本名唯一索引建不出来现在**拒绝启动**（旧实现只告警；缺索引会让同名账本串范围）。
- 时区固定 `Asia/Shanghai`（`src/time.ts`），无 DST。数据库存 UTC ISO 瞬间；本地日历日是
  `YYYY-MM-DD` 字符串。

## 测试

- 测试运行器是 `node:test`（无 jest/vitest）。测试通过 tsx 直接跑 `src/**`，无需构建。
- **测试里不要启动真实 daemon**——它的 cron/定时器会让进程不退出。测 HTTP 请调用
  `createHttpHandler(config, db)` 并监听端口 `0`（见 `tests/daemon-mcp.test.ts`）。
- 用 `makeTestEnv(extraEnv)` 搭测试环境；它会建临时 `DATA_DIR`、打开库、种入 profile
  `default`，并把 `publishProfile`/`publishGlobal` 的调用记录到 `env.published`。
  务必在 `finally` 里 `cleanupTestEnv(env)`。
- 状态页内联 JS 在 `node:vm` + DOM 桩里做端到端测试（`tests/status-page-script.test.ts`），
  因为纯字符串断言看不出整页渲染故障。内联 `STYLE`/`SCRIPT`/`resolveToken` 已搬到
  `src/server/page-script.ts`（`page.ts` 只留页面骨架，1108 → 114 行），并由
  `tests/status-page-script-syntax.test.ts` 把脚本写进临时 `.mjs` 跑 `node --check` 兜住
  字符串内的语法错误（P2-23）。仍是字符串，字符串内的未定义变量/`esc` 漏用只能靠 vm 端到端。
- 走 `createHttpHandler` 的测试会经过 Host/Origin 守卫：用 `http.request` 指向 `127.0.0.1`
  时 Host 自动放行（回环主机名不限端口）；要测拒绝路径就直接构造 `IncomingMessage` 风格的
  `{ headers }` 调 `createRequestGuard(config)`。

## 约定

- ESM（`"type": "module"`、NodeNext）：相对 import **必须**带 `.js` 后缀，即使在 `.ts`
  源码里；纯类型 import 用 `import type`（开启了 `verbatimModuleSyntax`）。
- Biome 2.x：2 空格缩进、100 列。`noExplicitAny`、`noNonNullAssertion` 为 error；
  命令只对 error 级诊断失败（未启用 `--error-on-warnings`，warn 级不会让命令失败）。
- 工具输出与 `SKILL.md` 用中文（输出键如 `标题`/`类型`/`状态`）。新增工具输出保持中文，
  并与既有形状一致。
- 提交信息：conventional 前缀（`feat:`、`fix:`、`docs:`、`chore:`）+ 中文描述。
- `data*/` 被 gitignore（别提交真实数据库）；除 `.env.example` 外的 `.env*` 也被忽略。

## 注意

- QWeather 的 GeoAPI 结果不得缓存/落盘/批量建索引（版权限制）——只允许进程内 memo。
  例外：用户经 `weather locate` 显式选定的位置会作为该 Profile 的配置长期保存，属用户
  主动设置而非缓存/批量索引；`weather travel` 的出行计划同理（只存城市/经纬度/起止日期，
  生效期间直接复用、不再请求 GeoAPI）。
  HTTP 错误只对 429/5xx/网络故障重试；**4xx 必须立即抛出**（反复重试错误请求会导致
  账号被冻结）。API KEY 是回退；优先 Ed25519 JWT，且四个 `QWEATHER_JWT_*` 变量必须
  同时配置，否则启动失败。
- 写路径幂等：`expense add` / `schedule add` 的可选 `request_id` 落 `client_token`（分范围唯一）。
  新增有副作用的写工具应沿用同一模式——插入撞唯一索引后按 token 查回原记录并标 `已存在`，
  不要只在应用层「先查后写」（并发/MCP 重试下不可靠）。
- 打开老库可能升级 schema 的入口（daemon、`doctor`、`db:cleanup:preview`、`import:v1`）都传
  `openDatabase(dbPath, { backupDir: config.backupDir })`；新增 CLI 若会打开主库也要这样传，
  否则前滚不会有迁移前快照（仅 warn）。
- 所有 HTTP 请求都过 Host/Origin 守卫：缺 Host 或不在允许名单 → 403；带 Origin 时必须同源
  （无 Origin 的 CLI/agent 放行）。绑定 `0.0.0.0` 或经反代/域名访问时，把实际 Host 写进
  `WEB_ALLOWED_HOSTS`，否则是预期内的 403。
- 启动补发只覆盖 `CATCHUP_POLICY` 白名单内的 job，且只补最近一次；cron **环境变量必须恰好
  5 段**（不支持秒字段，否则补发反向求值永远失败、停机后静默不补发；配置层直接拒绝）；
  cron 的日与月字段必须为 `*`；分钟/小时/星期支持 `*`、单值、逗号列表、`a-b` 范围与 `a-b/n` 步长（步长按
  node-cron 展开后取模语义），星期 `7` 只允许单值/单值列表，含 `7` 的范围/步长与特殊写法
  保守不反查。补发会把「原定触发时刻」
  传给 handler。新增「每天必须发生一次」的任务时记得加进策略表；`tests/jobs.test.ts`
  会校验键名必须对应真实注册的 `module.job`。
  **错过触发回放**（P2-14）：同步长任务阻塞事件循环跨过整分钟时，`CATCHUP_POLICY` 白名单内的
  job 开启 node-cron `recoverMissedExecutions`（补跑错过的触发，写 `job_runs` 且 trigger=`catchup`、
  handler 收到**原定时刻**）；非白名单（含每分钟 `tick`）保持默认关闭。**必须配合分钟级槽位守卫**：
  node-cron 开启该开关后即使没有任何阻塞，同一分钟也会触发两次（实测 `lastExecution` 被
  `setMilliseconds(0)` 后下一次轮询再匹配一次），守卫保证同一触发时刻只执行一次。
- **鉴权矩阵**：`/api/*`（看板/只读）认 master 与 Profile token —— master=家庭看板（家庭账本
  支出 + 所有 Profile 日程/通知），Profile token=个人视图（家庭+本人个人账本、仅自己的日程/
  通知/投递）；`/api/quick/*` 同上；身份由 `resolveIdentity` 反查（**绝不读 `X-Hermes-Profile`**）；
  `/mcp` 两者都认，但 Profile token 强绑定自己的 Profile，会话与 token 不一致 → 403；
  `/metrics` 只认 master；`/readyz`、`/healthz` 无需凭据；`/calendar.ics` 用签名 URL
  （`src/core/ics.ts`），不使用 header。新增接口时先想清楚属于哪一档、按什么身份过滤。
- **限流豁免**：`/healthz` 与 `/readyz` 不参与限流（外部监控高频轮询会被 429 误判）；
  `/metrics` 与业务接口一样受限流。`RATE_LIMIT_PER_MINUTE=0` 时整体关闭限流（仅本地调试）。
  改 `createHttpHandler` 的豁免名单要同步 `docs/remote-access.md`。
- 定时任务有看门狗（`JOB_TIMEOUT_MINUTES`，默认 15 分钟，0 或负数关闭）：handler 挂死会记 `failed`
  并释放互斥；但 JS 无法取消 handler，它会进 `JobRunner.zombies` 继续在后台跑——**僵尸收敛前同名
  任务一律跳过**（否则 tick 每分钟一次会堆出十几个并发僵尸），停机时给 2s grace 后 warn 继续关库；
  僵尸数通过 `/metrics` 的 `life_assistant_job_zombies` 暴露（>0 = 有任务卡死、正在被跳过）。
  `createJobRunner` 的 `.finally` 必须挂在 `Promise.race([finished, watchdog])` 上而不是 handler
  的 promise 上 —— 否则迟到 settle 会把**下一轮**的 busy/inFlight 删掉，等于放行重叠执行。
- **备份校验旁车**：`runBackup` 发布成功后写 `<备份>.db.verified`（JSON：`schemaVersion` /
  `verifiedAt` / `sizeBytes` / `mtimeMs` / 首尾各 4KB 的 `digest`（sha256），先写
  `.verified.tmp-<pid>-<随机>` 再 rename，失败只 warn）。可信要求 size/mtime/指纹全部吻合，
  否则判不可信（等长覆盖/拷回/截断都会失效；中间页坏块只有 `deep` 开库能发现）。
  `backupStatus` 三档口径：默认不读任何文件返回 `null`；`{verifyLatest:true}` 先信旁车
  （size/mtime/指纹吻合才算可信），旁车缺失/不可信才回退开库；`{sidecar:true}` 零开库只读旁车
  （状态页/`/metrics` 用；`sidecarState` 给 trusted/untrusted/missing，metrics 输出 2/1/0 三态）；
  `{deep:true}` 强制开库（`doctor --live` 用，能发现「旁车说好、库其实坏了」）。prune 删旧备份
  连带删旁车，并清理孤儿旁车与过期的 `.verified.tmp-*`。同秒撞名时 `runBackup` 顺延 1s 换名
  重试（最多 5 次），绝不覆盖已有备份。
- **停机收敛**：`stop()` 先 `inFlightHttp.close()` 拒绝新请求（keep-alive 上的新请求回 503），
  再依次等 onStart / job / 僵尸 / **在途 HTTP/MCP 请求（8s 上界）** / drain，最后才 `db.close()`。
  `src/core/inflight.ts` 是这套在途追踪的纯逻辑（begin/waitForIdle/close），可单测；
  MCP 请求按 handler Promise 追踪（工具执行本身），**SSE 长连接不参与计数** —— 否则每次停机
  都会被挂着的 SSE 白等满上界。
- `/readyz` 结论缓存 1s（`createOpsApp` 的 `readyzCacheMs`）：无鉴权且豁免限流，每次请求都
  `BEGIN IMMEDIATE` + 多条查询会被高频轮询占满事件循环。它是**秒级近似探针**（含 503→200
  的恢复也会延迟最多 1s），别当实时看门狗用。
- 启动补发的汇总日志区分「尝试 / 成功 / 跳过 / 失败」四态：`runExclusive` 吞异常后 resolve，
  必须靠 `JobRunOutcome`（`skipped` = 同名 job 被重叠/僵尸占着、根本没执行）计数，
  不能把尝试数当成功数，也不能把跳过算成功。
- `verifyDatabaseFile(path, { thorough: true })` 额外跑 `integrity_check` + `foreign_key_check`：
  只用于低频且「错了会毁数据」的路径（`db:restore` 选目标/恢复后复验、`doctor --live` 的 deep）；
  每日备份自校验仍只用 `quick_check`（成本）。
- `daemon.lock` 存在表示同机已有实例；stale 锁（pid 已死 / 启动时间不符 / 内容损坏）启动时会原子接管。
  启动时间读不到（`unavailable`）或旧锁没有该字段时按「无法确认已停」处理：拒绝启动并提示
  「疑似 pid 复用，确认后删除锁文件」。`db:restore`
  在锁内 pid 仍存活时拒绝执行；锁文件存在但内容损坏/不可读时无法确认 daemon 已停，同样拒绝
  （dead-pid 残留仍放行），需先确认停服再手工删锁。别绕过它直接覆盖库文件。
- `notify.pull` 只能取消 `queued`/`failed` 的投递，无法拦住已处于 `sending` 的那一次；
  `notify {action:"cancel"}` 的回执按真实状态分档（`cancelPendingDeliveries` 返回
  `{cancelled, sending}`）——已 sent / 无投递 / sending 在途 都与「真取消」区分，不再一律回
  「已取消…待投递」（P2-26）。
- **重启时的「不确定投递」按通道幂等性分叉**（P2-10）：`recoverStaleSending` 只对 `webhook`
  （对端按 `X-Request-ID` 去重）复位重发；bark/ntfy/telegram/smtp/openclaw 及「通道未知」一律判
  `fallback` 终态、保留 `request_started_at`（`requeueRoute` 只捞 `IS NULL`，不会自动重投），
  重发只能人工走 `notify.retry`/`retryDeliveries`。通道名按该 Profile **当前生效路由**反查
  （`deliveries` 无 channel 列），换过通道的极少数场景按更保守一侧处理。
- **openclaw 通道的凭据边界**（P2-17）：Bearer token 优先取 `PROFILE_ROUTE_SECRETS_JSON[profile]`；
  只有「部署自身 profile（`HERMES_PROFILE`，缺省 `default`，见 `config.deploymentProfile`）」与
  「未登记独立 Profile token 的 profile」才回退全局 `OPENCLAW_HOOK_TOKEN`。登记了独立 token 的
  隔离用户配置/重新启用 openclaw 路由必须自带 secret，否则明确 fail；`validateRoute` 把路径收紧到
  `/hooks/<name>`（保留 `/hooks/agent?channel=&to=` 直连形态）。判定内核只有 `config.ts` 一份
  （`openclawCanUseGlobalToken`），工具层与投递层不得各写一套。收紧前已落库的隔离路由仍会投递，
  投递侧按 profile 打一条一次性 warn（不擅自拒绝，见 README 已知取舍 #33）。**存量**隔离路由允许
  停用后重新启用（与投递层对齐：共用 `warnOpenclawGlobalTokenFallback`，同文案同去重表，N-2）；
  `validateRoute` 另拒绝含 `..`/`.` 段、空段（`//`）或百分号编码 `%2e`/`%2f` 的 pathname
  （会被反代/Gateway 归一化到 `/hooks/` 之外，N-3）。
- **日程终态只有 `done` 一种**（P2-1 / P2-6）：`complete {all:true}` 对**任意 kind**（含生日/纪念日）
  置 `done` 并如实回执「已结束整个系列」；限次（`count`）用尽或截止（`until`）到期、且**已无待发
  pending** 时由物化收尾置 `done`（`recurrenceExhausted()` 显式问「到 until 为止还有没有候选」，
  不能拿「物化结果为空」当耗尽判据 —— 会把 400 天前瞻之外的合法下一次误判为结束）。判定 pending
  的守卫不可省，否则会吞掉「until=今天但提醒还没到点」的那一条。裸调 `complete` 行为不变。
- **跨年假日不猜**（P2-5）：12-25~12-31 的权威数据在下一年度文件里，`dayType` 对这段区间若所需年度
  未 `ready` 一律返回 `unknown` 并**暂停物化**（`holidayYearsNeedingData` 是「所需年度」的唯一来源，
  物化暂停时只登记**真正缺失**的年份，否则会去补已 ready 的年份导致永久暂停）；数据到达后
  `recheckCrossYearOccurrences` 复核该窗口 pending 行（误判作废、漏掉的回退重物化，每进程每个
  下一年度一次）。已知残留：`holiday {view:"month"}` 的未知文案仍只判「月份所属年份」，
  12 月的跨年几天可能少列而不报未知（下轮候选）。
- **工具参数契约**（P2-20 / P2-21）：7 个 action 参数化工具的规范参数名是 `action`，`view` 是兼容
  别名（两者都传且冲突要明确报错）；`air_quality` 与 `weather {action:"air"}` 共用同一个 `airView()`。
  与当前 action 无关的字段**显式拒绝**（`未知字段: X（action=Y 不接受）`，bookkeeping 与 notify
  两侧逐字一致），不再静默忽略；两条既有更具体文案（export 的 from/to、update 的 ledger_id）保留。
- **`doctor --live` 的「过期一次性日程」检查**（N-1）：`recurrence_json IS NULL AND calendar='solar'
  AND start_date < 今天 AND status='active'` 的行报 warn（列 id/profile/title + 收尾指引），
  用独立只读连接查（不升级 schema、不写库、不 fail）。
- `npm run db:cleanup:preview` 是**零业务删除**预演（打开旧库时仍可能执行附加式 schema
  升级，因此不保证零写入）：occurrence 清理 job（每日 04:30）与保留策略
  （通知/已取消日程，每日 04:50）会删掉哪些行——改清理规则前先用它。
