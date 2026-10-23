# Life Assistant v2 代码与文档评审报告（2026-10-22 第二轮）

- 评审日期：2026-10-22 ~ 2026-10-23（Asia/Shanghai）
- 评审范围：`README.md`、`AGENTS.md`、`ROADMAP.md`、`skill/SKILL.md`、`docs/**`、`.env.example`、
  `src/**`、`tests/**`、`package.json`、`.github/workflows/ci.yml`
- 上一轮：`code-review-2026-10-17.md`（18 条问题已修复）。本轮先逐条复核其修复无回归，
  再按「审查 → 修复 → 重审」循环处理新增问题；阶段二（schema v5、按 Profile 鉴权与可见性、
  投递多通道、审计/指纹、预算看板等）是本轮重点。
- 方式：
  1. **Round1 并行审查**：4 名审查员分别负责「HTTP/MCP 服务层与安全鉴权」「业务模块」「DB/迁移/运维/CLI/调度」
     「文档契约一致性」；只读审查，对可疑路径写临时脚本/临时测试实测复现。
  2. **Lead 复核与修复**：对每条 finding 逐条核实（能复现的亲自复现，不能复现的核对代码/契约），
     去重、剔除误报与已知取舍，再由原审查员按互斥写作用域修复；Lead 额外补修审查中暴露的小缺口。
  3. **Round2 独立重审**：另起 2 名未参与修复的审查员对全部改动做对抗式复核（回归/修复不完整/测试被削弱），
     仍只读；另有文档审查员对文档同步结果做验收。
  4. **Round2/3 修复与 Round3 独立重审**：修复 Round2 新发现的问题（含修复过程中暴露的同类缺口），
     再由 2 名新的独立审查员对 Round2/3 改动做回归复核。
