# Life Assistant v2 代码与文档评审报告

- 评审日期：2026-10-17
- 评审范围：`README.md`、`AGENTS.md`、`skill/SKILL.md`、`src/**`、`tests/**`、CI/配置文件
- 评审方式：通读实现与文档 → 对照契约与测试 → 对可疑路径写临时脚本实际复现（脚本未入库）
- 验证基线：Node 26.7.0 下 `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` 全部通过（461 个测试，0 失败）。本机没有 Node 22 运行时，Node 22 相关结论依据官方文档与代码静态分析。

## 结论速览

| # | 等级 | 问题 | 位置 |
|---|---|---|---|
| 1 | **P1** | 分类预算提醒会被**无关分类**的支出误触发（已复现） | `src/modules/bookkeeping/service.ts:465-476` |
| 2 | **P2** | `engines.node >= 22.13` 与代码实际使用的 API 不符：`isOpen` 需 22.15、`isTransaction` 需 22.16 | `package.json:6-8`、`src/server/status.ts:134`、`src/core/database.ts:318` |
| 3 | **P2** | `notify.pull` 不返回通知 `id`，导致 `notify.cancel` 无法按文档从 pull 结果取 id；且 pull 已取消待投递，cancel 实际不可达 | `src/modules/notify/index.ts:37-63,135-143` |
| 4 | **P2** | `/api/deliveries` 跨 Profile 展示通知标题，个人账本月报标题会出现在共享看板上 | `src/server/details.ts:311-319` |
| 5 | **P2** | `import:v1` 在未加 `--force` 时也会静默覆盖目标库已有的静默时段 | `src/import-v1.ts:353-360,399-420` |
| 6 | **P2** | `import:v1` 不校验公历 `date`/`time`：可导入「永不触发」或「每分钟报错」的日程且报告显示成功 | `src/import-v1.ts:434-529` |
| 7 | **P2** | 跨年节假日条目在状态页与 `/api/holidays` 中丢失（如 12-31 元旦） | `src/server/details.ts:368-386` |
| 8 | **P3** | `WORKDAY_REMIND_DAYS_BEFORE=0` 时「假期临近」提醒永远不会触发 | `src/modules/holiday/index.ts:57-64` |
| 9 | **P3** | 每日简报/调休提醒无补发：daemon 在 07:00 前后重启会静默丢掉当天推送（月报有补发） | `src/modules/weather/index.ts:470-474`、`src/modules/holiday/index.ts:197-201` |
| 10 | **P3** | `notify.pull` 的 `时间` 是 UTC ISO，无本地时区字段，与日程工具的显式本地化口径不一致 | `src/modules/notify/index.ts:61` |
| 11 | **P3** | 状态页「原始状态」链接在配置 `WEB_API_TOKEN` 时必然 401 | `src/server/page.ts:602-607` |
| 12 | **P3** | `fetchJson` 的错误体「最多读 2000 字节」并未实现：先 `response.text()` 全量读入再截断 | `src/core/http.ts:1-2,58-62` |
| 13 | **P3** | 温度/降水 `unit` 未校验，与风速的严格单位校验不一致，上游改单位会静默错报 | `src/core/qweather.ts:560-565,586-591` |
| 14 | **P3** | 预警响应 `alerts` 存在但不是数组时，仍可能被当成「无预警」 | `src/core/qweather.ts:766-769` |
| 15 | 文档 | SKILL 引用的导入告警文案与实际不符 | `skill/SKILL.md:54` vs `src/import-v1.ts:244-246` |
| 16 | 文档 | README 称 `doctor --network` 的节假日检查「与 daemon 同一套判定」，实际只做可达性抓取 | `README.md:249` vs `src/doctor.ts:162-178` |
| 17 | 文档 | `npm run doctor` 同样依赖 `dist/`，但 README/AGENTS 的构建提醒漏列 | `package.json:24`、`README.md:249-255`、`AGENTS.md:12-14` |
| 18 | 文档 | README 排障建议「通知没收到先 pull」，但已成功投递的通知会被标记已读，pull 取不到 | `README.md:214` vs `src/core/notify.ts:541-554` |

---

