# life-assistant-v2 代码与文档评审报告

- 日期：2026-10-09
- 范围：`src/**`、`tests/**`、`README.md`、`AGENTS.md`、`skill/SKILL.md`、`.env.example`、`package.json`
- 方法：通读实现与文档；跑完整 CI 链路 `typecheck -> lint -> format:check -> test`；对失败用例定位根因。
- 结论：工程质量高，分层清晰，文档罕见地详尽且用 `tests/docs-consistency.test.ts` 做了文档回归。
  目前有 **1 个当前即失败的缺陷（2 个用例）**，若干健壮性/一致性可优化点，以及 README 自述的 6 项未完成取舍。

严重级别：**P0** 当前失败/影响正确性；**P1** 建议修复（低风险健壮性）；**P2** 文档与可优化功能。

---

## P0 · 必须修复

### P0-1 状态页脚本有两个“时间炸弹”用例，现在就跑不过

`npm test` 结果：`tests 437 / pass 435 / fail 2`，两个失败都在
`tests/status-page-script.test.ts`：

- `:293` 「节假日抽屉翻年后保留所选年份（30s 自动刷新不再打回当年）」
  在 `:313` 断言 `html` 匹配 `/2026 年安排/`（“默认展示当年”）失败。
- `:319` 「30s 自动刷新不把开着的抽屉打回「加载中…」（且保留所选年份）」
  在 `:340` 同样断言 `/2026 年安排/` 失败。

**根因**：两个用例（`:296-305` 与 `:322-331`）都硬编码写入：

- `cn_holiday_years` ready = {2026, 2027}
- `cn_holiday_days` 只有 `2026-10-01`（国庆）与 `2027-01-01`（元旦）

`src/server/details.ts` 的 `holidayDetails` 用
`currentYearHasUpcoming = 存在 year==当前年 且 date>=今天 的节假日行`，
再算 `fallbackYear = years.includes(本.year) && currentYearHasUpcoming ? 本.year : (下一个更大的年 ?? 末年)`。
今天是 **2026-10-09**，唯一种子 2026 节假日 `2026-10-01` 已过去 →
`fallbackYear` 落到 **2027** → 抽屉默认显示「2027 年安排」→ 断言失败。

> 这是**测试缺陷**，不是生产逻辑缺陷：生产「年末顺延到下一年」的行为是 README 明确设计的。
> 该用例只有在“当年国庆尚未到来”或“运行年份不在 `years` 中”时才碰巧通过，属于典型的随日期漂移的脆弱测试。

**修复建议**（二选一）：
1. 像 `tests/weather.test.ts`、`tests/holiday-workday-watch.test.ts` 那样用
   `t.mock.timers.enable({ apis:["Date"], now: Date.parse("<固定时刻>+08:00") })` 冻结时钟；
2. 或把种子数据改成相对今天生成（例如插入一条 `todayIso()` 之后日期的节假日），
   并按实际计算出的 `fallbackYear` 断言，而不是写死 2026。

---

## P1 · 建议修复（健壮性 / 一致性）

### P1-1 `retention.ts` 中“取消日程”清理谓词被复制了两份，注释却称“共用同一份判定”

`src/core/retention.ts`：

- `cancelledScheduleRetentionPlan`（`:64-70`）与 `runRetention`（`:102-108`）各自内联了完全相同的
  `status='cancelled' AND updated_at<? AND (recurrence_json IS NULL OR recurrence_json NOT LIKE '%"count"%')`。
- 与之对照，通知清理已抽出 `notificationCleanupWhere()`（`:37-44`）被预演和实删共用。

`runRetention` 顶部注释写“与 preview 共用同一份判定”，但取消日程这条实际是拷贝，未来改一处漏另一处就会
出现「预演数与实删数不一致」。**建议**抽出 `cancelledScheduleCleanupWhere()` 共用。

**另外**：`NOT LIKE '%"count"%'` 是字符串子串匹配判定 count 日程。当前
`recurrence_json = JSON.stringify(recurrence)`，count 字段必为 `"count":N`，实践可靠；但任何新增字段名含
`count` 子串都会误豁免。已有 `parseRecurrence()`，可像 `schedule/service.ts` 的
`countProtectedScheduleIds()` 一样按解析结果判定，更稳。

### P1-2 `server/details.ts` 的 `expenseDetails` 未包读事务

`expenseDetails`（`:61-113`）连续执行 6 条独立 SELECT（总额/分类/每日/账本/明细/上月），
没有像 `summarizeExpenses` 那样包 `withReadTransaction`。并发写入时看板各卡片可能取自不同快照
（单写者下窗口极小，属于一致性小瑕疵）。**建议**把这几条查询包进 `withReadTransaction`。

