# Life Assistant v2：后续功能建议与改进方向

- 评估日期：2026-10-20
- 评估范围：`src/**`（11.7k 行）、`tests/**`（16.8k 行）、`README.md` / `AGENTS.md` / `skill/SKILL.md`、CI 与配置文件、本机真实运行库（只读采样）
- 验证基线：`typecheck / lint / format:check / test / build` 全绿；**531 tests / 111 suites / 0 fail**；行覆盖率 **94.76%**、分支覆盖率 **86.65%**（`node --experimental-test-coverage`）
- 线上采样：daemon v2.0.0 连续运行约 50 小时，`/healthz` OK，日志 186 info / 9 warn / **0 error**，每日 03:00 备份正常产出
- 实施状态（2026-10-20）：§5「Now」的 12 项已全部落地（commit `43107d7` + `d89fe78`），进度与遗留项见仓库 `ROADMAP.md`；§6 的取舍判断保持原样

---

## 0. 速览

**一句话判断：这个项目的工程质量已经明显高于它的产品广度与运维成熟度。下一步的瓶颈不在"写不出来"，而在四件事：主动推送的可信度、通知的触达与噪声、每日闭环的完整度、以及多用户/远程/无人值守所需的安全与身份基线。**

四条建议主线：

1. **把"确定性推送"从能跑做成可信赖**：补上 job 运行记录、错过补发、备份恢复闭环、投递/备份状态上屏。这是产品的生命线——用户感知到的"助理"就是每天那几条推送，丢一条就少一次信任。
2. **把通知做成"可配置的通道矩阵"**：当前只有 webhook（回环 Hermes 网关）+ log；真实数据里 **80% 的通知是家庭级重复投递**（记账回执、天气简报、预警、月报各 Profile 各一份）。需要通道扩展（Bark/ntfy/邮件）+ 按类型偏好/聚合 + 家庭级去重。
3. **把每日闭环做深**：早报补上"今日日程"，增加晚报/周报，给提醒加 snooze/skip。这三件事全部复用现有 outbox/recurrence，成本小、感知强。
4. **把平台基线补齐**：per-profile 身份/可见性、Host/Origin 校验、文件权限、单实例锁、迁移前备份。它们本身不产生用户价值，但决定了手机入口、共享日程、外部监控这些事能不能安全地做。

### 建议优先做的 11 件事

| # | 事项 | 为什么现在做 | 成本 |
|---|---|---|---|
| 1 | `job_runs` 运行记录 + 启动补发（早报/调休） | 停机/升级/重启会静默丢当天推送，这是核心价值点 | 小 |
| 2 | 状态页「任务/备份/投递健康」卡片 + `doctor --live` | 目前运维状态只能翻日志；备份失败、fallback 堆积都不可见 | 小 |
| 3 | 备份恢复闭环（`db:restore` + 校验 + 状态展示） | 有 14 份备份但恢复仍是手工四步，且从未校验过备份可打开 | 小 |
| 4 | 修掉"补班提醒推两遍"与"写路径无幂等键" | 前者已在真实数据复现 4 次；后者会让 MCP 超时重试变成重复记账/重复日程 | 小 |
| 5 | 通知通道扩展 + 按 kind 偏好/聚合 | 现在完全依赖 Hermes 网关；172 条记账回执是最大噪声源 | 中 |
| 6 | 早报加今日日程；新增晚报（21:00）/周报（周日） | 数据都在库里，目前早报只有天气与假期，浪费了日程/记账数据 | 中 |
| 7 | `schedule` 增加 snooze / skip（单次发生级）+ 修 `complete` 语义 | 现有"完成"不带 key 会终止整个循环；"打下班卡/每日巡检"67 条 occurrence、0 完成 | 中 |
| 8 | 预算引导 + 预算看板 + 可执行月报 | 预算功能完整但 0 使用；记账已跑 2 个月，基础设施齐备 | 小–中 |
| 9 | ICS 导出/订阅 + 写 API（快捷指令） | 与用户真实日历/手机自动化的两个入口；不改数据模型即可做 | 中 |
| 10 | 鉴权/部署安全基线：per-profile token + `REQUIRE_AUTH`/Host 校验 + umask + 单实例锁 | 当前零 token，`/api/status` 与 `/mcp` initialize 实测匿名 200；DB/备份 0644；换 PORT 可双实例同库 | 中 |
| 11 | 迁移前备份 + 迁移事务化 + 索引失败不再只 warn | 升级是唯一不可回滚的高风险操作；账本名唯一索引失败会静默失去唯一性 | 中 |

---

## 1. 项目现状

### 1.1 定位与架构

单守护进程（Node ≥ 22.16，`node:sqlite`）同时承载：

- MCP over Streamable HTTP（7 个工具，域内 action 参数化）
- node-cron 定时调度（8 个 job + 每分钟 tick）
- SQLite outbox 主动推送（通知/投递同事务、有界重试、幂等窗口、静默时段）
- Hono 状态页 + 只读 `/api/*` + `/healthz`
- CLI：`db:backup`、`db:cleanup:preview`、`doctor`、`import:v1`

分层：`src/core`（框架）→ `src/modules`（weather/holiday/schedule/bookkeeping/notify/maintenance，经 `modules/index.ts` 注册）→ `src/server`（状态页与只读 API）。核心不反向依赖模块，由 `tests/registry.test.ts` 的静态 import 扫描强制。这个约束在个人项目里很少见，是后续加模块的最大资产。

### 1.2 能力面

| 域 | 已具备 | 关键边界 |
|---|---|---|
| 天气 | 实时/7 日/预警/空气质量、出行模式、位置保存 | 无小时级、无生活指数、无日出日落；单时区 Asia/Shanghai |
| 节假日 | 大陆法定节假日/调休、每日刷新、workday/holiday 过滤 | 无"距假期还有几个工作日"、无年假规划、无公司自定义假期 |
| 日程 | 公历/农历、生日/纪念日、daily-weekly-monthly-yearly、until/count、工作日过滤、5 组提醒偏移、到点重发、逾期升级阶梯 | 无 snooze/skip、无单次改期、无标签/优先级、无结束时间/多天、无共享日程 |
| 记账 | 家庭/个人账本、月度预算（总额/分类）、80%/100% 跨越提醒、月报、CSV 导出、编辑/删除 | 只记支出；无收入/转账/报销/分摊/多币种；无周期账；无导入；无附件 |
| 通知 | outbox、webhook(HMAC V2)/log 通道、静默时段、pull 兜底、取消 | 无 Bark/ntfy/邮件；无 per-kind 偏好/聚合；家庭级内容逐 Profile 重复 |
| 状态页 | 支出/日程/假期/投递/系统五个抽屉、CSV 下载、CSP + token | 只读；无任务/备份卡片；无预算区块；无写操作 |
| 运维 | 内置每日备份、保留策略、doctor、cleanup 预演、优雅停机 | 无恢复命令、无备份校验、无指标、无 job 历史、无构建指纹 |

### 1.3 工程质量基线（本次实测）

- **测试**：531 个用例、111 个 suite、0 失败；测试代码 16.8k 行，是源码的 1.44 倍。
- **覆盖率**：整体行 94.76% / 分支 86.65% / 函数 92.67%。低覆盖集中在 `daemon.ts`（72.05% 行 / 45.71% 函数）、`doctor.ts`（62.69%）、`import-v1.ts`（87.20%）——都是"启动编排/CLI 检查"这类较难测的路径。
- **CI**：Node 22.16.0 / 22 / 24 三档矩阵，顺序 typecheck → lint → format:check → test → build。缺口：仅 ubuntu（生产是 macOS + Node 26，不在矩阵）；无 coverage 门禁、无 `npm audit`、无 `dist` 冒烟。
- **依赖**：7 个运行时依赖，体量克制。`npm audit --omit=dev` 有 4 条告警（1 critical `proxy-addr`、1 high MCP SDK、2 moderate），均来自 MCP SDK 的 `express/ajv` 传递依赖；本项目的 HTTP 入口走 Hono，不加载 express 路径，实际可利用性低，但升级 SDK（1.30 → 1.32.1）即可消除，`npm audit fix` 即可完成。
- **安全/部署基线（实测，见 P0-6）**：`WEB_API_TOKEN` 未配置，`GET /api/status` 与 `POST /mcp` initialize **匿名 200**；无 Host/Origin 校验；DB 与备份 0644、data 目录 0755（`.env` 与 JWT 私钥 0600，合格）；无单实例锁；`/healthz` 只有存活信息。
- **代码文化**：注释普遍记录"为什么"和历史踩坑（如并发 drain 游标、幂等窗口、跨年假期），没有 TODO/FIXME 残留；`tests/docs-consistency.test.ts` 会校验 README/AGENTS/.env.example 的脚本清单与 GeoAPI 例外说明。这是同类项目里少见的水位。