## 一、P1：分类预算提醒被无关分类支出误触发

**位置**：`src/modules/bookkeeping/service.ts:465-476`

```ts
const after =
  budget.category === "" ? summary.total_cents : (spentByCategory.get(budget.category) ?? 0);
const before = after - entry.amount_cents;
```

对**分类预算**而言，只有本笔支出的分类与预算分类一致时，`entry.amount_cents` 才包含在 `after` 里。当前实现无条件用 `after - entry.amount_cents` 反推「记账前」，于是任何一笔**无关分类**的支出都会把该分类的 `before` 人为压低，制造出一次并不存在的「跨越阈值」。

**已复现**（临时脚本，未入库）：

- 账本「复现」，先记一笔 `餐饮 ¥500`；
- 之后给「餐饮」设预算 `¥600`（此时没有历史 80% 提醒）；
- 再记一笔完全无关的 `交通 ¥100`；
- `budgetAlertsForEntry` 返回：
  `budget:<ledgerId>:餐饮:2026-10:80` —— 推送「餐饮预算提醒」。

同样机制可误报 100%：餐饮已花 ¥420、预算 ¥400（预算在支出后设置），再记一笔交通 ¥100，会算出 `before=¥320 / after=¥420`，误判跨过 100%。

**影响**：主动推送内容错误，且 `README`/`SKILL` 明确承诺「支出跨越 80%/100% 时提醒」「同一预算一笔只推跨过的最高阈值」。这是用户可见的错误提醒，不是显示瑕疵。

**建议修复**：

```ts
const countsThisEntry = budget.category === "" || budget.category === entry.category;
const before = countsThisEntry ? after - entry.amount_cents : after;
```

无关分类时 `before === after`，不会命中任何阈值。补一条「无关分类支出不得触发分类预算提醒」的回归测试。

---

## 二、P2：Node 最低版本声明与实际 API 不符

**位置**：`package.json:6-8`、`src/server/status.ts:134`、`src/core/database.ts:318`、`tests/helpers.ts:51`、`tests/database.test.ts:376`

项目声明 `"node": ">=22.13"`，README/AGENTS 也写「要求 Node.js ≥ 22.13」。但 `node:sqlite` 的两个属性是后来才加入的（已对照 Node v22 官方文档确认）：

- `database.isOpen`：**Added in v22.15.0**
- `database.isTransaction`：**Added in v22.16.0**
- `node:sqlite` 本身从 v22.13.0 起才不再需要 `--experimental-sqlite`。

因此在声明支持的 22.13 / 22.14 / 22.15 上会出问题：

- 22.13 / 22.14：`db.isOpen` 为 `undefined`，`/healthz` 里 `healthy ? 200 : 503` 恒为 **503**（健康探针永远报不健康）；`cleanupTestEnv`/`import-v1` 也不会关闭数据库句柄。
- 22.13–22.15：`db.isTransaction` 为 `undefined`，`withReadTransaction` 的「已在事务内则复用快照」守卫失效；`tests/database.test.ts:376` 的 `assert.equal(env.db.isTransaction, false)` 会直接失败（`undefined !== false`）。由于当前生产调用没有嵌套场景，功能影响有限，但测试在声明的最低版本上跑不过。
- CI 的 `node: [22, 24]` 会安装**最新** 22.x，不会覆盖 22.13 这个下界，所以 CI 发现不了。

**建议**：二选一。

1. 将 `engines.node` 提升到 `">=22.16"`（并同步 README/AGENTS），CI 增加一个 `22.16.0` 的矩阵项；或
2. 不依赖新属性：`/healthz` 用 `db.isOpen !== false`/`SELECT 1` 探测；`withReadTransaction` 用进程内事务深度计数替代 `db.isTransaction`，测试也相应调整。

---

## 三、P2：`notify.pull` 不返回 id，`notify.cancel` 实际不可达

**位置**：`src/modules/notify/index.ts:37-63`、`:135-143`

`pull` 的 SELECT 取了 `id`，但输出映射只保留 `标题 / 种类 / 时间 / 内容`，没有 `id`：