### P1-3 `ledgers.name` 没有数据库级唯一约束

`bookkeeping/service.ts` 的 `createLedger`/`renameLedger`/`setLedgerArchived` 只用 JS 查询
「活动账本中是否同名」来判重，DDL 无 `UNIQUE`。单写者下基本安全，但两条并发 `ledger create` 理论上可
同时通过检查。**建议**加部分唯一索引（SQLite 支持）：

```sql
CREATE UNIQUE INDEX idx_ledgers_active_name ON ledgers(name) WHERE archived_at IS NULL;
```

并作为一次 additive migration 落地。

### P1-4 `HOST` 未走 `normalizeHost`，带 scheme/端口的写法会被误判为非回环

`src/config.ts:211-212`：

```ts
const host = env.HOST?.trim() || "127.0.0.1";
const loopback = isLoopbackHost(host);
```

而 `isLoopbackHost`（`:301-304`）只做小写 + 去方括号后精确比较，不剥 `http://` 与 `:port`。
`normalizeHost`（`:82-88`）存在且能剥 scheme，但只用于 `QWEATHER_API_HOST`。
于是 `HOST=http://127.0.0.1` 或 `HOST=127.0.0.1:3080` 会被判为非回环 → 强制要求 `WEB_API_TOKEN`，
报错信息与真实原因不符。**建议** `isLoopbackHost(normalizeHost(host))`，或在文档/校验层明确拒绝带端口/scheme。

### P1-5 月报补发只有 6 个月回看窗口

`bookkeeping/service.ts` 的 `findMissingMonthlyReports(lookbackMonths = 6)`：守护进程连续停机超过 6 个月时，
更早缺失的月报**永远不会补发**。日常影响低，但值得把窗口做成可配置，或至少在跳过时打一条 warn 便于排查。

### P1-6 记账收据与预算提醒是 fire-and-forget

`bookkeeping/index.ts` 的 `expense add` 用
`void ctx.services.publishGlobal(...).catch(warn)` 推送「记账回执」和「预算告警」。
推送失败只进日志，工具仍返回「已记账」，用户不会感知。设计上可接受（记账成功不应因推送失败而报错），
但建议至少把失败日志级别提高，或在状态页投递计数里可见。

### P1-7 QWeather 用量寄存在 `cache` 表的 400 天 TTL 行

`src/core/qweather.ts` 的 `bumpQweatherUsage` 把每日计数写入 `cache` 表的
`qweather:usage:<day>`（400 天过期），`pruneCache` 只删已过期行，因此这些行会长驻较久。
属于已知的“搭便车”设计，功能正确；若后续要做 `cache` 表体积治理，需要把用量计数迁到 `meta`/独立表。

### P1-8 预警级别“降级”也会重新推送

`weather/index.ts` 的 `alertDedupeKey = weather.alert:<id>:<level>`（无 id 时用标题）。
README 只承诺「级别升级再推」，但 key 含 level 意味着**降级同样会再推一次**。随级别取值的集合有限、
影响不大，但若只想在升级时提醒，应在生成 dedupeKey 前比较历史级别。

---

## P2 · 文档与已识别取舍（README「已知取舍」3/5/6/7/9/10 仍未做）

README 的取舍表本身很准确，逐条给出建议：

- **#3 v7 → v1 天气端点迁移**：确未迁移（`currentWeather` 仍打 `/v7/weather/now`，
  `forecast` 仍 `/v7/weather/${3d|7d}`；geo/预警/空气已是 v1）。迁移时务必处理
  **v1 的 humidity 是 0–1 小数且值包在 `{value,unit}` 里**（v7 是百分数），否则会静默错报湿度；
  建议迁移时补一条针对单位换算的回归用例。因 v7 城市版端点已弃用，建议列入近期计划。
- **#5 `schedules.version` 未参与并发控制**：列每次 `+1` 但无乐观校验。单写者下没有实际风险。
  建议下次 schema 变更时**直接删列**，避免“看似有版本控制、实则无效”的误导；若未来引入多写者再实现。
- **#6 节假日重试实际 24h**：`FETCH_COOLDOWN_MS=6h`，但主动刷新 job 仍是每天 `0 2 * * *`。
  物化撞未就绪已能按需补齐（受 6h 冷却）。建议把刷新 job 改成 `0 */3 * * *`，与冷却对齐。
- **#7 状态页 `/` 无鉴权**：静态 HTML 无数据，敏感数据都走受保护的 `/api/*`；但页面结构本身
  对外可见。若可能暴露到非回环网络，建议在非回环时给 `/` 也加 token 门（可用同一 `/api/*` 鉴权）。