### 1.4 真实使用画像（本机只读采样，截至 2026-10-20 12:39）

| 指标 | 数值 | 解读 |
|---|---|---|
| Profile | 2（default / bestie） | 双人家庭场景已经在真实使用 |
| 日程 | 39（12 active / 26 done / 1 cancelled） | 31 个 todo、5 个农历生日、3 个纪念日；高频用法是"每天 9:00 巡检、17:30 下班卡"这类周期提醒 |
| 支出 | 123 笔（115 家庭 / 8 个人） | 2026-08 起；记账人 bestie 91 / default 32 |
| 分类 Top | 礼物 ¥2825.9、旅行 ¥2113、人情 ¥2000、养车 ¥1109、餐饮 ¥730 | 大额低频消费 + 小额高频餐饮并存 |
| 通知 | 346 条；投递 345 sent + 1 cancelled；**全部已读** | 投递链路健康 |
| 通知构成 | 记账回执 172、天气简报 74、日程提醒 62、预警 14、月报 6、假期 12 | **回执占 49.7%**；家庭级内容（回执/简报/预警/假期/月报）≈ 80% 且每 Profile 各一份 |
| 日程使用质量 | 「每日巡检」「打下班卡」各 67 条 occurrence、**0 条 done**；两条合计 45 条提醒 0 完成 | 不是用户不想完成，是 `complete` 不带 `occurrence_key` 会终止整个循环，操作"贵且危险" |
| 过期未收口 | 「代购下单」截止 10-19 仍 active；「排查 SPD」until 9-15 仍 active | 无逾期标记/自动结束，列表会积累"僵尸日程" |
| 分类 | **25 个自由文本分类**（日用品/日用、餐饮/午餐、买菜/食材/水果/零食并存） | 统计/预算靠字符串对齐，月报可读性下降 |
| 天气用量 | 77–84 次/上游日（10-20 12:39 已 47 次） | 预警巡检每 20 分钟 × 预警缓存 10 分钟 → 每天约 72 次，占大头 |
| 预算 | 0 条 | 功能上线后尚未被使用（需要引导/看板） |
| 备份 | 每日 03:00 自动产出，保留 14 份 | 内置 job 工作正常 |
| 库体量 | 主库 745 KB，WAL 约 4.1 MB | 个人规模远未到 SQLite 压力点 |

几个直接推论：

- 这个系统**不是玩具**：双 Profile、按人记账、真实推送路由（Hermes webhook）都已在跑。
- 投递层很健康（346 条里 345 sent、0 error），但**内容层有重复**：`346` 条里约 `278` 条是家庭级内容按 Profile 各发一次（172 回执 + 74 简报 + 14 预警 + 12 假期 + 6 月报），双人家庭实际只需要一半左右的推送量；补班日还额外出现"早报内一行 + 独立通知"的同义重复（已发生 4 次）。
- 日程/待办的"完成"设计有摩擦：两条每日循环各 67 条 occurrence、0 完成，说明用户没有用"完成"这个动作；不改语义的话，加再多提醒类型都不会提升闭环率。
- 预算功能有完整实现（含跨越阈值判定、月报对照）但 0 使用，说明"能力存在"≠"用户会用"，需要看板/建议/入口。
- 系统当前按"单机单人"假设运行：零 token、`/api/*` 与 `/mcp` 匿名可访问、DB/备份 0644。这不是 bug，但它是所有"多用户/手机/远程"建议的前置门槛。

### 1.5 成熟度判断

- **工程成熟度**：高。测试/文档/错误处理/迁移/停机收敛都按生产标准在做。
- **产品成熟度**：中。能力面覆盖"天气+假期+日程+记账+推送"，但每日闭环偏薄（早报无日程、无晚报/周报），交互只有"对话"一个入口。
- **运维成熟度**：中低。备份能生成但难恢复、任务状态不可见、构建与运行版本无指纹、部署文档只覆盖 systemd（本机实际用 launchd）；更关键的是当前**零 token + 无网络边界校验**，属于"只敢在单机单人下运行"的状态。
- **安全成熟度**：单机单用户可接受，多用户/远程暴露前必须先补主体（per-profile token/scope）、Host/Origin、文件权限与单实例锁。这不是"功能"，是能否对外提供服务的门槛。
- **可扩展性**：高。模块契约、通道抽象、outbox、recurrence、settings 都是现成的扩展点；新增一个域的成本主要是"业务逻辑 + 测试"，不是"框架改造"。

---

## 2. 值得保持的设计资产（后续改造不要动）

1. **确定性推送、服务端无 LLM**。内容由模板/数据组装，可预期、可测试、不会幻觉。LLM 放在 Hermes 侧做对话与解释，边界正确。
2. **outbox 的语义完整度**：通知与投递同事务、有界重试、确定性拒绝不重投、不确定投递不盲重发、过期预警不补投、静默时段 per-Profile 不互相拖垮（drain 游标那段实现尤其扎实）。
3. **单写者 + STRICT 表 + 外键 + 追加式迁移**。个人规模下这是最省心的选择，不要为了"扩展性"引入 PostgreSQL/Redis/消息队列。
4. **模块契约与静态依赖检查**。`core` 不 import `modules` 由测试强制，这是后续加域的护栏。
5. **隐私分区口径**（家庭账本 vs 个人账本、个人账本月报只发归属人）与**通知标题脱敏**的方向是对的；需要补的是 HTTP 层的身份，而不是数据模型。
6. **文档即契约**。README 是权威设计文档、SKILL 是 agent 语义、`docs-consistency` 测试防止漂移——继续保持。

---

## 3. 改进方向（工程/运维）

### P0：影响核心价值或数据安全

#### P0-1 错过 cron 不补发（README 已知取舍 #13）

- **现状**：`weather.daily_brief`、`holiday.workday_watch` 默认 07:00；node-cron 不补发。daemon 在 07:00 前后停机（升级、崩溃、launchd 重启、机器关机）当天推送永久丢失，无日志、无状态页提示。月报有 6 个月回看补发，这两类没有。
- **证据**：`src/modules/weather/index.ts` 的 `runDailyBrief` / `src/modules/holiday/index.ts` 的 `runWorkdayWatch` 均无 `onStart` 补跑；README #13 自认。
- **建议**：
  1. 新增 `job_runs(job_name, scheduled_for, started_at, finished_at, status, error)` 表，所有 job 由统一 wrapper 写入；
  2. daemon 启动后（`onStart` 完成、首个 tick 前）检查"今天应跑但未跑"的 job，用现有 `dedupeKey`（`brief:<profile>:<city>:<date>`、`holiday:*:<date>`）幂等补跑；
  3. 状态页展示每个 job 的"上次运行/结果/下次预计"；`doctor` 对"最近一次早报超过 26 小时"告警。
- **成本**：小（1–2 天）。**收益**：直接消灭"某天没收到早报"的静默故障。

#### P0-2 可观测性缺口

- **现状**：状态页只有概览、支出、日程、假期、投递、系统信息；**没有 job 运行历史、没有备份状态、没有通道健康、没有失败投递的具体原因**。`/healthz` 只有 `{ok, version, uptime_s}`。日志是唯一真相源，且 launchd 下写到 stderr 文件、无轮转。
- **证据**：`src/server/status.ts:25-106` 的 `statusPayload`；`src/server/page.ts` 系统抽屉;`/api/*` 无 jobs/backups/metrics 端点。
- **建议**：
  1. `job_runs`（同上）+ `/api/jobs`；
  2. `/api/status` 增加 `backups: {latest_at, count, latest_size}`、`outbox: {fallback, failed, oldest_queued_at}`、`channels: {webhook: ok/failing, log: ok}`；
  3. 状态页新增「运行状态」卡片（job 最近运行、备份、投递异常）；
  4. 可选 `/metrics`（Prometheus 文本格式，零依赖），给以后接 Grafana/Uptime Kuma 留口；
  5. 日志按大小轮转（或提供 `LOG_FILE` + 内置轮转），避免 launchd 的 stderr 无限增长。