```ts
未读通知: rows.map((r) => ({
  标题: r.title,
  种类: r.kind,
  时间: r.created_at,
  内容: r.body_md,
})),
```

而 `cancel` 的错误提示写着「cancel 需要 id（可从 pull 结果获取）」，`SKILL.md` 也把「取消推送」列为 `notify` 的能力。实际调用链上，agent 拿不到任何通知 id，因此 `cancel` 无法被正常使用。

更进一步：`pull` 本身已经调用 `cancelPendingDeliveries` 并把这些通知标记为已读，所以即使补上 id，pull 之后也基本没有「待取消」的东西了（只有 `fallback` 不在 pull 的取消范围内，而它也不是 `cancel` 的目标状态）。**建议**明确二者语义：

- 若保留 `cancel`：在 pull 输出中返回 `id`，并考虑让 pull 不自动取消（或提供「只读列表」），否则 `cancel` 永远无事可做；
- 若 pull 的自动取消就是最终设计：从工具 schema、SKILL 和错误文案中移除 `cancel`，避免给 agent 一个不可用动作。

同时给 pull 输出补 `id` 的回归测试（当前测试直接用内存里的 `pub.id`，没有覆盖真实调用链）。

---

## 四、P2：`/api/deliveries` 跨 Profile 泄露通知标题

**位置**：`src/server/details.ts:311-319`

```sql
SELECT d.id, d.notification_id, COALESCE(n.title, '（通知已删除）') AS title,
       COALESCE(n.profile_id, '-') AS profile_id, ...
FROM deliveries d LEFT JOIN notifications n ON n.id = d.notification_id
ORDER BY d.created_at DESC LIMIT ?
```

查询没有按 Profile 或可见性过滤。状态页「投递明细」抽屉会把**所有 Profile** 的通知标题展示给任何持有共享 `WEB_API_TOKEN` 的调用方，其中包括：

- 各 Profile 的日程提醒标题（README 已知取舍 #12 已说明）；
- **个人账本的月度账单标题**（如「2026-09 月度账单 · 私房钱」）——这类通知按设计「仅归属人可见」，但只要有推送路由，就会产生 delivery 行并出现在共享看板上。

README #12 只承认了日程的跨 Profile 展示，没有提到投递标题；这与「个人账本仅归属人可见」的承诺不一致。

**建议**：给通知增加可见性维度（例如 `notifications.visibility` / `private_profile_id`），发布时标记；`deliveryDetails` 对个人范围的通知只显示脱敏标题（或仅对归属人显示），并在 README 的已知取舍中明确说明。若短期不修，至少应在 README #12 中补充「投递标题同样跨 Profile」。

---

## 五、P2：`import:v1` 未加 `--force` 也会覆盖静默时段

**位置**：`src/import-v1.ts:353-360`（非空守卫）、`:399-420`（settings 写入）

非空守卫只检查 `schedules / ledgers / notifications` 三张表：

```ts
for (const table of ["schedules", "ledgers", "notifications"]) { ... if (row.n > 0 && !force) throw ... }
```

而 `profile_settings` 的导入是无条件 `setSetting`，不看 `force`：

```ts
setSetting(target, s.profile_id, "quiet_hours", { start: s.quiet_start, end: s.quiet_end });
```

**已复现**：目标库先设 `quiet_hours = 23:00–06:00`（且没有 schedules/ledgers/notifications，守卫放行），旧库为 `22:00–07:00`；`runImport` 不加 `--force` 成功返回，目标库的静默时段被改成 `22:00–07:00`，`problems` 为空、无任何提示。

**影响**：在已经用 v2（例如只配过静默时段、拉过通知）的库上补导入时，会静默丢失目标库配置；README 的 `--force` 语义（「只覆盖旧库里存在、本次会重新写入的那些行」）也未覆盖这一行为。

**建议**：`quiet_hours` 仅在 `--force` 时覆盖；未加 force 且目标已有该设置时保留并记一条 warning（或 problem）。同时把守卫的语义写清楚：到底哪些表算「非空」。

---

## 六、P2：`import:v1` 不校验公历 `date`/`time`，会导入死行

**位置**：`src/import-v1.ts:434-529`（尤其 `:503-525` 的裸 INSERT）

