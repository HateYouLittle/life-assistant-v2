# 路线图与进度

> 当前版本 **v2.0.0** · 数据库 **schema v4** · 最后更新 **2026-10-20**
>
> 口径：以已合入 `main` 的实现为准。完成一项就勾选、补 commit 与落点，并更新顶部「最后更新」。
> 详细分析与逐项证据（真实库采样、file:line）见本地报告 `feature-proposal-2026-10-20.md`——
> 该报告是设计依据，按约定不入库；本文件是仓库内的进度唯一事实来源。

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
- 启动补发只补**最近一次**，且只支持日/月/星期为 `*` 的 cron（如 `0 7 * * 1-5` 不补）
- `job_runs` 只保留 30 天、无耗时趋势；`/metrics`、`/readyz`、日志轮转未做
- `VACUUM INTO` 仍在主进程事件循环上同步执行（库大时会短暂阻塞 HTTP/MCP）

## 阶段二：触达与家庭 —— 🔲 未开始（3–6 周）

> 决策（2026-10-20）：服务只跑局域网，公网入口由 **NAS 上的 Lucky 反向代理**（TLS 终止、DDNS、路径控制）；
> daemon 绑 `0.0.0.0` + `WEB_API_TOKEN` + `REQUIRE_AUTH`，Mac 不做公网直连、不装证书。
> 手机端（OPPO/ColorOS）用 **`/quick` PWA**（主路径）+ **HTTP Shortcuts**（一键直达）+ 小布指令/NFC（触发器）。
> 施工清单、Lucky 配置要点与安全门槛见 [docs/remote-access.md](docs/remote-access.md)。

**前置（阻塞手机端与 ICS）**

0. **局域网 + NAS Lucky 反代**：Mac 固定 LAN IP、daemon 改绑 `0.0.0.0`、`WEB_ALLOWED_HOSTS` 覆盖
   Lucky 前端域名与 LAN 地址；Lucky 侧只放必要路径（公网不暴露 `/mcp`，SSE 缓冲会卡）。
   **暴露前必须先完成 per-profile token 与写 API 限流**。

**功能项**

1. **通知通道/偏好/聚合/受众** ✅（2026-10-20）：Bark + ntfy + Telegram + SMTP 通道、按 kind 的 `notify_prefs`（默认逐笔回执不推）、家庭账本回执只发记账人、每晚 21:30 记账摘要、`notify prefs|test`。仍待办：按通道渲染格式、聚合窗口（当前只支持「推/不推」）；SMTP 的 TLS 成功路径未自动化（需受信证书）。原计划：Bark / ntfy / SMTP 邮件 + 按 `kind` 偏好、回执聚合、家庭级去重
   （当前 172 条记账回执按 Profile 各发一遍，是最大噪声源）
2. **写 API + 手机快捷入口** ✅（2026-10-20）：`POST /api/quick/expenses|schedules`（复用 `request_id` 幂等）+ `GET /api/quick/bootstrap` + `/quick` PWA（记账/提醒、token 引导、预填参数）；HTTP Shortcuts/小布指令/NFC 用法见 [docs/quick-entry.md](docs/quick-entry.md)。仍待办：HTTP Shortcuts 的导出 JSON 文件（文档目前给的是 cURL 导入）。
   目标：从打开对话降到点一下 / 两下。
3. **ICS 日历订阅** ✅（2026-10-20）：`GET /calendar.ics` 签名 URL（HMAC + 有效期，只读单个 Profile）、`npm run calendar:url` 生成；未做 RFC 5545 的 75 octet 行折叠。
4. **per-profile token + 看板可见性** ✅（2026-10-20）：`PROFILE_TOKENS_JSON` + `/mcp` 强绑定 + `/api/quick/*` + 看板 `/api/*` 按 Profile 过滤（profile=自己的日程/通知 + 家庭/本人个人账本；master=家庭看板），`/api/status` 返回 `identity` 供页面显示身份。
5. **预算看板/趋势/引导 + 可执行月报 + 周日周报** ✅（2026-10-20）：状态页预算卡片（`/api/budget`，进度条 + 未设/超支/花速过快/正常四类可执行建议）、周报 job `bookkeeping.weekly_report`（周日 20:00，分类 top5/最大单笔/环比/预算剩余）；月报已有预算对照行。趋势图未做（需要历史曲线再引入）。
6. **分类字典/别名、CSV 公式注入修复、明细分页** ✅（2026-10-20）：`expense categories|category_alias`、`expense add/update` 别名归一（大小写/空白折叠，不改历史）、`expenseCsv` 文本列防公式注入、`expense list` 与 `/api/expenses|deliveries` 支持 `offset` + 看板「加载更多」（OFFSET 游标，翻页期间数据变化可能重复/漏行，数据量大再换 keyset）。
7. **可观测性** ✅（2026-10-20）：`/metrics` + `/readyz`（鉴权/限流计数器、投递状态、outbox 排队、job 最近成功、备份年龄、DB/WAL、QWeather 用量）；`notify test/history/retry`（历史分页、失败投递手动重试）；日志本地时间戳 + `maintenance.log_rotate`（每日 04:50 copytruncate，`LOG_DIR`/`LOG_MAX_MB`/`LOG_KEEP`）。
8. **迁移结构指纹 + 审计日志** ✅（2026-10-20，schema v5）：`meta.schema_fingerprint` 启动对账（漂移 warn）+ `npm run db:fingerprint` CLI + doctor 检查；新增 `audit_log` 表与 `/api/audit`（master 全量、Profile 仅自己），`/api/quick/*` 写入后记审计；迁移纯附加式、单事务、升级前自动 `pre-v4` 快照。仍待办：audit 保留策略（目前只增不清）。

## 阶段三：新领域 —— 🔲 未开始（6–12 周）

1. 周期账 / 订阅提醒
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