- **成本**：小–中。**收益**：出问题时 30 秒定位，而不是 ssh 翻日志。

#### P0-3 备份只有"生成"，没有"恢复闭环"

- **现状**：内置 `VACUUM INTO` 每日 03:00 备份并保留 14 份（工作正常），但：恢复要手工 4 步（README）、没有 `db:restore` 命令、**从未校验过备份文件可打开**、状态页不显示备份、备份与主库同盘、没有 offsite 提示。
- **证据**：`src/core/backup.ts` 仅 `runBackup`/`prune`；`src/doctor.ts:143-167` 只检查"有没有备份、新不新"，不做 `quick_check`。
- **建议**：
  1. `npm run db:restore -- --from <file> [--yes]`：校验源文件 `PRAGMA quick_check` → 检测 daemon 是否在跑（`/healthz`）并拒绝 → 保留 broken 副本 → 恢复主库并清理 WAL/SHM → 打印重启步骤；
  2. `db:backup --verify`（对产物做 `quick_check`）与 `db:backups:list`；
  3. 状态页「备份」卡片（最近时间/大小/份数，异常标红）；
  4. README 增加 offsite 示例（rsync/NAS/对象存储）与"备份不可恢复=没有备份"的强调。
- **成本**：小（1–2 天）。**收益**：把"有备份"变成"敢恢复"。

#### P0-4 单 token + 信任 `X-Hermes-Profile` 的身份模型

- **现状**：`/mcp` 与 `/api/*` 共用一个 `WEB_API_TOKEN`；Profile 完全由请求头 `X-Hermes-Profile` 决定（initialize 时绑定到会话）。任何持有 token 的调用方都能以任意 Profile 身份读写；状态页/`/api/schedules`、`/api/deliveries` 跨 Profile 展示日程标题/备注与部分通知标题。
- **证据**：`src/daemon.ts:174-196`（header → profileId）、`src/core/auth.ts`（单 token）、`src/server/details.ts` 的 `scheduleDetails`/`deliveryDetails` 无 Profile 过滤；README #12。
- **影响**：当前"本机、单人、回环、无 token"场景风险有限；但既然已有双 Profile 与"个人账本仅归属人可见"的承诺，一旦把状态页/`/mcp` 暴露给第二个人或反代出去，隔离就名存实亡。
- **建议**：
  1. 新增 `PROFILE_TOKENS_JSON`（`{"default":"...","bestie":"..."}`），`/mcp` 用 token 反查 Profile，并与 `X-Hermes-Profile` 比对，不一致直接 403；未配置时保持单 token 兼容；
  2. 保留 `WEB_API_TOKEN` 作为"看板/管理员"凭证，状态页按 token 决定可见范围（家庭范围或全部）；
  3. 个人日程/个人通知在 `/api/*` 默认脱敏（或仅对归属 token 可见）；
  4. token 轮换流程（双 token 并存过渡）+ `doctor` 检查 token 强度与 `.env` 权限。
- **成本**：中。**收益**：把"隐私分区"从工具层承诺升级为传输层事实，也为将来多用户/对外暴露铺路。

#### P0-5 设置 JSON 损坏会打断整轮投递（静态可证，建议防御）

- **现状**：`getSetting` 直接 `JSON.parse`，损坏时抛错（`src/core/settings.ts:19-25`）。`skipReason` 在 drain 主循环里读 `quiet_hours`/`push_route`（`src/core/notify.ts:493` 附近），一旦某个 Profile 的 settings 行损坏（手工改库、磁盘损坏、降级回滚写坏），**整轮 drain 抛异常**，所有 Profile 的待投递行都停住，日志每 20 秒一条 error。
- **证据**：`getSetting` 无 try/catch；`push_route`/`quiet_hours` 调用点均未包裹（`location` 同样；`travel_plan` 有专门 catch，属于已修过的同类问题）。
- **建议**：`getSetting` 捕获解析异常 → 返回 `undefined` + `logger.warn` 一次（或抛带 key 的领域错误）；drain 层按行隔离错误（单行 skip，不中断整轮）；`doctor` 增加"settings JSON 可解析性"检查；补回归测试。
- **成本**：小。**收益**：消除一类"一条脏数据瘫痪全部推送"的故障模式。

#### P0-6 当前部署是"零鉴权 + 无网络边界校验"（本机实测）

- **事实**：`.env` 未设置 `WEB_API_TOKEN`，`GET /api/status` 与 `POST /mcp` initialize **实测均返回 200 且无需凭据**；`/` 与 `/healthz` 本就公开。daemon 只绑 127.0.0.1，但**没有 Host/Origin 校验**。
- **风险**：
  1. 本机任意进程（包括浏览器扩展、其他用户会话）可读写全部数据；
  2. DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1 后，浏览器会把它当作同源去请求 `http://evil.com:3080/api/status`，没有 Host 校验就返回真实数据（同源策略被绕过）；
  3. 若通过反向代理暴露，`WEB_API_TOKEN` 未配置时同样裸奔（config 只在非回环时强制要求 token）。
- **证据**：`src/core/auth.ts:34`（`expected === undefined` 即放行）、`src/config.ts:237-240`（仅非回环强制 token）、`src/server/status.ts:108-129`（Hono 无 Host/Origin 检查）、`src/daemon.ts:129-150`。
- **建议**：
  1. 增加 `REQUIRE_AUTH=1`（或默认在回环也要求 token 的严格模式），`doctor` 对"回环无 token"从 ok 降为 warn；
  2. 所有 HTTP 入口校验 `Host`（仅允许配置的 host/端口名单）与 `Origin`（`/api/*` 的写请求、`/mcp` 的浏览器来源），非白名单直接 403；
  3. 文件权限：`umask(0o077)`，DB/备份 0600、data 目录 0700（当前实测 DB 与备份均 0644、data 0755，`~/Library/Logs` 下日志同用户可读）；
  4. 文档写明"回环 ≠ 安全"，暴露前至少三件：token、Host/Origin、反代 TLS。
- **成本**：小（1–2 天，含测试）。**收益**：把"默认安全"从依赖用户自觉变成机制保证。

#### P0-7 单实例无互斥 + 迁移不可回滚

- **单实例**：目前唯一互斥是端口（`src/daemon.ts:301-307`）。换个 `PORT` 就能让第二个进程打开同一个库，双 cron 双调度、重复提醒；更糟的是 `recoverStaleSending`（`src/core/notify.ts:291-302`）会把另一个进程正在 `sending` 的行复位重投。
- **迁移**：DDL/ALTER 逐条自动提交（`src/core/database.ts:243-289`），无迁移前备份、无事务包裹、无结构指纹；`ensureLedgerNameIndex` 失败只 warn（`:207-218`），于是"账本名分范围唯一"可能静默失效。
- **建议**：
  1. `$DATA_DIR/daemon.lock`（PID + 启动时间，stale 检测），daemon 启动时抢占，失败拒绝启动并明确提示；`doctor` 显示锁状态；
  2. 迁移前自动 `VACUUM INTO` 一份 `pre-migrate-<version>.db`；迁移步骤包在事务里（SQLite DDL 可事务）；关键索引创建失败改为"拒绝启动 + 明确报错"，而不是 warn；
  3. `meta.schema_version` 之外记录结构指纹（表/索引定义哈希），`doctor` 对比程序期望值；
  4. 停机 30s 硬超时改为退出码 1 并写日志（现在 `exit(0)` 会让 launchd/systemd 认为正常，`src/daemon.ts:424`）。
- **成本**：中（2–4 天）。**收益**：敢升级、敢重启、敢并行开发。

### P1：体验与扩展的关键缺口

#### P1-1 通知通道只有 webhook/log（#17）