导入对农历的死行有明确告警（月/日缺失、recurrence 为空、interval 收口），但公历行直接把 `s.date` 和 `s.time` 写进库：

- v1 的 `schedules.date` 允许 NULL（测试用 `OLD_DDL` 即如此）。公历 + `date=NULL` 的行会入库，`iterate` 因 `startDate === null` 直接返回 → **零 occurrence，永远不触发**，导入报告没有任何 warning/problem。
- v1 的 `time` 是 TEXT，没有格式约束。导入 `25:99` 这类值后，每次 `tickSchedules` 物化都会在 `localToInstant` 抛「本地时间不合法」，被逐行捕获后**每分钟写一条 warn**；日程仍然永远不触发。

**已复现**：构造两条公历行（`date=NULL`、`time='25:99'`），`runImport` 报告 `schedules: 2`、`problems: []`、`scheduleWarnings` 只有「旧库没有某表」的提示，`occurrences: []`。

**建议**：在逐行 try 内用与 `validateScheduleInput` 相同的规则校验 `calendar === "solar"` 的 `date`（存在且为真实日期）与 `time`（`TIME_RE`），失败记 `problem` 而不是静默入库；至少对 `date=NULL` 和无 occurrence 的行给出与农历死行同等级的 warning。

---

## 七、P2：跨年节假日条目在状态页/`/api/holidays` 中丢失

**位置**：`src/server/details.ts:368-386`

`cn_holiday_days.year` 存的是**数据文件年份**（`importYear` 写入 `payload.year`），跨年条目（如 2027.json 里的 `2026-12-31`）会存成 `year=2027`。但 `holidayDetails` 用该列筛选展示年份：

```ts
const days = db
  .prepare("SELECT date, name, day_type FROM cn_holiday_days WHERE year = ? ORDER BY date")
  .all(year);
```

年末场景：

- `currentYearHasUpcoming` 用 `substr(date,1,4) = 当前年` 判断，发现 `2026-12-31` 是假期 → `fallbackYear = 2026`；
- `days` 又按 `year = 2026` 查，取不到 `year=2027` 的 `2026-12-31`；
- `upcoming` 为空 → 状态页「下一个假期」显示「暂无数据」，而 `holiday {view:"next"}`（走 `nextHolidayPeriod`，按日期计算）能正确返回元旦。

**已复现**：插入 `2026-12-31`（year=2027）、`2027-01-01`（year=2027）、`2026-01-01`（year=2026）并把 2026/2027 标 ready；`holidayDetails` 返回 `year=2026`、`days=['2026-01-01']`、`upcoming=[]`。

**建议**：展示层按**日期所属年份**筛选（`WHERE date LIKE 'YYYY-%'` 或 `substr(date,1,4) = ?`），`year` 列只用于文件归属/整年替换。这样 `/api/holidays?year=2026` 会包含 2026-12-31，与 `view=month` / `nextHolidayPeriod` 口径一致。

---

## 八、P3：`WORKDAY_REMIND_DAYS_BEFORE=0` 时提醒永不出现在

**位置**：`src/modules/holiday/index.ts:57-64`

```ts
if (period.start <= today) continue;
const daysUntil = ...;
if (daysUntil > remindDays) continue;
```

配置允许 0（`.env.example:69`、README:54、config 校验 0..30）。但 `period.start > today` 意味着 `daysUntil >= 1`，当 `remindDays = 0` 时 `daysUntil > 0` 恒成立，**「假期临近」分支永远不会发布任何通知**。若 0 的本意是「假期当天提醒」，应在 `period.start === today` 时也允许（或把条件改为 `period.start < today` 才跳过、`daysUntil = 0` 时照常判定）；若 0 的本意是「关闭」，应在配置文档中写明，并避免与每日简报里独立的「明天开始放假」提示产生语义混淆。

---

## 九、P3：07:00 类定时推送错过即永久丢失

**位置**：`src/modules/weather/index.ts:470-474`、`src/modules/holiday/index.ts:197-201`；对照 `src/modules/bookkeeping/index.ts:443-463`

