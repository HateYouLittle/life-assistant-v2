# 路线图与进度

> 当前版本 **v2.0.0** · 数据库 **schema v6** · 最后更新 **2026-11-12**
>
> 口径：以已合入 `main` 的实现为准。完成一项就勾选、补 commit 与落点，并更新顶部「最后更新」。
> 详细分析与逐项证据（真实库采样、file:line）见 `~/workspace/tasks/life-assistant-review-2026-10/feature-proposal-2026-10-20.md`
> （已归档的过程报告，不入库、不作执行依据）；本文件是仓库内的进度唯一事实来源。

## 阶段一：可靠性 + 安全基线 + 每日闭环 —— ✅ 已完成（2026-10-20）

提交：`43107d7`（实现）、`d89fe78`（CI 修复）。
验证：`690 tests / 147 suites / 0 fail`；`typecheck / lint / format:check / build` 全绿；
CI 在 Node 22.16.0 / 22 / 24 三档矩阵全绿（`.github/workflows/ci.yml`）。

| # | 事项 | 状态 | 落点 |
|---|---|---|---|
| 1 | `job_runs` 运行记录 + 启动补发 + 状态页任务卡片 + `doctor --live` | ✅ | `src/core/jobs.ts`、`src/daemon.ts`、`src/server/`、`src/doctor.ts`、`GET /api/jobs` |
| 2 | 备份恢复闭环（CLI + 校验 + 状态展示） | ✅（状态页备份卡片未做） | `src/core/backup.ts`、`src/restore.ts`、`npm run db:restore`、`doctor --live` |
| 3 | 修掉补班重复推送 + 写路径幂等键 | ✅ | holiday/weather 单一来源；`expenses.client_token` / `schedules.client_token` + `request_id` |
| 4 | 部署安全基线：`REQUIRE_AUTH` / Host-Origin / `umask(0o077)` / `daemon.lock` | ✅ | `src/core/security.ts`、`src/core/lock.ts`、`src/config.ts` |
| 5 | 迁移前自动备份 + 迁移事务化 + 索引失败拒绝启动 | ✅ | `src/core/database.ts`（schema v4） |
| 6 | 早报补「今日日程/逾期」；新增 21:00 晚报 | ✅ | `src/modules/weather/index.ts`、`EVENING_BRIEF_CRON` |
| 7 | `snooze` / `skip` + `complete` 语义修正 | ✅ | `src/modules/schedule/{index,service}.ts` |
| 8 | 预警 TTL 与巡检间隔对齐 + 节假日次年数据 pending | ✅ | `src/core/qweather.ts`、`src/core/holiday.ts` |
| 9 | `getSetting` / `getCache` 坏 JSON 防御 + 回归测试 | ✅ | `src/core/settings.ts`（`readSetting`） |
| 10 | 默认账本 / 常用分类 | ✅ | `src/modules/bookkeeping/{index,service}.ts` |
| 11 | `deliveries(notification_id)` 索引 + 每日 WAL checkpoint | ✅ | `src/core/database.ts`、`src/modules/maintenance/index.ts` |
| 12 | `npm audit fix` + CI 增加 audit 关卡 | ✅ | `package-lock.json`、`.github/workflows/ci.yml` |

阶段一遗留（已知、不影响使用，细节见 README「已知取舍」#19–#23）：

- 状态页暂无「备份」卡片（`doctor --live` 已覆盖备份新鲜度与命名异常）
- 启动补发只补**最近一次**，且只支持日与月为 `*` 的 cron（分钟/小时/星期支持单值、列表、范围与步长，如 `0 7 * * 1-5` 可补；`0 9 1 * *` 这类按日/月的不补）
- `job_runs` 只保留 30 天、无耗时趋势（`/metrics`、`/readyz`、日志轮转已在阶段二补齐）
- `VACUUM INTO` 仍在主进程事件循环上同步执行（库大时会短暂阻塞 HTTP/MCP）

## 阶段二：触达与家庭 —— ✅ 已完成（2026-10-20）

> 决策（2026-10-20）：服务只跑局域网，公网入口由 **NAS 上的 Lucky 反向代理**（TLS 终止、DDNS、路径控制）；
> daemon 绑 `0.0.0.0` + `WEB_API_TOKEN` + `REQUIRE_AUTH`，Mac 不做公网直连、不装证书。
> 手机端（OPPO/ColorOS）用 **`/quick` PWA**（主路径）+ **HTTP Shortcuts**（一键直达）+ 小布指令/NFC（触发器）。
> 施工清单、Lucky 配置要点与安全门槛见 [docs/remote-access.md](docs/remote-access.md)。