- 现状完全依赖 Hermes 网关回环 webhook；网关重启/升级期间通知进 fallback，`log` 通道不是端到端送达。
- 建议新增通道：**Bark**（iOS 推送，URL 即凭据）、**ntfy**（自建/公共）、**Telegram Bot**、**SMTP 邮件**；通道接口已抽象（`src/core/channels.ts`），新增实现+注册即可，outbox 重试/幂等直接复用。
- 需要顺带解决：通道专属参数（token/chat_id/收件人）、非回环 URL 的安全策略（出站 SSRF 白名单）、按通道渲染格式（Bark/ntfy 用纯文本，webhook 保留 Markdown 表格）。
- 成本：中（每通道约 0.5–1 天 + 测试）。收益：推送可靠性不再绑定单一网关。

#### P1-2 通知偏好与聚合（直接命中 172 条回执噪声）

- 现状：无法按 kind 开关；家庭账本每笔支出向所有有路由的 Profile 各发一条回执（真实数据 86×2=172 条），天气简报/预警/假期/月报同样逐 Profile 重复。
- 建议：
  1. `settings.notify_prefs = { kinds: { "bookkeeping.entry": "digest" | "off" | "instant" }, digest_at: "21:00" }`；
  2. 在 `publishProfile` 层做"记录但不投递/聚合"的分流（聚合任务复用 outbox，每日/每周产出汇总通知）；
  3. 家庭级内容（简报/预警/假期/月报/回执）增加 `scope: household`，可选择"每 Profile 各发"或"只发主路由/只发一次"；
  4. `notify` 工具增加 `view:"prefs"`。
- 成本：中（1 周内）。收益：通知量可降 40%–60%，重要的（预警、截止）更突出。

#### P1-3 每日闭环内容偏薄

- 早报只有天气/空气/假期/预警，**没有今日日程**；没有晚报；没有周报。用户每天打开对话问"今天有什么"，说明早报没解决这个问题。
- 建议（全部确定性、复用现有数据）：
  - 早报加行：`今日日程`（前 3 条 + 总条数）、`待办逾期`（有则红字）、`预算余量`（设了预算才显示）；
  - 21:00 晚报：明日天气/预警、明日日程、带伞/温差/限行（若有数据）提示；
  - 周日 20:00 周报：本周支出/分类 Top3/与上周对比、下周日程、下个假期倒计时、未完成待办；
  - 系统异常行：备份超过 7 天、fallback > 0 时在早报追加一行（只在不健康时出现）。
- 架构注意：`runDailyBrief` 现在在 weather 模块里，直接 import schedule/bookkeeping 会造成模块→模块耦合（目前只禁止 core→module）。建议加一个**只读"简报贡献点"注册表**（如 `registerBriefSection(fn)`，各模块在 `onStart` 注册，weather 只负责组装与发送），这样后续周报/月报/系统健康行都能复用，而不是互相 import。
- 成本：中（每个 0.5–1 天 + 测试）。收益：这是"助理感"提升最快的一处。

#### P1-4 提醒没有 snooze/skip

- 现状：`complete` 可完成待办（可带 `occurrence_key` 收敛单次），`update` 改整个日程；**没有"稍后 10 分钟"、"跳过这次"、"这次改到 15:00"**。生日/纪念日提醒无法完成/延后，只能删除或改全局时间。
- 建议：`schedule {action:"snooze", occurrence_key, minutes}`（生成一条一次性 occurrence 或直接改该条 due_at）；`action:"skip"`（取消本次 occurrence，不影响循环）；`action:"reschedule_once"`。数据模型已有 `occurrences` 主键与 `cancelOccurrence` 基础设施。
- 成本：中。收益：日常使用频率最高的交互补全。

#### P1-5 记账的可视化与"周期账"

- 现状：状态页有本月总额/分类/按天/账本，但没有**预算对照**、没有多月趋势、没有年度；预算 0 使用；无周期账（订阅/房租/水电）、无收入/转账/分摊、无 CSV 导入。
- 建议：
  1. 状态页加预算区块（总额+分类进度条），`/api/expenses?year=` 与多月趋势；
  2. `ledger budget` 返回"基于近 3 个月均值的建议预算"，月报附一行建议（确定性）；
  3. 新增 `subscriptions`（名称/金额/周期/下次扣款/账本/分类），每日 job 提前 3 天推送"该续费了"，agent 确认后落一笔支出；
  4. `expense import`（CSV，去重键=日期+金额+备注哈希）与任意区间导出；
  5. 远期再做收入/转账/分摊（会动数据模型，属于账本 v3）。
- 成本：预算/趋势小；周期账中；收入/分摊大。收益：把"记账"从流水升级为家庭财务视图。

#### P1-6 日历互操作缺失（ICS）

- 现状：日程只能通过对话/状态页看，无法进入手机自带日历；也读不到外部日历。这是"助理"与"日常工具"之间最大的一道墙。
- 建议：`/api/calendar.ics?token=...&profile=...` 输出 VEVENT；公历循环用 RRULE，农历/工作日过滤用有限期 RDATE（如未来 2 年）；提供一次性下载与订阅地址两种形态；写操作仍走 MCP。
- 成本：中（农历/skip 展开是主要工作量）。收益：极高——日历 App 负责"看"，本系统负责"提醒"。

#### P1-7 没有写 API / 快捷入口

- 现状：所有写入只能通过 MCP（stdio 壳或 HTTP 直连），iOS 快捷指令/浏览器书签/其他脚本无法"记一笔""加个提醒"。
- 建议：`POST /api/expenses`、`POST /api/schedules`、`POST /api/notify/quiet_hours`，Bearer + `Idempotency-Key`，复用模块 service 的校验；返回与 MCP 同形状的 JSON。配套写一份 Shortcuts/curl 示例。
- 成本：中（复用 service，主要成本在鉴权与幂等）。收益：把"随手记"从"打开对话"降到"点一下"。

#### P1-8 部署与版本指纹

- 现状：README 只写 systemd；本机实际用 launchd（`ai.life-assistant.daemon` + `node-run.sh`，备份 plist 已迁到内置 job），仓库内没有部署模板；`VERSION` 来自 package.json，12 个 commit 一直是 2.0.0，`/healthz` 只有 version + uptime，无 git SHA/build time。
- 本次实测：`dist/*.js` 构建于 2026-10-18 10:57:48，晚于最后源码修改（10:42）与 HEAD（10:48）；把源码重新 `tsc --outDir /tmp` 后与 `dist/` 逐文件 diff **0 差异**，当前 daemon（10:58 启动）跑的就是 HEAD。**但机制缺失是真的**：一个 stdio shim（PID 1315）启动于 10-17 12:37，早于该次重建且至今未重启，跑的是旧代码；`/healthz` 无法分辨，也没有 shim→daemon 的版本握手。
- 建议：
  1. 仓库内提供 `deploy/systemd/*.service|timer`、`deploy/launchd/*.plist`、`Dockerfile` + `docker-compose.yml`（数据卷、TZ、健康检查）；
  2. 构建时写入 `BUILD_ID`（git short sha + 时间），`/healthz`、启动日志、状态页、`doctor --live` 都展示；
  3. `doctor --live`：探测 `/healthz`、比对版本/构建、检查 `/api/status` 鉴权、校验最新备份 `quick_check`、检查磁盘余量与 `.env` 权限。
- 成本：小–中。收益：升级/回滚不再靠猜。

#### P1-9 QWeather 配额利用偏粗

- 现状：预警巡检每 20 分钟、预警缓存 TTL 10 分钟 → 每个上游日约 72 次预警请求（真实用量 77–84/日），占总量的大头；2 个 Profile 同城已由缓存共享（同 tick 只发一次），但跨 tick 仍会重复。
- 建议：把 `CACHE_TTL_MS.alerts` 改为 `max(10min, 巡检间隔)`（或巡检默认 30 分钟）；`ALERT_WATCH_CRON` 可配；状态页已有用量，可再加"按 kind 的请求分布"便于判断。本机已配置完整 JWT（四项齐全，优先于 API KEY），2027 限额不构成阻塞；可在 2027 前把 `.env` 里的 `QWEATHER_KEY` 清掉，减少泄露面。
- 成本：小。收益：用量减半，给小时级/生活指数等新数据留配额。

#### P1-10 节假日「下一年未发布」被记为 failed