- 验证基线（全部修复后）：Node 26.7.0 下 `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
  全部通过：**1043 tests / 239 suites / 0 fail**（评审前 964 tests）。`npm audit --omit=dev --audit-level=high`
  通过（仅剩 hono 的 moderate 公告，见「不计为缺陷的观察」）。
- 结论：Round1 共确认 **28 条**有效问题（P2×10、P3×15、文档×3；无 P1），Round2 复核又发现并修复
  **13 条**（P3×4、P4×9），Round3 复核再发现 **8 条**（均 P4，含 2 条文档），Round4 终审发现并修复
  **1 条 P3**（限流豁免绕过，既有缺陷）与 2 条 P4 观感项。循环最终收敛：终审后无 P1/P2/P3 问题、无回归。

## 结论速览

| # | 级别 | 问题 | 位置（修复前） | 状态 |
|---|---|---|---|---|
| A1 | **P2** | 限流按**未校验**的 Bearer 指纹分桶：每个请求换一个伪 token 即绕过 120/min 限流；桶表随伪 token 线性增长 | `src/core/ratelimit.ts:72-78`、`src/daemon.ts:292-306` | ✅ 已修复 |
| A2 | **P2** | `/api/quick/*` 与 `/calendar.ics` 的鉴权失败不计 `auth_failed_total`、不写 warn 日志，与 README/docs 承诺不符 | `src/server/quick.ts:83-108`、`src/server/calendar.ts:106-120` | ✅ 已修复 |
| A3 | **P2** | `/api/quick/*` 请求体无上限，且 body 在鉴权**之前**被完整解析（未鉴权可缓冲大 body、占连接） | `src/server/quick.ts:113-124,213-223,284-294` | ✅ 已修复 |
| A4 | **P3** | 鉴权失败日志来源取自未采信的 `X-Forwarded-For`（TRUST_PROXY=0 时也可伪造）；路径控制字符未净化 | `src/server/status.ts:244` | ✅ 已修复 |
| A5 | P3【文档】 | Profile token 权限矩阵过期：仍称「看板/运维接口只认 master」，实际 `/api/*` 按身份放行 | `README.md:60,108`、`.env.example:35`、`docs/quick-entry.md:83` | ✅ 已修复 |
| A6 | P3 | `/api/quick/schedules` 绕过 MCP schema 的 `remind_offsets` 边界（±43200、1-5 项），可写入 2 年后/过去的提醒 | `src/server/quick.ts:147-160,307-325`、`src/modules/schedule/service.ts:312` | ✅ 已修复 |
| B1 | **P2** | 启动补发用「当前时刻」跑日期型 job：跨午夜补发晚报/记账摘要日期错位，且 dedupeKey 吞掉当晚正常推送；周报白名单因 cron `dow≠*` 实际不可达 | `src/daemon.ts:515`、`src/core/jobs.ts:156-160`、`src/modules/weather/index.ts:922-946`、`src/modules/bookkeeping/index.ts:718` | ✅ 已修复 |
| B2 | P3 | `ledger {action:"budget"}` 的分类预算未走分类字典归一：用别名设的预算永远匹配不到已归一支出 | `src/modules/bookkeeping/index.ts:155,167`、`service.ts:1058,1100,1153` | ✅ 已修复 |
| B3 | P3 | 一次性待办带 `occurrence_key` 调 `complete` 后日程仍是 `active`（回执却写「已完成」），永久留在 list | `src/modules/schedule/service.ts:799-843` | ✅ 已修复 |
| B4 | P3 | 「假期最后一天」提醒硬编码「明天恢复正常上班」，次日是周末时内容错误 | `src/modules/holiday/index.ts:97-106` | ✅ 已修复 |
| B5 | P3 | `holiday {view:"month"}` 数据未就绪时返回「当月无安排」而非「未知」，与工具描述/SKILL 契约矛盾 | `src/modules/holiday/index.ts:144-158` | ✅ 已修复 |
| B6 | P3【文档/代码】 | README 已知取舍 #30 称 `expense list` 有 `id` 兜底，实际 `listExpenses` 缺 tiebreaker | `README.md:401` vs `src/modules/bookkeeping/service.ts:726` | ✅ 已修复（补代码） |
| B7 | P3 | `upcoming` 把同一事件多条提醒各列一条，并可能返回 `:resend`/`#esc:N` 派生 key（`snooze` 会拒） | `src/modules/schedule/service.ts:1133-1143,1007-1011` | ✅ 已修复 |
| C1 | **P2** | 同 B1（独立复现：09:00 重启补发昨天 21:30 摘要 → 生成错误日期摘要并占键，当晚真实摘要物化 0） | `src/core/jobs.ts:156-158`、`src/daemon.ts:515` | ✅ 已修复 |
| C2 | **P2** | `daemon.lock` stale 接管 TOCTOU：并发启动 15/40 次双双获锁；双持后先退出者让锁文件变死 pid，`db:restore` 误判未运行 → 活 daemon 上覆盖库/删 WAL 的数据丢失路径 | `src/core/lock.ts:129-147`、`src/restore.ts:136-143` | ✅ 已修复 |
| C3 | P3【文档】 | `.env.example` 称备份「停机期间不补跑」（与 24h 补发实现相反）；README 补发白名单清单漏 3 项 | `.env.example:113`、`README.md:327` | ✅ 已修复 |
| C4 | P3 | 安全基线（umask/权限）只在 daemon 路径生效：CLI 建库/备份/迁移前快照 0644、目录 0755 | `src/daemon.ts:339` vs `src/backup.ts` 等 CLI | ✅ 已修复 |
| C5 | P3 | 迁移前快照秒级命名不去重：同秒第二次 `VACUUM INTO` 同路径 → 拒绝启动且报误导性错误 | `src/core/database.ts:269-280` | ✅ 已修复 |
| D1 | **P2** | README 配置表/`.env.example` 称看板只认 master，与 `/api/*` 按 Profile 身份过滤矛盾，可能误导用户分发 master token | `README.md:60`、`.env.example:35` | ✅ 已修复 |
| D2 | **P2** | `.env.example` 称备份「停机期间不补跑」，与 README/SKILL/实现相反 | `.env.example:113` | ✅ 已修复 |
| D3 | P3 | AGENTS 称 maintenance「两个 job」，实际三个（含日志轮转） | `AGENTS.md:42` | ✅ 已修复 |
| D4 | P3 | 架构文件清单漏 `src/core/smtp.ts`、`src/doctor.ts` | `AGENTS.md:37-39`、`README.md:314` | ✅ 已修复 |
| D5 | P3 | README「状态页/`/api/expenses` 只统计家庭账本」与 Profile 个人视图矛盾 | `README.md:343` | ✅ 已修复 |
| D6 | P3 | README「已知取舍」导语漏列已实施的 #12/#24 | `README.md:352` | ✅ 已修复 |
| D7 | P3 | README 枚举 `CATCHUP_POLICY` 白名单只列 9/12 项 | `README.md:327` | ✅ 已修复 |
| D8 | P3 | README 能力表/outbox 设计要点只列 2 个投递通道（实际 6 个） | `README.md:15,321` | ✅ 已修复 |
| D9 | P3 | `docs/remote-access.md` 仍写 per-profile token「阶段二实现后启用」 | `docs/remote-access.md:38` | ✅ 已修复 |
| R1 | P3 | 修复过程中新发现：`/metrics` 鉴权失败只计数、不写 warn 日志，与 README「鉴权失败写 warn」契约不符 | `src/server/ops.ts:261-273` | ✅ 已修复 |

> 分组：A=服务/安全（`/tmp/la-review/round1/A-server-security.md`）、B=业务模块（`B-modules.md`）、
> C=DB/运维（`C-ops-db.md`）、D=文档（`D-docs.md`）。B1 与 C1 是同一根因的独立复现，只在 B1 计入唯一问题数；
> 表中共 28 行。

## 一、服务层与安全（A 组）

### A1（P2）限流可被任意 Bearer 绕过

`rateLimitKey` 对任何 `Authorization: Bearer <任意值>` 都直接取 token 指纹作限流 key，而限流发生在鉴权**之前**，
因此攻击者每请求换一个伪 token 就能拿到新桶（实测 `RATE_LIMIT_PER_MINUTE=2`：同一伪 token 第 3 次 429；
换 6 个伪 token 六次全部放行）。限流同时承担「公网暴露后不被日志/CPU 打满」的兜底，绕过即放弃该兜底；
且桶表只在新 key 出现时写入、`prune` 仅在 >10k 且只清过期，伪 token 会线性放大内存。

**修复**：双层固定窗口 —— 每个请求都计入「来源 IP」桶；只有凭据校验通过且带 Bearer 时才额外计入
「token 指纹」桶（无效/缺失凭据只落 IP 桶）；任一超限即 429。`FixedWindowLimiter` 增加 `maxBuckets`
硬上限（默认 10k，满时先清过期再淘汰最旧）。测试覆盖「轮换伪 token 仍被 IP 桶限流」「合法 token 跨 IP 共用一个身份桶」。

### A2（P2）quick/calendar 鉴权失败不可观测

`/api/quick/*` 的 `whoAmI` 401 与 `/calendar.ics` 的签名失败只返回状态码，不 `incCounter("auth_failed_total")`、
不写 warn 日志；而这两个端点正是文档要求公网暴露的入口（`docs/remote-access.md`），公网扫描在 `/metrics`
和日志里完全不可见，违反 README「鉴权失败写 warn 日志并计入 /metrics」的承诺。

**修复**：两处失败分支统一计数 + warn（来源地址走 `envClientAddress`，日历 503「未配置 token」不计鉴权失败）；
`/metrics` 的 401 也在同一轮补齐 warn 日志（R1）。

### A3（P2）quick 写接口无 body 上限且先解析后鉴权

`readJsonBody` 直接 `c.req.json()`，无大小限制，且发生在鉴权之前：实测未鉴权 + 28MB body → RSS +174MB；
慢 body 可占住连接（Node 默认 300s）。MCP 侧有 SDK 自带 4MiB 上限，quick 没有。

**修复**：两个 POST 路由挂 `hono/body-limit`（64 KiB，超限 413 中文错误体），顺序改为「鉴权 401 早退 → 读 body → 按 body.profile/query.profile 选目标 Profile」；
未鉴权 + 非法 JSON 现在返回 401 而非 400。测试用真实 HTTP server 验证 Content-Length 超大直接 413、不落库。

### A4（P3）失败日志来源可伪造、路径可注入控制字符

`status.ts` 的 `/api/*` 鉴权失败日志直接取 `x-forwarded-for`（`TRUST_PROXY=0` 时也采信，匿名请求可伪造来源 IP），
且 Hono 解码后的 `c.req.path` 可注入任意文本/ANSI ESC；与 `/mcp` 的 `clientAddress` 口径不一致。

**修复**：统一 `envClientAddress(c.env, config.trustProxy)`；路径经去 C0/DEL 控制字符 + 截断 200 字符后写日志；测试钉住
XFF 不进入 TRUST_PROXY=0 的来源字段、ESC 被过滤。

### A5（P3【文档】）Profile token 权限矩阵过期

README 配置表/`.env.example`/`docs/quick-entry.md` 仍称「看板/运维接口只认 master」；实测 Profile token 可读
`/api/status`、`/api/expenses`（家庭账本逐笔含备注）、`/api/budget`、`/api/expenses.csv`、`/api/jobs` 等（个人视图/共享数据），
只有 `/metrics` 等运维面是 master-only。按旧文档部署会低估 Profile token 泄露的爆炸半径（甚至把 master token 分发给家人）。

**修复**：按实际鉴权矩阵改写三处文档；README 补充「配置 `PROFILE_TOKENS_JSON` 时 Profile token 以 token 绑定为准，
`X-Hermes-Profile` 仅在 master/未配置 token 时生效」。

### A6（P3）/api/quick/schedules 绕过 remind_offsets 边界

MCP `schedule add/update` 的 zod schema 限制 `remind_offsets` 为 1-5 个、±43200 分钟的整数；quick 路由自己做
「数组 + 整数」检查后直接调工具层，服务层原来只校验条数上限。实测可写入 `[999999]`（提醒在 2 年后）、
`[-1000000]`（due 在过去）或 `[]`（零提醒死日程）。

**修复**：服务层新增 `validateRemindOffsets`（1-5 项、整数、±43200）：`createSchedule` 总校验，`updateSchedule`
仅在显式传 `remindOffsets` 时校验（历史脏数据的无关编辑不被卡死）；quick 越界/空数组返回 400。新增
`tests/quick-remind-offsets.test.ts`。

## 二、业务模块（B 组）

### B1（P2，与 C1 同根因）启动补发按当前时刻执行日期型 job

`daemon.ts` 补发回调 `def.handler(now())` 丢弃了 `scheduledFor`；`runEveningBrief`/`pushDailyDigests` 等按
`todayIso()` 取日期。停机跨过 21:00/21:30 后于次日 00:00–09:30 重启时（补发窗口 6h/12h 天然跨午夜）：

- 晚报按「新一天的明天」生成内容与 `dedupeKey=evening:<profile>:<后天>`，当晚 21:00 的正常晚报同键 → **被静默吞掉**；
  用户凌晨收到一条日期错位的「明日安排」。
- 记账摘要按新一天汇总：前一天摘要永久丢失；若新一天已有提前录入支出，还会生成错误日期摘要并占键、吞掉当晚真实摘要（已复现）。
- 周报的 `CATCHUP_POLICY` 条目（cron `0 20 * * 0`）因 `previousFireTime` 不支持 `dow≠*` 实际不可达，是死配置。

**修复**：
1. daemon 补发把「原定触发时刻」（`scheduledFor`，兼容带偏移的 ISO）解析成 `at` 传给 handler（无效时回退 `now()`）；
2. `runEveningBrief(at?)` 用参考时刻推导 today/tomorrow/expiresAt；`ledger_digest`/`weekly_report` handler 把
   `at.toISODate()` 传给 service；
3. `previousFireTime` 支持星期字段（单值/列表/范围/步长，`0`/`7`=周日；日、月仍必须为 `*`），周报补发真正可达。
测试覆盖跨午夜补发不再吞当晚推送、摘要/周报按原定日期生成、星期反查边界。

### B2（P3）分类预算未走分类字典归一

`expense add/update` 会把别名归一成标准名（「吃饭」→「餐饮」），但 `ledger {action:"budget"}` 只 trim：用别名设的预算
落在「吃饭」名下，支出记在「餐饮」名下 → 已用恒 0、80%/100% 阈值提醒永不触发，且无任何提示。

**修复**：budget/clear 的非空分类统一走 `normalizeCategory`（与记账同口径），回执在发生归一时附「分类归一」；
测试覆盖「别名设预算 + 别名记账 → 已用正确、阈值提醒触发」。

### B3（P3）一次性待办带 occurrence_key 完成不转终态

`completeSchedule` 只在「裸调」分支把 `kind=todo` 置 done；带 `occurrence_key`（list 的「待办发生」直接给出的值）完成时只结束
occurrence，日程仍 active：回执写「已完成」，但待办永远留在 `schedule list` 且再无提醒，用户没有收尾入口。

**修复**：带 key 完成时，若 `recurrence_json === null && kind === "todo"` 同样置 `status=done`（循环日程语义不变）；
更新 escalation/actions 测试并保留「循环日程单次完成不结束系列」的断言。

### B4（P3）「假期最后一天」文案不判次日类型

原实现无条件推送「明天（…）恢复正常上班」。公告假期最后一天可能是周五/周六（2019 清明/端午/中秋即该形态），
次日是无补班的普通周末，推送内容事实错误。

**修复**：按 `dayType(db, tomorrow)` 分支：workday/weekday → 恢复正常上班；weekend → 周末正常休息；
holiday → 仍是假期；unknown → 中性「假期结束」不猜。

### B5（P3）holiday month 视图把「数据未就绪」说成「当月无安排」

`view:"month"` 只查 `cn_holiday_days`，查不到即返回「当月无法定节假日/调休安排」，不看年份 `status`；与
`is_workday` 的「未知（不猜测）」口径、工具描述与 SKILL 的硬性边界矛盾。`2026-13` 也会静默当「无安排」。

**修复**：严格校验月份 1-12；年份未 ready 时返回「未知（YYYY 年节假日数据未就绪，不猜测）」+ 数据覆盖年份；
ready 时才给出表格/「无安排」。补就绪/未就绪用例。

### B6（P3）expense list 缺少 README 声称的 id 兜底

README 已知取舍 #30 称 `/api/expenses`、`/api/deliveries`、`expense list` 的排序都补了 `id` 兜底；实际
`listExpenses` 的 ORDER BY 只有 `spent_on DESC, created_at DESC`，`spent_on`+毫秒级 `created_at` 并列时 OFFSET 分页
不保证「页间不重复不跳行」。

**修复**：补 `, id DESC`（与 `/api/expenses` 一致）并新增「spent_on 与 created_at 全相同」的分页稳定性用例
（选择修代码而不是删文档，因为这是文档已承诺的实现细节）。

### B7（P3）upcoming 同事件重复且可能返回不可 snooze 的派生 key

`upcoming` 直接返回所有 pending 行：多提醒偏移（`#0..#4`）会让同一事件出现多条；只剩派生行时会返回 `:resend`/`#esc:N`，
而 `snooze` 明确拒绝派生 key —— schema 却说这些 key 可从 upcoming 取。

**修复**：`upcoming` 按 `${schedule_id}|${eventPrefix}` 事件前缀去重（与 `pendingOccurrences`/`agendaForDate` 同口径），
优先普通提醒行，再按 `due_at` 排序取 limit；补「多偏移只出现一条且可 snooze」用例。
Round2 重审后发现残留（R2-1）：若某事件只剩派生行 pending，去重集合仍会返回派生 key；已在 Round2 修复中
进一步过滤「代表行不是普通提醒行」的事件（这类事件不再出现在 `upcoming`，仍可从 `list` 的「待办发生」用
`complete` 收尾），使 schema 对 `snooze`/`skip` 的承诺成立。

## 三、DB / 运维 / CLI / 调度（C 组）

### C2（P2）daemon.lock stale 接管 TOCTOU（双持锁 → db:restore 数据丢失路径）

原实现「读锁 → 判断 stale → unlink → 重新创建」不是原子的：两个进程同时判断 stale 时，先创建者的锁会被后者的
**盲目 unlink** 删除，随后后者再创建 —— 双方都认为自己持锁（并发实验 15/40 次双持）。双持后先退出者的 release 逻辑虽比对 pid，
但锁文件可能已属于另一进程/已消失，`db:restore` 的运行中检测（只认锁）会把「活 daemon 在跑」判成「未运行」，
从而在运行中的库上覆盖并删除 `-wal`/`-shm`（未合并写入丢失）。

**修复**：
- 创建：先写唯一临时文件（内容完整）再 `linkSync` 到锁路径（原子「不存在才出现」，不会出现空锁文件窗口）；
- 接管：`renameSync` 抢占旧锁 → dev/ino 身份校验 + 内容回读；若误移走活锁则 `link` 放回原位并报「已有实例」；
  ENOENT/竞争有界重试（10 轮），`.stale-*`/`.tmp-*` 残留必清理；
- `inspectDaemonLock` 四态（unlocked/locked/stale/corrupt）；`db:restore` 对 corrupt（存在但损坏/不可读）**拒绝**
  （无法确认已停服），dead-pid stale 仍放行。
40 次双进程 stale 并发压测双持 0 次；新增并发/四态/restore 用例。

### C4（P3）安全基线只在 daemon 生效

`umask(0o077)`/`hardenDataDir` 只在 `startDaemon` 调用；`db:backup`/`db:restore`/`import:v1`/`db:cleanup:preview`/
`db:fingerprint` 被用户手工执行（尤其 `import:v1` 常在任何 daemon 启动前首次建库），按默认 umask 022 会留下
0644 的库/备份/迁移前快照、0755 的目录，同机其它用户可读个人账目/日程/通知。

**修复**：新增 `applyCliSecurityBaseline(config, { harden })`（applySecureUmask + 可选 hardenDataDir），在 5 个 CLI 的
`loadConfig` 之后、任何 mkdir/open 之前调用；`doctor` 只设 umask（自检不主动 chmod 用户文件）。
Round2 重审后又收紧时机：`db:restore --dry-run` 只设 umask、不再 chmod（修掉「预演也会改权限」）；
`db:backup`/`db:fingerprint` 在库不存在时只设 umask（DATA_DIR 指错不再误 chmod 无关目录）；
`db:cleanup:preview` 把「库是否存在」校验提到基线之前；`import:v1` 只设 umask（目标库可能尚未创建）。
新增 `tests/cli-security.test.ts`（含真实 `db:backup` CLI 产物权限 0600/0700 与上述时机用例）。

### C5（P3）迁移前快照秒级命名冲突

迁移前快照文件名精确到秒，同秒第二次执行（升级窗口里 daemon 重启与 CLI 并发/失败立刻重试）会撞名；`VACUUM INTO`
要求目标不存在，撞名时迁移失败拒绝启动，错误还是误导性的「file is not a database」。

**修复**：抽出并导出 `uniqueFilePath`（restore 的留底去重逻辑复用），迁移前快照改用不存在的文件名（-1/-2…）；
补「冻结时钟同秒两次迁移生成两份快照」用例。Round2 重审发现两进程并发打开同一老库时仍有「先查后用」竞态：
改为 `VACUUM INTO` 失败且目标文件已存在时换下一个不冲突名字重试（最多 3 次，真实故障不重试）；
并发迁移同一库本身不是受支持场景（daemon 有单实例锁），但「快照名冲突」不再导致误报失败。

## 四、文档契约（D 组）

D1/D2 两条 P2 与 7 条 P3 均为文档事实性偏差（配置表权限矩阵、备份补发口径、job 数、文件清单、Profile 视图口径、
已知取舍导语、补发白名单、通道清单、过期阶段说明）；逐条按代码事实更正，并在行为修复后统一同步了本轮变更
（双层限流、星期补发、原定触发时刻、锁/恢复、CLI 安全基线、Profile 权限矩阵、upcoming 去重）。详见「结论速览」与
修复后的 README/AGENTS/SKILL 文档。

## Round2 重审结论（独立审查员，未参与修复）

Round1 修复完成后，另起 2 名未参与修复的审查员对**全部改动**做对抗式复核（只读，逐条写探针实测），
同时 Lead 与修复者又暴露了若干同类缺口。复核确认 Round1 的 A1–A6、B1–B7、C1/C2/C4/C5 主修复全部有效、
被修改的既有测试未被削弱；新发现 13 条（P3×4、P4×9，无 P1/P2），均已修复并加测试：

| # | 级别 | 问题 | 位置（修复前） | 状态 |
|---|---|---|---|---|
| R2-1 | P3 | `upcoming` 在只剩 `:resend`/`#esc:N` 派生行时仍返回派生 key（snooze/skip 拒绝） | `src/modules/schedule/service.ts` upcoming | ✅ 已修复 |
| R2-2 | P3 | `runDailyBrief`/`runWorkdayWatch` 忽略补发传入的 `at`：把 cron 配到 18:00 后（合法配置）凌晨补发仍会日期错位/丢当晚推送 | `src/modules/weather/index.ts`、`src/modules/holiday/index.ts` | ✅ 已修复 |
| R2-3 | P3 | calendar 鉴权失败日志直接拼接 `verdict.reason`：未鉴权请求可把 ESC/换行/超长文本注入日志 | `src/server/calendar.ts` | ✅ 已修复 |
| R2-4 | P3 | 限流 429 日志打印完整 URL，`?token=<master>` 原文进日志（非本轮引入的日志卫生问题） | `src/daemon.ts` | ✅ 已修复 |
| R2-5 | P4 | CLI 安全基线时机副作用：`db:restore --dry-run` 会 chmod 现有目录/库；DATA_DIR 指错时先 chmod 错误目录 | `src/restore.ts`、`src/cleanup-preview.ts` 等 | ✅ 已修复 |
| R2-6 | P4 | 迁移前快照名「先查后用」TOCTOU：两进程并发打开同一老库仍可能拒绝启动（6/6） | `src/core/database.ts` | ✅ 已修复 |
| R2-7 | P4 | 死代码：`rateLimitKey`、`isDaemonLocked`、`FixedWindowLimiter.maxSize` 已无生产调用 | `src/core/ratelimit.ts`、`src/core/lock.ts` | ✅ 已清理 |
| R2-8 | P4 | 锁残余：`.stale-*`/`.tmp-*` 崩溃残留无清理；误移活锁放回遇 EEXIST 时静默丢弃 | `src/core/lock.ts` | ✅ 已修复 |
| R2-9 | P4 | `previousFireTime` 星期范围/步长含 `7` 与 node-cron 实际语义不一致（如 `6-7` 实际=每天） | `src/core/jobs.ts` | ✅ 已修复（保守放弃反查） |
| R2-10 | P4 | `holiday {view:"month"}` 跨年日期行（如 2026-12-31 来自 2027 文件）因年份未 ready 被说成「未知」 | `src/modules/holiday/index.ts` | ✅ 已修复 |
| R2-11 | P4 | 存量别名预算行（旧版本写入）仍恒为已用 ¥0，重设别名预算会并存两条同义预算 | `src/modules/bookkeeping/index.ts` | ✅ 已修复（写入时清旧行） |
| R2-12 | P4 | A6 收口缺口：`import:v1` 可写越界/非整数偏移；`update remind_offsets:null` 抛内部 TypeError | `src/import-v1.ts`、`src/modules/schedule/service.ts` | ✅ 已修复 |
| R2-13 | P4 | 日志净化同类残余：quick/ops/daemon 的请求可控字段（path、XFF 来源地址、`mcp-session-id`）未净化 | `src/server/quick.ts`、`src/server/ops.ts`、`src/daemon.ts` | ✅ 已修复 |

## Round3 重审结论

Round2/3 修复后，又由 2 名全新独立审查员对**本轮新增改动**做回归复核（只读 + 独立探针），
并复跑 Round2 的缺陷探针确认修复生效。复核确认 Round2 的 S/T/M 系列主修复全部有效，
新发现 8 条唯一问题（均 P4，无 P1/P2/P3；其中 2 条为文档措辞），修复后进入 Round4 终审：

| # | 级别 | 问题 | 位置（修复前） | 状态 |
|---|---|---|---|---|
| R3-1 | P4 | `previousFireTime` 的「范围+步长」与 node-cron 不一致（node-cron 先展开范围再取模）：`0 9-18/2 * * *`、`0 20 * * 1-5/2` 会漏补/多补 | `src/core/jobs.ts` | ✅ 已修复 |
| R3-2 | P4 | `db:restore` 非 dry-run 在目标校验/锁检测前就 chmod 目录/库/备份（`--file` 不存在时先改权限再报错） | `src/restore.ts` | ✅ 已修复 |
| R3-3 | P4 | `sanitizeLogText` 未滤 C1（含 NEL U+0085）/U+2028/U+2029，XFF 原始字节可造成日志跨行 | `src/core/logger.ts` | ✅ 已修复 |
| R3-4 | P4 | `upcoming` 先 `LIMIT rowLimit` 再过滤派生行：前 N 行全为 derived-only 时正常提醒被整批吞 | `src/modules/schedule/service.ts` | ✅ 已修复 |
| R3-5 | P4 | 用**标准名**重设/清除预算时不清旧别名行（只有别名→标准方向会清），同义预算并存 | `src/modules/bookkeeping/index.ts` | ✅ 已修复 |
| R3-6 | P4 | `import:v1` 提醒超过 5 项时静默截断、无 warning | `src/import-v1.ts` | ✅ 已修复 |
| R3-7 | P4【文档】 | `SKILL.md` upcoming 条款写「同事件只出现一条」但未说明 derived-only 事件不展示 | `skill/SKILL.md` | ✅ 已修复 |
| R3-8 | P4【文档】 | README/AGENTS 的 `at` 覆盖范围只写晚报/摘要/周报，漏了早报与调休提醒 | `README.md`、`AGENTS.md` | ✅ 已修复 |

## Round4 终审结论（收敛判定）

由一名未参与此前任何审查/修复的验收员做最终独立验收：先复现全量基线（**1042 tests / 239 suites / 0 fail**，
`docs-consistency` + `http-shortcuts-docs` 16 tests 全绿，typecheck/lint/format 全绿），再对 Round3 七项修复
逐项做独立探针（结果全部通过），最后对全 diff 做抽查（无测试删除/跳过、无空断言；旧缺陷探针失败=修复生效）。

- Round3 验收证据摘要：`previousFireTime` 以 node-cron 自带 `TimeMatcher` 为 oracle 对 1430 个表达式采样
  **0 mismatch**（`0 9-18/2 * * *`=10/12/14/16/18、`0 20 * * 1-5/2`=周二/周四）；restore 六条失败路径
  （`--file` 不存在/坏备份/高版本/锁损坏/活 pid/dry-run）权限位完全不变、成功路径才收紧；C1/NEL/U+2028/29
  全部过滤且 token/sig 打码覆盖；60 条 derived-only 提醒后 `upcoming` 仍返回正常提醒且无派生 key；预算标准名
  set/clear 清掉同义旧行；import >5 截断 warning 可见。
- **终审新发现 1 条 P3（既有缺陷，非 Round3 回归）**：R4-1 限流豁免用原始 `req.url` 前缀判断，
  `/healthz/../api/status`（或 `%2e%2e`）会被 Hono/URL 归一化到真实业务路由却仍被当作探针跳过限流 ——
  README「除 `/healthz`、`/readyz` 外均限流」承诺被完全绕过，且可无限触发鉴权失败日志（无越权/数据泄露）。
  已修复：豁免改为**精确路径**匹配（`isProbeExemptPath`，允许携带 query），新增底层 `http.request` 回归测试
  （正常路径 401,401,429,429 vs 绕过路径也必须 429；精确 `/healthz` 仍豁免）。同轮顺手修掉 2 条 P4 观察：
  README 一处笔误、`db:restore --data-dir` 指向普通文件时先 chmod 再报错（改为写盘前确认目录类型）。
- 其余 P4 观察（`sanitizeLogText` 截断边界补省略号、`maskSensitiveUrl` 对非敏感参数重新编码、预算读侧存量
  别名、`DEFAULT_MAX_BUCKETS` 冗余导出等）均为非功能性的观感/加固项，已列入下节「残余风险」，不作为循环继续依据。
- **收敛结论**：终审后无 P1/P2/P3 功能性、安全或数据完整性问题，Round3 修复无回归；修复后全链路
  **1043 tests / 239 suites / 0 fail**（终审基线上仅新增 1 条 R4-1 回归用例）。「审查 → 修复 → 重审」循环达到
  收敛标准，可以结束。

## 修复后验证与残余风险

- 全链路（Node 26.7.0）：**1042 tests / 239 suites / 0 fail**；`typecheck`/`lint`/`format:check`/`build` 全绿；
  `npm audit --omit=dev --audit-level=high` 通过。
- 不计为缺陷的观察（有意取舍，已核对实现与文档一致）：
  1. `npm audit` 报 hono 4.12.4–4.13.10 的 moderate 公告（`serveStatic` 路径二次解码绕过中间件）。本仓库不使用
     `serveStatic`（状态页/quick 页均为内联 HTML + CSP），不可利用；CI 口径为「生产依赖 high/critical 零容忍」，
     moderate 不阻断，故本轮不升级（升级属于依赖维护，不在审查修复范围）。
  2. 存量别名预算：写入路径会归一；用标准名或别名重设/清除预算时会一并清理同账本内归一后同义的旧行。
     但**读侧不做归一**：升级前已存在的别名预算行在用户重设一次之前仍显示「已用 ¥0」、不触发阈值提醒。
     不做一次性数据迁移（避免在启动迁移里静默改用户预算金额），README 记账预算条目已写明「建议重设一次」。
  3. 补发仍只补最近一次、日/月字段非 `*` 的 cron 仍不反查。分钟/小时/星期支持 `*`、单值、逗号列表、
     `a-b` 范围与 `a-b/n` 步长（按 node-cron 的「展开后取模」语义）；`7` 仅允许单值/单值列表，含 `7` 的
     范围/步长与「列表+步长混用」等无法精确复刻 node-cron 的写法保守不做反向求值（宁可漏补，不猜）。
     README 已知取舍 #19 与 AGENTS 已同步。
  4. 派生-only 事件的 `upcoming` 展示：某事件只剩 `:resend`/`#esc:N` 派生提醒时，`upcoming` 不再列出该事件
     （避免给出 snooze/skip 不支持的 key）；仍可从 `list` 的「待办发生」取 key 用 `complete` 收尾。
  5. `import:v1` 对越界/非整数的 `remind_offsets` 做 trunc + clamp（±43200）并写 warning，而不是拒绝整条导入
     （历史数据入口以「尽量导入 + 留痕」优先）。
  6. 迁移前快照名冲突在 `VACUUM INTO` 失败且目标已存在时换名重试（≤3 次）；两个进程并发迁移同一库本身不是
     受支持场景（daemon 有单实例锁、CLI 并发迁移属误用），此场景仍可能有一个进程失败（不再误报为
     「file is not a database」）。
  7. 锁的「误移活锁后放回」在三进程 + 微秒级窗口下若原位已被新锁占用，只能告警并丢弃副本（30 轮并发压测
     未复现；正常单实例/双实例启动路径已由 rename+inode 校验保证）。
  8. `FixedWindowLimiter` 的桶上限淘汰是 O(n log n)（10k 桶满时约 0.2ms/新 key），用于兜底攻击场景的内存增长，
     常规请求不受影响。`DEFAULT_MAX_BUCKETS` 为便于测试/文档而导出，生产代码内部也使用它。
  9. 日志工具的两处「观感」取舍：`sanitizeLogText` 在长度恰好等于上限时也会补省略号；`maskSensitiveUrl`
     会经 `URLSearchParams` 重新编码非敏感参数（语义不变，仅编码形态可能变化）。二者均非功能缺陷。
  10. `db:restore` 的 `--data-dir` 指向普通文件时会在写盘前报「数据目录不是目录」并保持文件权限不变（终审后已修）；
     恢复过程本身仍假定「已停机」这一前提（README 已知取舍）。
- 上一轮（2026-10-17）的 18 条修复经逐条复核无回归。


## 部署冒烟与后续修复（2026-10-23）

评审循环收敛后，按建议做了部署侧冒烟（新构建先在隔离临时 DATA_DIR 启动，再刷新本机 launchd 实例）：

1. **隔离冒烟**：`node dist/daemon.js` + 临时 DATA_DIR（无 token/QWeather）启动正常；`/healthz` 200、
   `/readyz` 200、`/api/status`、`/metrics`、状态页、`/calendar.ics`（无 token 时 503 并给中文原因）、
   `/mcp` initialize（200 + `mcp-session-id`）均符合预期；`doctor` 与 `doctor --live`（离线/在线）通过；
   SIGTERM 优雅退出并删除 `daemon.lock`。
2. **本机正式实例刷新**：`launchctl kickstart -k gui/501/ai.life-assistant.daemon` 后，正式 daemon 从旧进程
   （pid 56497，10-21 启动）换为新构建（pid 44368）：`/healthz`、`/readyz`、`/api/status`、`/api/jobs`、
   `/metrics`、状态页、带 Bearer 的鉴权矩阵均正常；锁文件 pid 一致；日志无启动错误。
3. **冒烟发现并修复 1 条既有缺陷（P3，非评审引入）**：`doctor --live` 的任务新鲜度阈值固定为
   「补发窗口×2」（日报/晚报 6h→12h），但每日任务的自然间隔是 24h —— 21:00 的晚报在次日 09:00
   必然报 fail（正式库冒烟实际出现），日报在凌晨同理，属监控误报。
   修复（commit `bc88089`）：阈值改为 `max(窗口×2, cron 实际触发间隔×1.5+1h)`，并对 `previousFireTime`
   的 UTC 返回值先换回本地时区再反推间隔（避免 7 点被当 UTC 7 点、间隔错位 8h）。
   修复后正式库 `doctor --live`：**0 项失败、1 项警告**（仅剩「2 个非规范命名备份文件（迁移前快照）」
   的预期提示），日报/晚报/调休阈值均为 37 小时，备份 48 小时。全链路回归 1044 tests / 239 suites / 0 fail。
4. **遗留观察（非仓库问题）**：`daemon.err.log` 中有约每 5 分钟一次的 `鉴权失败: /mcp from 127.0.0.1`
   （重启前即存在，重启后仅见一轮重连尝试）——说明某个本地 MCP 客户端未带正确 Bearer；鉴权按设计拒绝了它，
   不影响 daemon 健康。若 Hermes 侧 MCP 工具报未授权，检查该客户端的 `WEB_API_TOKEN`/`MCP_DAEMON_TOKEN` 配置。