月报 job 明确处理了「node-cron 不补发错过的触发」：每次运行先 `findMissingMonthlyReports` 补齐。但：

- `weather.daily_brief`（默认 07:00）没有补发逻辑；
- `holiday.workday_watch`（默认 07:00）也没有。

daemon 在这两个 cron 的触发时刻停机/重启（升级、崩溃重启、systemd restart）时，当天的每日简报、补班/放假/假期最后一天提醒不会产生，也没有任何日志或状态页提示。`SKILL.md` 告诉用户这些是「服务端自动推的」，但实际会静默缺失。

**建议**：利用现有的 `dedupeKey`（`brief:<profile>:<city>:<date>`、`holiday:*:<date>`）在 `onStart` 或启动后的第一次 tick 做一次幂等补发；或在 README 的已知取舍里明确「错过 cron 不补发」。前者成本不高，且不会重复推送。

---

## 十、P3：`notify.pull` 的时间是 UTC，且没有本地化字段

**位置**：`src/modules/notify/index.ts:61`

日程工具专门为 `下次提醒` / `提醒时间` 补了 `(本地)` 键，并在 `SKILL.md:61` 明确要求「向用户报时间一律用（本地）键，直接读 UTC 值会差 8 小时」。但 `notify.pull` 输出的 `时间: r.created_at` 是 `nowIso()` 的 UTC ISO，没有本地键，也没有任何提示。agent 若直接转述，会把通知时间报早 8 小时。

**建议**：与日程保持一致，补 `"时间(本地)"`（`yyyy-MM-dd HH:mm`，Asia/Shanghai）；或至少把 `时间` 改成带时区偏移的本地 ISO 并在 SKILL 中说明。

---

## 十一、P3：状态页「原始状态」链接在启用 token 时必然 401

**位置**：`src/server/page.ts:602-607`

```html
GET <a href="/api/status" style="color:inherit">/api/status</a> · ...
```

页面自己的数据请求走 `fetch` + `Authorization: Bearer <localStorage token>`，而这些 `<a href>` 是普通导航，不会带 Authorization 头；配置了 `WEB_API_TOKEN` 时点击必然得到 `{"error":"unauthorized"}`。未配置 token 时才能正常打开。

**建议**：拦截链接点击，用页面已有的 `api()` 取数后在抽屉里展示 JSON；或在点击时临时拼 `?token=`（但会重新把凭据放进 URL，不推荐）。

---

## 十二、P3：`fetchJson` 的错误体上限没有真正生效

**位置**：`src/core/http.ts:1-2,58-62`

```ts
/** 错误响应体最多读这么多字节，避免上游返回巨大 HTML 时占用内存 */
const MAX_ERROR_BODY = 2000;
...
text = (await response.text()).slice(0, MAX_ERROR_BODY);
```

`response.text()` 会把整个响应体读进内存，`.slice` 只是截断保留内容，无法避免巨大响应体造成的瞬时内存占用。注释描述的防护与实现不符。**建议**：用 `response.body.getReader()` 增量读取到上限后 `cancel()`，或先看 `Content-Length`（不可信时仍要限流读取）。

---

## 十三、P3：温度/降水单位未校验

**位置**：`src/core/qweather.ts:560-565`（`measureValue` 只取 value）、`:586-591`（`periodPrecipMm` 只取 value）

风速有严格的单位白名单（`:575-584`，无法识别即抛错），但：

- `temperature` / `feelsLike` 的 `unit` 被忽略，若上游从 `°C` 改为 `°F`，工具会继续标注 `°C`；
- 降水量的 `unit` 被忽略，若上游改为 `in` 或其他单位，会按 mm 展示。

**建议**：与风速同口径校验 `unit`（温度接受 `°C`/`C`，降水接受 `mm`），不识别即抛错，避免「静默换算错」。

---

## 十四、P3：预警结构校验仍有一个「静默成无预警」的缺口

**位置**：`src/core/qweather.ts:766-769`

```ts
if (!Array.isArray(body.alerts)) {
  if (body.metadata !== undefined || body.code !== undefined) return [];
  throw new Error(...);
}
```