- 现状：`requiredYears()` 自 10 月起要求下一年；2027 数据尚未发布 → `validateYearPayload` 返回 `days 为空` → 记为 failed，每天 02:00 一条 warn，状态页 `holidays.failed` 常驻一条"失败"。本机日志里 9 条 warn 全部是它。
- 建议：区分 `pending`（尚未发布/空数据，不告警、状态页显示"预计 11 月发布"）与 `failed`（结构非法/网络失败）；或对"下一年"失败只在首次记录、之后降为 debug。
- 成本：小。收益：让告警重新变得可信。

#### P1-11 假/脏数据防御与可移植性

- 现状：只有 `import:v1`（单向），没有 v2 数据导出；`settings` 解析无防御（见 P0-5）；`/api/*` 无请求体大小/速率限制；日志无工具调用审计。
- 建议：`npm run export -- --out backup.json`（全表 JSON）+ 对应 `import`；`getSetting` 防御；MCP/HTTP 请求体上限、简单速率限制（如每 Profile 每分钟 N 次写）；debug 级审计日志（profile/tool/耗时/结果，不记录参数原文）。
- Profile 生命周期：`initialize` 会自动 `ensureProfile`（`src/daemon.ts:62`），但没有 list/rename/delete/export 工具；调用方把 `X-Hermes-Profile` 拼错一次就会永久多一个 Profile，并进入每日简报/20 分钟预警巡检（静默消耗 QWeather 配额）。建议 Profile 白名单（未在 `PROFILE_TOKENS_JSON`/配置里注册的 ID 拒绝），或提供 `profile {action:"list|delete|export"}`，删除前校验其日程/个人账本归属。
- 成本：小–中。收益：数据可带走、故障可定位、配额不被幽灵 Profile 消耗。

#### P1-12 正确性缺陷清单（已复现 / 代码可证）

| # | 缺陷 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| a | **补班提醒推两遍** | 早报 notes 含 `⚠️ 今天要补班（X调休）`（`src/modules/weather/index.ts:387-389`），`holiday.workday` 用**同名标题**再推一条（`src/modules/holiday/index.ts:47-55`）；两 job 默认同为 `0 7 * * *`。真实库 2026-09-19、2026-10-09 两天、两个 Profile 均同时存在含该文案的早报与独立补班通知 | 用户同日收到两条同义推送；属"通知本该可信"的直接反例 | 二选一：从早报 notes 移除补班/放假行，或让 `holiday.workday` 遇到已有同 dedupe 的早报时跳过；错开 cron 也可但会留下语义重叠 |
| b | **补记历史支出会推"过去的"预算提醒** | `ym = entry.spent_on.slice(0,7)`（`src/modules/bookkeeping/service.ts:633`），标题/正文均不含月份（`:608-617`、`:670`） | 补记上月/去年同月支出跨阈值时，收到"预算超支·账本"却不知道是哪个月；每个历史月可各推一次 | 标题/正文带上 `YYYY-MM`；对 `spent_on` 早于当月的补记不推实时提醒（或在月报/次日汇总里体现） |
| c | **写路径无幂等键** | `expense add`（`src/modules/bookkeeping/index.ts:226-275`）、`schedule add`（`src/modules/schedule/index.ts:197-223`）均无 client token，表上无唯一约束；回执 dedupe 用新生成的 `entry:<id>`，对重试无效 | MCP 超时/网络抖动后 agent 重试 → 重复账目/重复日程 + 重复回执 | `expenses`/`schedules` 加 `client_token` 列 + 部分唯一索引；工具参数加可选 `request_id`；重试返回原记录 |
| d | **明细与汇总口径不一致** | `expense list` 只回前 N（≤200）且无 offset/cursor（`src/modules/bookkeeping/index.ts:284-303`），`summary` 是全量（`service.ts:315-364`） | 单月 >200 笔时 agent 报的笔数/合计与明细对不上；`还有更多` 无法继续取 | list 加 `offset`/`cursor`，或返回 `next_cursor`；在 SKILL 明确"合计以 summary 为准" |
| e | **CSV 公式注入 + 工具内联大 CSV** | `csvField` 只处理引号/逗号/换行（`service.ts:397-399`）；MCP `export` 把最多 2000 行整个塞进 JSON（`index.ts:420-439`） | 备注写成 `=HYPERLINK(...)` 后导出用 Excel 打开会执行公式；大月单次响应可达数百 KB–MB，挤占上下文 | 对以 `= + - @` 开头的单元格加前导 `'`；MCP 导出改为"返回文件路径/摘要 + 让用户走 HTTP 下载"，或降低上限 |
| f | **`workday_filter=holiday` 实为"休息日"** | 判定 `isOff = cls === 'holiday' \|\| cls === 'weekend'`（`service.ts:528-537`），而工具描述写"仅节假日"（`schedule/index.ts:317-320`） | 用户以为"只在法定节假日触发"，实际每个周末也触发 | 改名为 `offday` 或把描述/README 改成"仅休息日（含周末）"，二选一 |
| g | **循环待办默认"完成"会终止整个循环** | `complete` 不带 `occurrence_key` 时把该日程所有 pending 置 done，且 `kind=todo` 时把 schedule 置 done（`service.ts:711-760`） | "只完成今天这次"与"取消整个每日提醒"只差一个参数，极易误操作 | 默认只完成本次（取最近一条 occurrence）；"终止整个循环"改为显式 `end`/`update status`；SKILL 写明差异 |
| h | **过期日程不自动收口** | `until` 已过的日程仍 `active`；一次性待办过期仍留在列表（真实库有 2 例） | "僵尸日程"污染列表与看板，用户不再信任"活跃"数字 | list/upcoming 派生"已结束/逾期 N 天"状态；一次性待办过期 N 天后自动 `done`（可配） |
| i | **提醒偏移改序可能少一次提醒**（待验证） | `occurrence_key` 的 `#N` 是偏移**下标**而非值（`service.ts:548-557`）；`update` 只删 pending 普通行。若某事件 `#0` 已 notified、`#1` pending，把 offsets 从 `[-30,0]` 改成 `[0,30]`，新语义的 `#0` 会被 `INSERT OR IGNORE` 吞掉 | 该次事件少一次提醒（仅影响"已部分触发的偏移被改序"这一窗口） | 用偏移值编码 key（或改 key 为 `#<offset>`）；至少补一条回归用例钉住当前行为 |

#### P1-13 通知可自查能力缺失

- **现状**：没有 `notify.test`（端到端测试一条推送）、没有通知历史/重读、没有按 kind 过滤、没有手动重投失败投递。README 让用户"用一条临时日程做端到端验证"，正说明缺 test-send。
- **建议**：`notify {action:"test"}`（走真实路由发一条测试通知，不落业务表或标 `kind=test`）；`notify {action:"history", limit, kind}` 只读回看（含已读）；`notify {action:"retry", delivery_id}` 重投 fallback（复用 `generation` 防重复）；`notify {action:"delivery", id}` 查投递状态。
- **成本**：小。**收益**：把"收不到推送"的排障从 ssh 翻库变成一次工具调用。

#### P1-14 长期运行的数据治理

| 项 | 现状/证据 | 建议 |
|---|---|---|
| WAL 高水位 | 实测 WAL 4.12 MB（约 1005 页），长期维持在高位；只有 `journal_mode=WAL` 与 `busy_timeout` 两条 PRAGMA | 每日 04:00 后 `PRAGMA wal_checkpoint(TRUNCATE)` + `journal_size_limit`；`/healthz` 暴露 WAL 大小 |
| `deliveries.notification_id` 无索引 | `sqlite_master` 实测只有 `idx_deliveries_due`；保留策略的级联删除、看板 JOIN 会全表扫，数据量大后是 O(n²) | 在幂等迁移里加 `CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON deliveries(notification_id)`（同 `ensureLedgerNameIndex` 的既有做法，不必升版本号） |
| retention 无批处理/事务 | 单条 DELETE 一次性清理（`src/core/retention.ts:114-140`），长事务会触发 5s `busy_timeout` | 分批（如每批 500 行）+ 每批一个事务；`db:cleanup:preview` 增加耗时估计 |
| 未读通知永不回收 | 只删 `read=1`；只推不 pull 的 Profile 若投递失败，未读会单调增长 | 给未读加"最长保留 365 天"（可配）或把长期失败的通知标为过期 |
| 非规范备份文件永不清理 | `prune` 只认 `life-assistant-YYYYMMDD-HHmmss.db`；实测目录里的 `*-pre-v3.db`、`zombie-*.db` 不会被清理 | 明确"手工快照不自动删"的语义并写进 README，或在 `db:backups:list` 中单列 |
| 月报补发按全局 dedupe 判重 | `monthlyReportPublished` 用 `report:<ledger>:<ym>` 判断（`service.ts:786-792`）；当月新加路由的 Profile 收不到该月账单；补发窗口 6 个月，1 号停机要等下月 1 号 | 判重键加 Profile 维度（或补发时按"当前有路由的 Profile"重新物化缺失行）；把补发 job 从"仅 1 号"改为每日检查一次 |
| occurrence 缺审计字段 | 只有 status，没有 `notified_at`/`attempts`/`last_error` | 加 `notified_at`（可空）与失败原因，便于回答"这条提醒到底发没发" |