**前置（阻塞手机端与 ICS）**

0. **局域网 + NAS Lucky 反代** ✅：daemon 改绑 `0.0.0.0`、`REQUIRE_AUTH` + `WEB_API_TOKEN`、
   `WEB_ALLOWED_HOSTS` 覆盖 LAN 地址；Lucky 侧只放必要路径（公网不暴露 `/mcp`，SSE 缓冲会卡）——
   施工清单与安全门槛见 [docs/remote-access.md](docs/remote-access.md)。公网转发由用户在 NAS 侧自行完成。

**功能项**

~~1. **通知通道/偏好/聚合/受众** ✅（2026-10-20，`2cc2f5b` + `7161c01`）：Bark + ntfy + Telegram + SMTP + OpenClaw 通道（`openclaw`，2026-10-25，`033acc9` + `20f421c`；支持映射式与 `/hooks/agent` 直连；2026-10-31 增加共享 Gateway 的 `OPENCLAW_PROFILE_TARGETS_JSON` 目标绑定、直连参数校验、409 可重试与 `waitForCompletion` 送达确认）、按 kind 的 `notify_prefs`（默认逐笔回执不推）、家庭账本回执只发记账人、每晚 21:30 记账摘要、`notify prefs|test`。仍待办：按通道渲染格式、聚合窗口（当前只支持「推/不推」）；SMTP 的 TLS 成功路径未自动化（需受信证书）。原计划：Bark / ntfy / SMTP 邮件 + 按 `kind` 偏好、回执聚合、家庭级去重~~（2026-11-04 裁剪，见下）
   （当前 172 条记账回执按 Profile 各发一遍，是最大噪声源）
~~2. **写 API + 手机快捷入口** ✅（2026-10-20，`ecd18b3`）：`POST /api/quick/expenses|schedules`（复用 `request_id` 幂等）+ `GET /api/quick/bootstrap` + `/quick` PWA（记账/提醒、token 引导、预填参数）；HTTP Shortcuts 可直接导入 [docs/http-shortcuts.json](docs/http-shortcuts.json)（说明见 [docs/http-shortcuts.md](docs/http-shortcuts.md)），小布指令/NFC 用法见 [docs/quick-entry.md](docs/quick-entry.md)。~~（2026-11-04 裁剪，见下）
   目标：从打开对话降到点一下 / 两下。
~~3. **ICS 日历订阅** ✅（2026-10-20，`ecd18b3`）：`GET /calendar.ics` 签名 URL（HMAC + 有效期，只读单个 Profile）、`npm run calendar:url` 生成；未做 RFC 5545 的 75 octet 行折叠。~~（2026-11-04 裁剪，见下）
4. **per-profile token + 看板可见性** ✅（2026-10-20，`4bfce42` + `0cfa390`）：`PROFILE_TOKENS_JSON` + `/mcp` 强绑定 + `/api/quick/*` + 看板 `/api/*` 按 Profile 过滤（profile=自己的日程/通知 + 家庭/本人个人账本；master=家庭看板），`/api/status` 返回 `identity` 供页面显示身份。
~~5. **预算看板/趋势/引导 + 可执行月报 + 周日周报** ✅（2026-10-20，`2b8349e`）：状态页预算卡片（`/api/budget`，进度条 + 未设/超支/花速过快/正常四类可执行建议）、周报 job `bookkeeping.weekly_report`（周日 20:00，分类 top5/最大单笔/环比/预算剩余）；月报已有预算对照行。趋势图未做（需要历史曲线再引入）。~~（2026-11-04 裁剪，见下）
6. **分类字典/别名、CSV 公式注入修复、明细分页** ✅（2026-10-20，`88ed2b7`）：`expense categories|category_alias`、`expense add/update` 别名归一（大小写/空白折叠，不改历史）、`expenseCsv` 文本列防公式注入、`expense list` 与 `/api/expenses|deliveries` 支持 `offset` + 看板「加载更多」（OFFSET 游标，翻页期间数据变化可能重复/漏行，数据量大再换 keyset）。
7. **可观测性** ✅（2026-10-20，`ecd18b3` + `589a87d`）：`/metrics` + `/readyz`（鉴权/限流计数器、投递状态、outbox 排队、job 最近成功、备份年龄、DB/WAL、QWeather 用量）；`notify test/history/retry`（历史分页、失败投递手动重试）；日志本地时间戳 + `maintenance.log_rotate`（每日 04:55 copytruncate，`LOG_DIR`/`LOG_MAX_MB`/`LOG_KEEP`）。
8. **迁移结构指纹 + 审计日志** ✅（2026-10-20，`7161c01`，schema v5）：`meta.schema_fingerprint` 启动对账（漂移 warn）+ `npm run db:fingerprint` CLI + doctor 检查；新增 `audit_log` 表与 `/api/audit`（master 全量、Profile 仅自己），`/api/quick/*` 写入后记审计；迁移纯附加式、单事务、升级前自动 `pre-v4` 快照。仍待办：audit 保留策略（目前只增不清）。