当 `alerts` **存在但不是数组**（例如 `alerts: null`、`alerts: {}`）且同时带有 `metadata` 时，会返回空数组，即「当前无生效预警」，并被缓存 10 分钟。这与代码注释「结构异常宁可抛错」以及「无预警是安全相关结论」的意图不一致。

**建议**：`if (body.alerts !== undefined && !Array.isArray(body.alerts)) throw`，只有 `alerts` 真正缺失、且 `metadata`/`code` 表明是正常零结果时才返回 `[]`。

---

## 十五、文档与实现不一致

### 15.1 SKILL 引用的导入告警文案不存在

`skill/SKILL.md:54` 要求 agent 识别文案含「无法在 v2 表达/已按每年循环导入」的 warning，但实际文案是：

```ts
`日程「${title}」的循环类型 ${String(parsed.frequency)}（${calendar}）不支持，按每年循环导入`
```

（`src/import-v1.ts:244-246`）。实际字符串包含「按每年循环导入」，但不含「无法在 v2 表达」，也不含「**已**按每年循环导入」。若 agent 严格匹配 SKILL 给出的文案，可能漏识别。测试 `tests/import-v1.test.ts:347` 只检查 `freq`/`农历` 子串，没有钉住这句文案。**建议**：把 warning 改成 SKILL 所写的措辞（推荐），或同步 SKILL 与实际文案，并加一条断言。

### 15.2 `doctor --network` 的判定被描述得过强

`README.md:249` 说节假日数据源检查「与 daemon 同一套判定」。实际 `checkNetwork`（`src/doctor.ts:162-178`）只调用 `fetchJson` 判断 HTTP/JSON 是否可获取，没有调用 `validateYearPayload`，也没有校验 `payload.year === year`。daemon 会因校验失败拒绝导入，doctor 却会报「可获取」。**建议**：doctor 复用 daemon 的 `fetchYearPayload` + `validateYearPayload`（或至少校验 year 字段），或把 README 改成「仅探测可获取」。

### 15.3 `doctor` 的 dist 依赖漏写

`package.json:24` 的 `doctor` 脚本是 `node ... dist/doctor.js`，没有 `dist/` 时直接 `Cannot find module`。但：

- `README.md:249` 把 `npm run doctor` 列在开发命令里；
- `README.md:254` 的「跑的是 dist 产物」清单只列了 `db:backup / db:cleanup:preview / import:v1`；
- `AGENTS.md:12-14` 同样漏列 `doctor`。

**建议**：把 `doctor` 加入这两处清单，或提示改用 `npm run dev:doctor`。

### 15.4 「通知没收到 → 先 pull」的建议有前提

`README.md:214` 写「通知明明发出但用户说没收到 → 先 notify.pull（静默时段与投递失败都只影响主动推送，通知本身保留）」。但成功投递时 `markSent` 会把 `notifications.read` 置 1（`src/core/notify.ts:541-554`），而 pull 只查 `read = 0`。因此「明明发出（已 sent）」的通知无法从 pull 取到；该建议只适用于投递失败/静默未投/无路由的情况。**建议**：把排障措辞写准确，或提供「按 id/时间回看已读通知」的能力。

---

## 十六、复核后确认属于既有取舍、不计为缺陷的项

以下行为在代码注释、README 已知取舍或测试中有明确依据，本次不作为新问题上报：

- 传输失败达到上限后落入 `fallback` 且 `request_started_at` 保留，`requeueRoute` 不会重新入队：这是「不盲重发不确定是否已送达的请求」的刻意取舍，`tests/notify.test.ts` 已钉住。
- `notify.pull` 拦不住处于 `sending` 的在途投递：README #10。
- 状态页 `/api/schedules` 跨 Profile 展示日程标题/备注：README #12。
- `recurrence.count` 日程与已取消日程的 occurrence 清理豁免：README #11/#274。
- QWeather 只对 429/5xx/网络故障重试，4xx 立即抛出：README 与 `AGENTS.md` 的账号冻结红线。
- GeoAPI 结果只做进程内 memo、不落盘：符合官方版权限制；`locate` 的显式位置保存是文档声明的例外。
- `schedules.version` 只增不校验：README 已知取舍 #5。