#### P1-15 可观测性与日志细节

- **`/healthz` 只回答"进程/连接还在"**：建议拆 `/livez`（进程存活）与 `/readyz`（调度心跳、outbox 最老待投年龄、最近备份时间、schema 版本、build id、WAL 大小）；`/api/status` 复用同一组数据；如需接外部监控，再加零依赖的 `/metrics`（Prometheus 文本：outbox 各状态、job 最近成功时间、备份年龄、QWeather 当日用量、WAL 字节数）。
- **日志**：当前 UTC 文本（备份 03:00 记成前一日 19:00Z），对人不友好；launchd 下 stderr 文件无轮转；无 `request_id`/`job_id`，一次 MCP 调用跨多条日志无法关联。建议：本地时区 + 可选 JSON 行 + 请求/任务 ID + 轮转（或交给 newsyslog/journald）。
- **job 与 tick 可并发**：`runExclusive` 只按 name 互斥（`src/daemon.ts:260-277`），`job:xxx` 与 `tick` 可同时跑；tick 尾部还会通过 `ensureYears` 发网络请求（每年最多 8s），网络慢时每分钟的日程提醒整体延迟。建议 tick 内不做网络 I/O（把 ensureYears 放回 job/队列），或给"库写"加更粗的资源锁。
- **`handleMcp` 错误兜底有二次 end 风险**：catch 里无论 `headersSent` 都 `res.end(JSON)`（`src/daemon.ts:218-228`）；SSE 已开始/客户端断开后会写坏流，catch 内再抛可能成为 unhandled rejection。加 `if (res.writableEnded) return;` 即可。
- **stdio 壳与 daemon 配置耦合**：`src/stdio.ts:10` 顶层 `loadConfig`，QWeather/JWT/备份 cron 的配置错误会让纯转发壳直接退出；建议 shim 只校验 `DATA_DIR`/`MCP_DAEMON_URL`/token，其余惰性。另加 shim↔daemon 版本握手与空闲退出（实测有 3 个 shim 进程常驻，其中一个已跑旧代码 3 天）。
- **配置单一来源**：`config.ts`/README/.env.example 三处手工同步；建议用 zod schema 作为唯一来源，生成文档表格与 `.env.example`，CI 校验漂移（与 `docs-consistency` 同思路）。

### P2：长期结构性改进

| 项 | 现状 | 建议 |
|---|---|---|
| `server` 直接 import 模块内部（README #9） | `details.ts` 引 bookkeeping/schedule 纯函数，改签名会静默坏看板 | 给模块加"读模型"契约（`module.readModels` 注册到 registry），或至少补 `/api/*` 响应形状契约测试 |
| `schedules.version` 未参与并发控制（#5） | 每次更新 +1 但无人校验 | 加写 API/多入口时启用乐观锁；否则保留现状 |
| `schema_version` 非结构指纹（README 已说明） | 追加式迁移 + 幂等补列 | 迁移逻辑已集中；建议把每一步变成命名迁移函数并补"重复执行幂等"测试 |
| `daemon.ts` 440 行编排 | 启动/会话/停机混在一起，覆盖 72%/46% | 拆为 `http-mcp.ts` / `scheduler.ts` / `lifecycle.ts`，给每块写单测 |
| 模块间只读依赖 | 加早报/周报/共享后，模块→模块 import 会增多 | 建"简报/读模型注册表"，把跨域只读组合收口到 registry，而不是互相 import |
| 状态页内联 789 行 | 无构建步骤是优点；但样式/渲染函数耦合 | 保持零构建，补快照测试与无障碍检查；写操作多了再考虑轻量拆分 |
| 配置三处重复（config/README/.env.example） | docs-consistency 只覆盖脚本清单 | 用 zod 建单一 config schema，生成文档表格与 .env.example；CI 校验漂移 |
| 备份阻塞主线程 | `VACUUM INTO` 同步执行 | 当前 745KB 无感；库到数百 MB 再考虑 worker thread（#18） |
| 通知渲染仅 Markdown 表格 | 微信/企业微信友好 | 通道接口加 `render` 能力，邮件/ntfy 用纯文本或 HTML |
| 无审计日志 | 谁改了账目/日程无法追溯；`/mcp` 工具调用无记录 | `audit_events(actor, action, target, before, after, ts)`，工具统一包裹（不含敏感参数原文） |
| 无 i18n | 工具输出/SKILL/页面全中文 | 需要英文用户时再抽消息目录；当前不做 |
| 依赖与 CI 门禁 | 全 caret、无 Dependabot、无 coverage/audit 门禁、CI 仅 ubuntu | 加 Dependabot/renovate、`npm audit` 与 coverage 门禁、macOS + Node 26 矩阵、`node dist/doctor.js` 冒烟 |

#### 工程卫生与测试建议（低风险、可并行）

- **daemon 生命周期进程级测试**：用 `child_process` + 临时目录 + 端口 0 起真实 daemon，覆盖 SIGTERM/SIGKILL、端口占用、双实例锁、崩溃后 `sending` 复位、30s 硬超时（当前 `daemon-lifecycle.test.ts` 仅 52 行，只覆盖 listen 失败）。
- **property-based test**：recurrence/lunar/date math 的不变量（nextDate 严格单调、同输入幂等、2027–2030 每个农历月日都能落到真实公历日）。
- **outbox fault injection**：channel 抛错/超时/DB busy/进程崩溃下"不丢不重"（用假 channel + 临时库）。
- **覆盖率门禁**：先设 90% 行 / 80% 分支（当前 94.76/86.65，达标），防止后续模块摊薄。
- **`--test-concurrency=1` 稳定性跑**：CI 里加一次单并发，暴露测试间共享状态（现有测试已用临时 env，但值得钉住）。
- **依赖升级评估**：MCP SDK 1.32（修 audit）、hono 4.13.13、`@hono/node-server` 2.1.5 可直接升；`node-cron` 4 / `zod` 4 是 major，单独排期。

---

## 4. 功能建议

> 价值/成本为相对判断：价值 H/M/L，成本 小（≤2 天）/中（3–7 天）/大（>1 周）。
> 「依赖」指是否需要先补平台能力。

### A. 现有能力的"最后一公里"（优先）