## 2026-11-04 使用体验裁剪 —— ✅

> 依据：两人家庭只在 QQ 聊天里用，手机上推送「太多、看着费劲就不看」，循环待办「想闭环但嫌麻烦」，
> 记账「只要能记、偶尔查」。方案见 `~/.claude/plans/dapper-jumping-swing.md`。

| 改动 | 提交 |
|---|---|
| 循环待办过了当天自动作废、当天 20:00 追一次；`complete {recent:true}` 只认当天；删除 `/a/*` 一键链接 | `c381807` |
| 推送改成 1–4 行纯文本（早报/晚报/提醒/预警）；删除周报、月报、每日记账摘要、预算阈值提醒、逐笔回执 | `e042735` |
| 读类记账 action 缺省走默认账本，summary 默认自然月全月；SKILL.md 25KB → 7KB | `a52fe2f` |
| 删除 bark/ntfy/telegram/smtp/openclaw 通道（只留 webhook/log）、`/quick` PWA 与 HTTP Shortcuts、ICS 订阅、v1 导入器；根目录过程报告移到 `tasks/` | 本阶段 |

阶段二第 1/2/3/5 项因此划线；阶段三未开始的条目按需再议，新增前先确认真有人用。

## 2026-11-12 仓库维护 —— ✅

> 文档、仓库卫生与纯风格自动修复，不改运行逻辑；线上服务未重启。

| 改动 | 落点 |
|---|---|
| 修正 `skill/SKILL.md` 里引用已移除功能（`/quick`、`/api/quick/*`、`/calendar.ics`、`/a/<token>`、`PUBLIC_BASE_URL`）的运维段，补「审计暂无写入方」口径，删除冗余 `.bak` 并同步安装副本 | `skill/SKILL.md` |
| 本文件补 schema v6 与周期账进度；`AGENTS.md` 补 `recurring_bills` 存储说明；`README.md` 修正审计段（`/api/quick/*` 已移除） | 三个文档 |
| 清理 `.env` 4 个无代码读取的键（`OPENCLAW_*`、`PUBLIC_BASE_URL`）、移走 `.env.bak-*` 与 `data/_from-oldpath-*`、删除 16 个已全部合并的本地分支 | 本机 |
| 收尾 2 条过期一次性待办（bestie「交话费」「取消酒店订单」，经 `schedule complete` 置 done） | 数据 |
| biome 安全自动修复（浏览器脚本的箭头函数/模板字符串），warning 80→15、0 error、测试全绿 | `src/server/assets/*.js` |
| 2026-11-04 的 4 个提交与本次维护一并推送 `origin/main`（此前 CI 只覆盖到 `d51e42d`） | `origin/main` |

## 阶段三：新领域 —— 🔲 未开始（6–12 周）

1. 周期账 / 订阅提醒 ✅（2026-11-04，`6a7d9a2`，schema v6）：`bill` 工具（`add`/`list`/`update`/`pause`/`resume`/`pay`）+ `recurring_bills` 模板；到期复用 schedule 物化与提醒链路（按日号锚定，31 日模板在小月取当月最后一天），`bill pay` 一步完成提醒并入账、同一期幂等。截至 2026-11-12 库内尚无模板数据，功能可用但未被使用。
2. 家庭共享日程 / 清单（需先完成阶段二的身份与可见性）
3. 到期提醒（证件/保险/年检）、礼物与联系人
4. 数据导出 / 导入（换机迁移）
5. 小时天气 / 生活指数、年假规划
6. 旅行模块、健康 / 习惯

## 明确不做（保持克制）

外部数据库 / 消息队列 / 多进程；LLM 驱动的定时推送；通用自动化 DSL / 规则引擎；
多源天气回退；React/SPA 仪表盘重写；无真实多用户需求前的复杂 RBAC。

## 维护约定

- 完成一项：勾选 + 写 commit + 更新顶部「最后更新」；部分完成在状态列写清缺口。
- 新需求先记入本文件再进代码；裁剪或延期用划线保留，不直接删除（保留决策记录）。
- 安全与数据相关项（备份、迁移、鉴权、文件权限）不因进度压力跳过。