## 十七、复现记录摘要

本次评审实际跑过的临时脚本（均在 `/tmp`，已删除，未修改仓库）：

1. **预算误报**：预算 ¥600 + 既有餐饮 ¥500（预算后设）+ 交通 ¥100 → `budget:<id>:餐饮:<ym>:80`。
2. **跨年节假日**：`2026-12-31(year=2027)` + `2027-01-01(year=2027)` → `holidayDetails` 返回 `year=2026, upcoming=[]`。
3. **import 静默时段覆盖**：目标 `23:00–06:00`、旧库 `22:00–07:00`，无 `--force` → 目标被改成 `22:00–07:00`。
4. **import 公历死行**：`date=NULL` 与 `time='25:99'` 两条 → 报告成功导入 2 条，`occurrences=[]`，无 warning/problem。
5. **notify.pull 输出**：实际 JSON 只有 `标题/种类/时间/内容`，没有 `id`；`时间` 为 UTC（如 `2026-10-17T06:48:41.728Z`）。

CI 基线（Node 26.7.0）：`typecheck / lint / format:check / test / build` 全部通过，461 tests、0 fail。

## 十八、修复记录（2026-10-17）

以上问题已按批次修复；修复后同一链路（Node 26.7.0）通过：**469 tests、0 fail**，`typecheck / lint / format:check / build` 全绿。

| # | 状态 | 修复内容 |
|---|---|---|
| 1 | ✅ 已修复 | `budgetAlertsForEntry` 仅在「总额预算或分类匹配」时扣减本笔金额；新增「无关分类不得触发分类预算」回归测试 |
| 2 | ✅ 已修复 | `engines.node` 提升到 `>=22.16.0`，README/AGENTS 同步；CI 矩阵加入 `22.16.0` 下界 |
| 3 | ✅ 已修复 | `notify.pull` 输出补 `id` 与 `时间(本地)`；新增 pull 输出契约测试 |
| 4 | ✅ 已修复 | `/api/deliveries` 将个人账本 `report:<id>:<ym>` 月报标题脱敏为「（个人账本月报）」；README #12 补充说明 |
| 5 | ✅ 已修复 | `import:v1` 未加 `--force` 时保留目标库已有 `quiet_hours` 并给 warning；`--force` 才覆盖 |
| 6 | ✅ 已修复 | `import:v1` 校验所有日程的 `time`、公历行的 `date`；不合法逐行进 `problems`（新增两条回归测试） |
| 7 | ✅ 已修复 | `holidayDetails` 按日期年份筛年度视图；「接下来的假期」改为全量日期合并，跨年假期天数不再被年份边界截断 |
| 8 | ✅ 已修复（文档） | README/.env.example 明确 `WORKDAY_REMIND_DAYS_BEFORE=0` = 关闭「假期临近」提醒 |
| 9 | ✅ 已记录 | README 已知取舍新增 #13：简报/调休提醒不做错过 cron 的补发 |
| 10 | ✅ 已修复 | 同 #3，pull 输出增加 `时间(本地)` |
| 11 | ✅ 已修复 | 状态页「原始状态」改为 `data-api` 链接，点击走带 Bearer 的 `api()` 并在抽屉展示 JSON |
| 12 | ✅ 已修复 | `readErrorDetail` 改为流式读取，最多读入 `MAX_ERROR_BODY` 字节后 `cancel()` |
| 13 | ✅ 已修复 | 温度/降水单位白名单校验（°C/mm），与风速口径一致 |
| 14 | ✅ 已修复 | `alerts` 存在但不是数组时抛结构错误，不再当成「无预警」 |
| 15 | ✅ 已修复 | import warning 改为「无法在 v2 表达，已按每年循环导入」，与 SKILL 引用一致 |
| 16 | ✅ 已修复（文档） | README 明确 doctor 网络检查仅探测可获取，daemon 导入时才做完整数据校验 |
| 17 | ✅ 已修复（文档） | README/AGENTS 的 `dist/` 依赖清单补上 `doctor` |
| 18 | ✅ 已修复（文档） | README 排障说明改为「pull 只返回未读；已成功投递的通知不再返回」 |