| ID | 功能 | 用户故事 | 价值 | 成本 | 依赖 |
|---|---|---|---|---|---|
| A1 | 早报加「今日日程/逾期待办/预算余量」 | 每天 07:00 一眼看到今天要做什么、有没有欠的 | H | 小 | — |
| A2 | 晚报 21:00（明日天气+日程） | 睡前知道明天穿什么、几点要干嘛 | H | 小 | 可复用 A1 的查询 |
| A3 | 周报（周日 20:00） | 一周花了多少、下周有什么、假期还有几天 | H | 小 | — |
| A4 | 提醒 snooze/skip/单次改期 | "10 分钟后再提醒我"、"这次跳过" | H | 中 | 日程 occurrence |
| A5 | 通知偏好 + 聚合 + 家庭级去重 | 别再每笔都推两条；只留重要的 | H | 中 | P1-1/P1-2 |
| A6 | 状态页预算区块 + 多月趋势 | 本月花超了吗？和上月比呢？ | M | 小 | — |
| A7 | 预算建议（近 3 月均值） | 不知道该设多少预算 → 给我一个数 | M | 小 | — |
| A8 | 生日年龄 + 纪念日天数 + 礼物提示 | "今年 30 岁生日 / 在一起 1825 天；上次礼物是…" | M | 小 | 存 `birth_year`/`since` |
| A9 | 系统健康行（仅异常时出现在早报） | 备份停了/推送挂了，我能知道 | M | 小 | P0-2 |
| A10 | 月度/年度支出 CSV/JSON 导出任意区间 | 想用 Excel 做年度分析 | M | 小 | — |
| A11 | 记账周期账（订阅/房租） | 别再忘了续费；扣了自动记一笔 | H | 中 | 新表 + job |
| A12 | ICS 日历订阅 | 日程进手机自带日历 | H | 中 | — |
| A13 | 快捷记一笔（iOS 快捷指令/书签） | 3 秒记一笔，不用打开对话 | H | 中 | 写 API（P1-7） |
| A14 | 状态页快捷操作（记一笔/暂停提醒/静音） | 不开对话也能操作 | M | 中 | 写 API + 权限 |
| A15 | 工作日晚间"明日预告"含限行/穿衣 | 明天怎么出门 | M | 小 | 可选外部数据 |
| A16 | 默认账本 + 最近分类/常用分类 | 记一笔不用先 `ledger list`；分类不再碎片化 | H | 小 | `settings.default_ledger_id` + 分类别名表 |
| A17 | 分类字典/别名合并 | "日用品/日用""餐饮/午餐"合并统计，月报可读 | M | 小–中 | 新表 + 迁移映射（存量 25 分类需人工确认） |
| A18 | 月报"可执行化"（环比/Top3/日均/预算进度/建议预算） | 月报从流水表变成结论 | M | 小 | 复用 `summarizeExpenses` |
| A19 | 通知 test/history/retry/delivery 查询 | 收不到推送时能自助排查 | M | 小 | P1-13 |
| A20 | 早报/月报按 Profile 可配时间 | 伴侣起床时间不同，不必同一时刻打扰 | L–M | 中 | per-profile 设置 + job 调度 |

### B. 新领域能力（结合现有基础设施）

| ID | 功能 | 用户故事 | 价值 | 成本 | 依赖/风险 |
|---|---|---|---|---|---|
| B1 | 家庭共享日程/清单 | 两个人都能看到"周六回娘家""买牛奶" | H | 大 | 需可见性模型（P0-4） |
| B2 | 到期提醒（证件/保险/年检/保修） | 驾照/护照/车险快到期了提醒我 | M | 中 | 通用 `expiring_items` 表 |
| B3 | 习惯打卡/连续天数 | 每天喝水/运动，连续 30 天 | M | 中 | 复用 occurrence + 统计 |
| B4 | 健康/用药提醒（个人可见） | 每天 8 点吃药，漏了升级提醒 | M | 中 | escalation 已有；敏感数据可见性 |
| B5 | 联系人 & 礼物清单 | 生日前 7 天提示 + 礼物预算/历史 | M | 中 | 关联 schedule/expense |
| B6 | 旅行模块（多段行程/清单/旅行账本/时区） | 去上海 3 天：行程、打包清单、旅行花费 | M | 大 | 扩展现有 travel_plan |
| B7 | 快递/物流跟踪 | 包裹到哪了 | M | 中 | 外部 API 稳定性/合规 |
| B8 | 小时级天气 + 生活指数 + 日出日落 | 下午会不会下雨？适合洗车吗？ | M | 中 | QWeather 套餐/配额 |
| B9 | 年假/请假规划（工作日倒计时） | 距春节还有 12 个工作日，请 3 天凑 9 天 | M | 小 | 节假日数据已有 |
| B10 | 家庭财务：收入/转账/分摊/多币种 | AA、报销、我垫了多少 | L–M | 大 | 账本 v3，需谨慎 |
| B11 | 每周"生活回顾"（含习惯/健康） | 这周过得怎么样 | L | 中 | 依赖 B3/B4 |
| B12 | 智能家居/自动化触发 | 到家前开空调 | L | 大 | 外部系统，非核心 |

### C. 长期方向

1. **多租户/多家庭实例**：当前 Profile 是"同一实例内的命名空间"，适合家庭；若想给朋友/多设备用，需要 per-profile token + 可见性 + 配额（先做 P0-4，再谈多租户）。
2. **插件化**：模块契约已就绪，可把"通道/新域/读模型"做成可注册插件（甚至独立 npm 包），但不要做 v1 那种自动化 DSL。
3. **移动端/PWA**：状态页先加 manifest + service worker + 快捷操作；原生 App 只有在"写 API + 推送"稳定后再评估。**硬前提是远程可达**：当前只绑回环，手机/ICS/可操作通知都摸不到 daemon，需要反代/Tailscale/局域网绑定 + per-profile token 三件套一起上。
4. **可操作通知**：通知里带"完成/稍后 1 小时/跳过"按钮（一次性签名 action token + 确认页），价值高但依赖远程可达、防重放、防链接扫描器误触发，放在写 API/ICS 稳定之后。
5. **开放 API/集成**：OpenAPI 3 描述 `/api/*`，提供 curl/Shortcuts 示例；入站 webhook（如银行短信转发、快递通知）可作为新数据源。
6. **AI 增强（服务端保持确定性）**：摘要/解释放在 Hermes 侧；服务端只提供结构化数据与"建议"字段（如预算建议）。如果未来要接 LLM，务必保留"无 LLM 也能工作"的降级路径。

---

## 5. 路线图建议

### Now（1–2 周，可靠性 + 安全基线 + 每日价值）

1. `job_runs` + 启动补发 + 状态页任务卡片 + `doctor --live`（P0-1/P0-2/P1-8）
2. 备份恢复 CLI + 校验 + 状态展示（P0-3）
3. 修补班重复推送（P1-12a）与写路径幂等键（P1-12c）——都是小改动、直接止损
4. 部署安全基线：`REQUIRE_AUTH`/Host/Origin 校验、`umask(0o077)`、`daemon.lock` 单实例锁（P0-6/P0-7）
5. 迁移前自动备份 + 迁移事务化 + 索引失败拒绝启动（P0-7）
6. 早报加今日日程；新增晚报（P1-3 的 A1/A2）
7. snooze/skip + `complete` 语义修正（P1-4/P1-12g）
8. 预警 TTL/巡检间隔对齐（P1-9）；节假日 pending 状态（P1-10）
9. `getSetting` 防御 + 回归测试（P0-5）
10. 默认账本/最近分类（A16）——降低最高频闭环的摩擦
11. `deliveries(notification_id)` 索引 + 每日 WAL checkpoint（P1-14）
12. `npm audit fix` + CI 加 audit（工程卫生）

### Next（3–6 周，触达与家庭）

1. 通知通道 Bark/ntfy/邮件 + 按 kind 偏好/聚合/家庭去重（P1-1/P1-2）
2. 写 API + iOS 快捷指令示例（P1-7）
3. ICS 导出/订阅（P1-6）——前提：解决远程可达（反代/Tailscale）
4. per-profile token + 看板可见性（P0-4）
5. 预算看板/趋势/引导（P1-5 前半）+ 可执行月报（A18）+ 周报（A3）
6. 分类字典/别名（A17）、CSV 注入修复（P1-12e）、明细分页（P1-12d）
7. `notify test/history/retry`（P1-13）、job 指标/`/readyz`/日志轮转（P1-15）、迁移结构指纹与审计日志

### Later（6–12 周，新领域）

1. 周期账/订阅（A11）
2. 家庭共享日程/清单（B1）
3. 到期提醒（B2）与礼物/联系人（B5）
4. 数据导出/导入（P1-11）
5. 小时天气/生活指数（B8）、年假规划（B9）
6. 旅行模块（B6）与健康/习惯（B3/B4）

### 如果只能做三件事