- **#9 server 层直接 import 模块纯函数**：`src/server/details.ts:3-4` 直接 import
  `bookkeeping/service` 的 `monthRange` 与 `schedule/service` 的 `KIND_LABEL/parseEscalation`。
  契约测试只强制 core 不依赖模块，不覆盖 server。建议把这些纯函数下沉到 core（或新增
  `shared` 层）以消除技术债，否则改模块签名会静默影响看板。
- **#10 `notify.pull` 拦不住在途 `sending`**：文档已如实说明，55 分钟幂等窗口兜底。可保持现状；
  若想更透明，可在状态页/通知里区分 `sending` 与 `queued` 的取消结果。

文档一致性方面整体很好：`tests/docs-consistency.test.ts` 已把「自动读 `.env` 的脚本清单」
「GeoAPI 不落盘但 `weather locate` 例外」「农历 interval 口径」「测试禁止
`new Date().toISOString().slice(0,10)`」等做成回归断言，值得保留这套机制。

---

## 可优化功能（roadmap 性建议，非缺陷）

1. **日程单次编辑**：目前只能整体 `update` 或按 `occurrence_key` `complete`；若用户想“只跳过这一次”
   缺少直接语义（可用 complete 近似）。可作为后续增强。
2. **账本订阅/通知范围**：全局账本的记账回执与预算告警会推给所有已配置路由的 profile；
   多用户场景下若想只通知相关人，需要账本级订阅配置。
3. **`recurrence.count` 日程永久保留 occurrence**：README #11 已明确该豁免；长期看会增加存储，
   可考虑在达到上限后允许“冻结”而非免清理。
4. **`cache` 表职责**：同时承载天气缓存与 QWeather 用量计数，建议拆分以简化清理与观测。

---

## 验证记录

- `npm run typecheck`：通过（src 与 tests 两个 tsconfig）。
- `npm run lint`（Biome，64 文件）：通过，无诊断。
- `npm run format:check`：通过。
- `npm test`：437 用例，435 通过，**2 失败**（见 P0-1，均已定位为日期相关测试缺陷）。
- 另确认：JWT-only 配置下 `config.ts` 将 `qweatherKey` 置为空串，
  `weather/index.ts` 的 `requireQweather` 因此能正确放行，README 推荐的 JWT 认证不会误拦天气工具。

---

## 优先级建议

| 优先级 | 事项 | 备注 |
| --- | --- | --- |
| P0 | 修 `status-page-script.test.ts` 两个日期相关用例 | 当前 CI 红 |
| P1 | `retention.ts` 谓词去重 + `details.ts` 读事务 + `ledgers.name` 唯一索引 | 低风险、收益明确 |
| P1 | `HOST` normalize、月报回看窗口、`publishGlobal` 失败可见性 | 健壮性 |
| P2 | README 取舍 #3/#5/#6/#7/#9/#10 逐项排期 | 见上建议 |

---

## 修复记录（2026-10-09 本次实施）

已修复并验证：

- **P0-1**：`tests/status-page-script.test.ts` 两个节假日抽屉用例改为**动态年份种子**
  （新增 `seedHolidayYears`，当年假日设在今天），不再随日期漂移。
- **P1-1**：`src/core/retention.ts` 抽出 `cancelledScheduleCleanupWhere()`，
  `cancelledScheduleRetentionPlan` 与 `runRetention` 共用同一判定。
- **P1-2**：`src/server/details.ts` 的 `expenseDetails` 整体包 `withReadTransaction`，
  与 `summarizeExpenses` 一致。
- **P1-3**：`src/core/database.ts` 在 `migrate` 中增加活动账本部分唯一索引
  `idx_ledgers_active_name`（`WHERE archived_at IS NULL`，best-effort，历史重名只告警不拒绝启动）。
- **P1-4**：`src/config.ts` 的 `HOST` 走 `normalizeHost`，并对误写端口
  （如 `127.0.0.1:3080`）给出明确报错；新增 `looksLikeHostWithPort`（IPv6 不受影响）。

新增回归测试：`tests/config.test.ts`（HOST 归一化/端口报错/IPv6）、
`tests/database.test.ts`（活动账本唯一约束 + 历史重名 best-effort）。

验证结果：`typecheck` / `lint` / `format:check` / `build` 全部通过；
`npm test` → **tests 440 / pass 440 / fail 0**（较修复前 +3 用例，两个失败用例已转绿）。

仍未修复（保留待办，见上表 P1-5～P1-8 与 P2 说明）：月报回看窗口、
记账推送失败可见性、QWeather 用量寄存 cache 表、预警降级重推，以及 README 自述的
6 项文档取舍。