- **平台可靠性**：`job_runs` + 启动补发（P0-1）→ 备份恢复闭环（P0-3）→ 状态页/`/readyz` 可见（P0-2）。目标：**推送不丢、丢了能看见、数据能恢复**。
- **通知治理**：按 kind 偏好 + 回执聚合 + 家庭级去重（P1-2）→ 通道扩展（P1-1）。目标：**从每天 9 条均质推送变成 3 条以内、每条值得看**。
- **每日闭环**：早报补今日日程 + 晚报（A1/A2）→ snooze/skip 与 `complete` 语义（A4/P1-12g）→ 预算引导与默认账本（A7/A16）。目标：**早上知道做什么、晚上知道明天、记一笔不用先查账本**。

安全基线（P0-6/P0-7）不在这三件里，但它是"做手机入口/共享/远程"的前置条件；如果近期不打算暴露服务，可排在它们之后，但**不要**在没做的情况下把服务暴露出去。

### 明确不建议做（保持克制）

- **不要**引入外部数据库/消息队列/多进程：单用户规模 SQLite + 单写者足够，复杂度换不来收益。
- **不要**做 LLM 驱动的定时推送：会破坏确定性、可测试性与"不幻觉"的承诺；LLM 留在 Hermes 对话层。
- **不要**做通用自动化 DSL / 规则引擎（v1 已证明是负担）。
- **不要**做多源天气回退：QWeather 版权与一致性约束下，单源 + 明确报错更诚实。
- **不要**急着重写 React/SPA 仪表盘：零构建状态页是优势，先补写操作/PWA 即可。
- **不要**在没有真实多用户需求前做复杂 RBAC：per-profile token + 家庭/个人两档可见性足够。

---

## 6. 对 README「已知取舍」18 条的独立判断

| # | 条目 | 判断 | 建议 |
|---|---|---|---|
| 1–4 | 天气治理/JWT/v1 端点/报表快照 | 已实施且方向正确 | 保持 |
| 5 | `schedules.version` 无校验 | 同意暂不删列 | 写 API 落地时用作乐观锁 |
| 6 | 节假日刷新节奏 | 现状已自洽 | 可把 cron 做成配置项，配合"未发布"区分 |
| 7 | 状态页无鉴权 | 回环场景可接受 | 对外暴露前必须解决（见 P0-4） |
| 8 | 通知/投递保留策略 | 已实施 | 保持 |
| 9 | server 直接 import 模块 | 可接受但需护栏 | 补读模型契约或响应形状测试 |
| 10 | pull 拦不住在途投递 | 同意 | 保持 |
| 11 | 已取消日程回收 | 已实施 | 保持 |
| 12 | 看板跨 Profile 展示 | **优先级应提高** | 与 P0-4 一起做，至少先文档化风险 |
| 13 | 错过 cron 不补发 | **建议尽快做** | P0-1 |
| 14 | 记账编辑不推送/无历史 | 同意不实时推 | 建议加 `updated_at` + 每晚重算预算并在月报标注"本月曾修改"；避免"改一笔后预算结论不可追溯" |
| 15 | 出行模式单计划/单时区 | 可接受 | 旅行模块（B6）时一起升级 |
| 16 | CSV 只家庭账本/按月 | 可接受 | 增加任意区间与个人导出（A10），并修公式注入（P1-12e） |
| 17 | 通道只有 webhook/log | **列为 P1 首位** | P1-1 |
| 18 | 备份依赖 daemon/无状态页 | **建议尽快做** | P0-2/P0-3 |

补充两条对统计口径的提醒：

- **月报只有 6 条不能说明"没人用"**：系统上线约 2 个月 → 2 个 Profile × 3 期 = 6 条，正好等于设计值。真正的问题是月报不可执行（A18），不是没人看。
- **生产库里有 6 条 `test.probe`/`probe.render`**：说明历史上测试曾写入真实库，会污染通知统计。建议测试统一用临时 `DATA_DIR`（现有 `makeTestEnv` 已支持），并在 `doctor` 里对 `kind LIKE '%probe%'` 给一条提示。

---

## 7. 附录：验证记录与证据

### 7.1 本次实际执行的验证

```bash
export PATH=/Users/cracked/.hermes/tools/node-26.7.0-darwin-arm64/bin:$PATH
npm run typecheck        # 通过
npm run lint             # 通过（73 files）
npm run format:check     # 通过
npm test                 # 531 tests / 111 suites / 0 fail
npm run build            # 通过
node --import tsx/esm --experimental-test-coverage --test "tests/**/*.test.ts"
                         # 行 94.76% / 分支 86.65% / 函数 92.67%
npm audit --omit=dev     # 4 条（1 critical / 1 high / 2 moderate，均为 SDK 传递依赖）
npm outdated             # hono / @hono/node-server / MCP SDK / node-cron / zod 有更新
```

### 7.2 线上只读采样

- `GET /healthz` → `{ok:true, version:"2.0.0", uptime_s:178896}`（连续运行约 49.7h）
- `GET /api/status` → 2 Profiles（default/bestie）、12 active 日程、本月支出、QWeather 当日 47 次
- **匿名访问实测**：未带任何凭据时 `GET /api/status` → 200、`POST /mcp` initialize → 200；`GET /` → 200；当前回环、未配置 `WEB_API_TOKEN`
- **文件权限实测**：`data/` 0755、`data/life-assistant.db` 0644、`data/backups/*.db` 0644；`.env` 0600（合格）
- **索引实测**：`deliveries` 只有 `idx_deliveries_due`，没有 `notification_id` 索引（见 P1-14）
- SQLite 只读查询：39 schedules / 169 occurrences / 123 expenses / 346 notifications / 346 deliveries（345 sent, 1 cancelled）/ 0 budgets
- 通知分类：`bookkeeping.entry` 172（86+86）、`weather.brief` 74（37+37）、`schedule.reminder` 62（53+9）、`weather.alert` 14、`bookkeeping.monthly` 6、holiday 12
- 重复推送实测：2026-09-19、2026-10-09 两个补班日、两个 Profile 同时收到「含今天要补班行的早报」与「独立补班通知」
- 循环待办：`每日巡检`/`打下班卡` 各 67 条 occurrence、0 done；分类共 25 个
- QWeather 用量：10-20 12:39 已 47 次；近 12 日 76–84 次/日
- 备份：`data/backups/life-assistant-20261020-030000.db` 等，内置 job 每日 03:00 产出
- 日志：186 info / 9 warn / 0 error；9 条 warn 全部是「2027 节假日数据 days 为空」
- **构建新鲜度实测**：`dist/*.js` mtime 2026-10-18 10:57:48，晚于最后源码 10:42 与 HEAD 10:48；`tsc --outDir /tmp` 重建后与 dist `diff -rq` 0 差异；daemon（10:58 启动）跑的是 HEAD。但 stdio shim PID 1315 启动于 10-17 12:37，未随重建重启（见 P1-8）。

### 7.3 关键代码位置（便于逐条核对）

- 启动/会话/停机：`src/daemon.ts`
- 模块契约：`src/core/registry.ts`
- outbox 投递：`src/core/notify.ts`、`src/core/channels.ts`
- 调度引擎：`src/core/recurrence.ts`、`src/modules/schedule/service.ts`
- 状态页/API：`src/server/status.ts`、`src/server/details.ts`、`src/server/page.ts`
- 备份/自检/保留：`src/core/backup.ts`、`src/doctor.ts`、`src/core/retention.ts`
- 鉴权/配置：`src/core/auth.ts`、`src/config.ts`、`.env.example`
- 数据库/迁移：`src/core/database.ts`
- 文档契约：`tests/docs-consistency.test.ts`、`tests/registry.test.ts`

---

**结论**：项目已经跨过"能跑"和"可维护"两道坎，工程质量足以支撑长期迭代。接下来的高价值工作可归为两句话：

1. **把"确定性推送"做成可信赖的基础设施**：可观测（任务/备份/投递状态）、可补发（错过 cron）、可恢复（备份校验 + restore）、可防御（坏 JSON/单实例/迁移回滚）、可暴露（token 主体 + Host/Origin + 文件权限）。
2. **把"生活助理"做成每天愿意用的产品**：通知降噪与偏好、早报补今日日程、晚报/周报、提醒 snooze/skip、预算引导与看板、默认账本与快捷写入、日历订阅。

在这两件事完成之前，不建议再开新领域（健康、习惯、快递等）；一旦平台基线补齐，新域的边际成本会很低——模块契约、outbox、recurrence、settings 都是现成的。
