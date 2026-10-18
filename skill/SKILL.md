---
name: life-assistant
description: 个人生活助理：天气/空气质量/节假日调休/日程提醒（公历+农历）/支出记账/通知管理
read_when:
  - 用户问天气、空气、预警、穿衣出行建议
  - 用户问节假日、调休、某天是否上班
  - 用户想设提醒、待办、生日、纪念日（含农历）
  - 用户想记账、查支出、看月度账单
  - 用户提到通知、静默时段、推送设置
---

# Life Assistant v2

单守护进程 MCP 服务。工具前缀为 `mcp_life_assistant_`（点号转下划线）：`weather`、`air_quality`、`holiday`、`schedule`、`ledger`、`expense`、`notify`。

## 会话开始

每次会话先调用一次 `notify.pull`，把未读通知转告用户（主动推送失败的兜底）。没有未读则继续，不必提及。

## 工具选择

| 意图 | 工具 |
|---|---|
| 实时天气 / 预报 / 预警 / 设置位置 / 出行模式 | `weather {view}` |
| 空气质量（国标 AQI） | `air_quality` |
| 下一假期 / 某月安排 / 某日是否上班 | `holiday {view}` |
| 待办、生日、纪念日提醒（公历+农历） | `schedule {action}` |
| 账本管理、月度预算 | `ledger {action}` |
| 记一笔支出 / 明细 / 汇总 / 编辑 / 删除记错的一笔 / 导出 CSV | `expense {action}` |
| 拉通知 / 静默时段 / 推送路由 / 取消推送 | `notify {action}` |

硬性边界：

- 不要用 LLM cron 或其它机制伪造定时任务；所有确定性提醒走 `schedule`。
- `holiday` 数据未覆盖的日期返回"未知"，绝不按星期猜测调休。
- `holiday {view:"next"}` 输出带「进行中」布尔：假期期间为 `true` —— 别只看「开始/结束」日期就告诉用户"假期还没到"。
- 不要虚构工具之外的能力（油价、共享账本角色、快递等 v1 能力已移除）。
- 只操作当前 Profile 的日程与通知；账本分**家庭**（所有 Profile 共享）与**个人**（仅归属人可见可写）。

## 天气与位置

- 用户首次问天气时：`weather {view: "locate", city}` 让用户确认城市；已设置则直接用。
- `city` 参数可选；缺省用该 Profile 已设位置或服务端默认城市。
- 数据源为 QWeather：配额用尽或键缺失时工具返回明确错误，如实转告，不要编造数据。
- 简报（如用户问"今天穿什么"）：综合 current + air + 预报提示；**把 `天气` 表里的「更新时间 / 数据获取时间」行一并转述**（实时数据有 20 分钟缓存，不标注就等于隐瞒数据新鲜度；v1 上游不提供观测时刻，此时该行是「数据获取时间」）。
- `weather {view: "forecast"}` 的 `days` 仅接受 3 或 7（默认 7），其它值会被服务端拒绝。
- **出行模式**：`weather {view:"travel", action:"set", city, start, end}`（日期 `YYYY-MM-DD`，含首尾，窗口最长 366 天）—— 窗口内该 Profile 的天气/空气/预警、每日简报与预警巡检都会自动改用目的地城市，简报里会标注「出行模式」；`action:"show"` 查看当前计划（未设置时返回 `null`；数据损坏时会返回「出行计划数据损坏」说明并忽略），`action:"clear"` 清除。显式传 `city` 的查询仍优先于出行计划；`weather locate` 设置的始终是「家」的位置（出行生效期间调用会提示查询仍走目的地），窗口结束后自动恢复。

## 日程

- 生日/纪念日默认按年循环（`schedule {action:"add"}` 省略 `recurrence` 时：`kind=todo` 为一次性，生日/纪念日为每年一次）；`calendar: "lunar"` 需给 `lunar_month/lunar_day`（1-12 / 1-30）。
- `add` 的默认值：`time` 为 `09:00`、`all_day` 为 `false`（显式传了 `time` 就不会被当成全天；要全天请传 `all_day: true`）。
- 农历日越界（如腊月三十缺失）默认取当月最后一天（`lunar_clamp` 默认 true）。**传 false 后遇到小月（如腊月三十）会整年跳过、不产生提醒** —— 如实告知用户，不要说成「每年都会提醒」。
- **农历日程只支持按年循环**：`calendar: "lunar"` 时 `recurrence.freq` 必须是 `yearly` 且 `interval` 必须是 `1`（省略即 1）；不要拿 interval 表达「几年一次」——农历循环不按间隔跳年。实际口径分三种，别一概说成「填了会报错」：① 显式传 `recurrence: {interval: 2}`（`add` 或 `update`）会**直接报错**；② `update` 把公历日程转成农历（`calendar: "lunar"`）但**不传** `recurrence` 时**不报错**，继承来的 interval 按 1 落库（`import:v1` 导入农历 interval>1 的旧数据同样按 1 落库，并在导入报告里给一条 warning）；③ **旧数据**（回显带「interval=N 不生效」的农历行）仍可正常编辑——改标题/备注不会被拒，也不会被顺手改写成 1，要改正循环请显式传 `recurrence`。
- **旧数据里的农历 + 非 yearly 频率**：`import:v1` 遇到 v1 农历行的 `frequency` 是 `daily`/`weekly`/`monthly` 时，因为农历引擎对任何 freq 都按农历年触发，会**改写成每年循环并给一条 warning**（文案含「无法在 v2 表达/已按每年循环导入」）——agent 读到这类 warning 必须转述给用户「原本的每日/每周/每月已变成每年」，不能只说「导入成功」。同一批里 `once`/`{}`/缺月日的农历行是**永不触发的死行**（导入报告含「不会产生任何提醒」），要么如实告知用户该日程不会提醒，要么用 `update` 显式传 `recurrence: {freq:"yearly", interval:1}` 与 `lunar_month`/`lunar_day` 把它补成能触发的日程。这些畸形行的 `update` 只改标题/备注**不会被拒**（与 ③ 同款宽容），但归一值不落库 —— 想改循环必须显式传 `recurrence`。
- `remind_offsets` 负数为提前提醒（如 [-30] 提前 30 分钟），**最多 5 项**；`resend_minutes` 是待办到点重发一次，取值 0-1440 分钟。
- 截止型日程：给待办加 `escalation`（严格升序分钟偏移数组，**首元素固定为 0**＝截止时刻本身，如 `[0,60,360,1440]`，即截止/1h/6h/24h；仅 `kind=todo` 可设）—— 到达截止后按阶梯持续加压提醒，直到 `complete`；此时 `resend_minutes` 被忽略（`update` 传 `escalation: []` 可清除阶梯）。这类日程在列表/状态页显示为「截止」。
- `workday_filter` 让日程只在法定工作日/节假日触发；节假日数据未覆盖时日程会暂停，如实告知用户。
- 完成待办用 `complete`（可带 `occurrence_key` 只完成单次——同一事件的各条提醒会一并收敛，之后不会再收到该次发生的提醒）；更新用 `update`；删除用 `delete`。
- **远期日程只保留「下一条」**：occurrence 只物化到未来 62 天；若某日程此刻一条待提醒都没有（远期生日、远期一次性待办），会额外保留 1 条越过该窗口的 occurrence。因此 `upcoming` 里远期日程只出现一条，这不是数据缺失，提醒也不会漏。
- `schedule {action:"list"}` 默认只列 `status: "active"`、最多 20 条（`status`/`limit` 可调）；`upcoming` 查「接下来要发生的事」。
- `list`/`upcoming` 里的 `下次提醒`、`提醒时间` 是 **UTC ISO**；同一对象另给 `下次提醒(本地)`/`提醒时间(本地)`（Asia/Shanghai，`YYYY-MM-DD HH:mm`）—— **向用户报时间一律用「(本地)」键**，直接读 UTC 值会差 8 小时。`list`/`upcoming`/`add`/`update` 的回执还带 `备注`、`工作日筛选`（不限/仅工作日/仅节假日）与 `重发分钟`，需要确认用户设置时直接读这些字段。
- 历史 occurrence 超 90 天由服务端自动清理（只清**已提醒/已完成/已取消**的行；`pending` 永不删；使用 `recurrence.count` 的日程整条豁免，因为次数上限依赖历史行数）。用户问「很久以前的提醒怎么查不到」时按此解释。

## 记账

- 只记支出，金额单位为元（`amount: 12.34`）。
- 账本分**家庭**与**个人**：`ledger {action:"create"}` 缺省建家庭账本（所有 Profile 可见可记账，回执/预算提醒/月报推送给所有配置了路由的 Profile）；`personal: true` 建个人账本（仅归属人可见可写，**不回执、不推预算提醒**，月报只发给归属人）。个人账本可 `ledger {action:"transfer", id, profile}` 转给其他 Profile 归属（目标 Profile 须已存在），省略 `profile` 转回家庭（**不可逆**）；**家庭账本不能转为个人账本**。非归属人访问个人账本一律得到「账本不存在」。账本名**分范围唯一**（家庭账本之间、以及每个人自己的个人账本内）；转移归属时若目标范围已有同名活跃账本会被拒绝。
- 记账前先 `ledger {action: "list"}` 取得账本 id（**只列当前 Profile 可见的账本**：家庭账本 + 自己的个人账本；**创建账本 `ledger {action:"create"}` 必须给 `name`**）；`expense` 的 `add`/`list`/`summary`/`export` 四个 action 都必须传 `ledger_id`。
- `ledger.list` 默认不含归档账本；核账时传 `include_archived: true`。
- 汇总用 `expense {action: "summary"}`，可按 `month`、`from/to`、`by`（记账人）过滤。`month`（自然月整月，含该月内已录入但尚未到来的日期）与 `from`/`to` **互斥**，同时传会报错；`from > to` 也报错。`from`/`to` **只给一边就是半边区间**（只给 `from` = `[from, 将来)` 不限上界；只给 `to` = `(过去, to]` 不限下界），与 `list` 完全一致 —— 别为了「凑一个区间」自己补另一端。只有 `month`/`from`/`to` **都不传**时才套默认区间：`summary` 是「月初 → 今天」（不含月内未来日），`list` 是不限区间。
- **「本月」有两个口径，别混**：状态页看板、预算对照、月报里的「本月」是**自然月全月**（含月内未来日 —— `spent_on` 是已录入事实，不因日历没到那天就从数字里消失）；只有 `expense summary` 不传区间时的默认值是「本月至今」。向用户报「本月花了多少」以看板/月报为准。
- 预算：`ledger {action: "budget", ledger_id}` 查看该账本全部预算与本月对照；带 `amount`（元）设置/覆盖，带 `category` 为分类预算（不传为账本总额），`clear: true` 删除该范围。预算按账本每月滚动，支出**跨越** 80%/100% 时自动提醒（同一预算一笔只推跨过的最高阈值那一条，跨月重新判定，同月同阈值不重推）；设了预算的账本月报会附预算对照行。**个人账本不推预算提醒**。
- **编辑**：`expense {action: "update", id, ...}` 可改金额/分类/备注/日期（至少传一个，id 从 `list` 取）。**编辑不触发回执、不推预算提醒**，记账人与创建时间保持不变；不支持把账目挪到另一个账本（要换账本只能删除重记）。用户说「改一下备注/金额」时用 `update`，不要用删除重记。
- **删除**：`expense {action: "delete", id}` 不可恢复，重记后「记账人」会变成当前 Profile——动手前把这两点告知用户。
- **导出**：`expense {action: "export", ledger_id, month?}` 返回 CSV 文本（**只按月导出**，传 `from`/`to` 会明确报错；默认当月，行数上限 2000，超出时带 `已截断`），家庭账本也可在状态页「导出 CSV」下载。个人账本只能通过这个 MCP action 导出（看板不展示个人账本）。CSV 是给用户保存/用 Excel 打开的，不要把整段内容粘进聊天；只转述文件名、行数与区间。
- 账本改名用 `ledger {action: "rename", id, name}`；归档/恢复用 `action: "archive"`（`unarchive: true` 恢复）；转移个人账本归属用 `action: "transfer"`（见上）。**没有删除账本的接口**——要彻底删除只能直连服务端数据库操作。
- `expense {action: "list"}` 不传 `month`/`from`/`to` 时不限区间（只受 `limit` 限制），且默认只返回 20 条：返回里 `已返回` 与 `匹配总数` 是两个数，别把窗口当全量。
- 每月 1 号 09:00 自动推送上月月报（表格），不要手动复算。

## 通知

- 静默时段内主动推送暂停，`notify.pull` 不受影响——用户说"没收到通知"时先 pull（`pull` 默认 20 条、上限 100；一次拉不完就再拉一次）。
- 推送路由配置：`notify {action: "route", url: "http://127.0.0.1:<port>/...", channel: "webhook"}`；secret 由环境变量提供，工具配置失败时检查服务端 env。`channel` 缺省 `webhook`；`channel: "log"` 只把通知写进服务端日志（本地联调，不需要 URL/secret，也不代表用户真的收到了；它会把通知标记为已读，`notify.pull` 之后不再返回）。
- **这些是服务端自动推的，不用手动查**：每日 07:00 天气简报（含补班/放假提示行与**下个假期倒计时**；节假日数据未就绪时显示「未知」而不是猜）、气象预警巡检（每 20 分钟，同预警同级别只推一次、**级别升级会再推**、降级不重推；静默时段内失效的预警不再补投，`notify.pull` 里还能看到）、调休/补班提醒（当天补班、假期首日前 N 天放假安排——N 由服务端 `WORKDAY_REMIND_DAYS_BEFORE` 配置、默认 3、假期最后一天恢复上班）、每月 1 号 09:00 月报。
- **备份也是服务端自动行为**：daemon 每日 03:00（`BACKUP_CRON`）在 `$DATA_DIR/backups` 生成快照并保留最近 14 份（`BACKUP_KEEP`），没有对应的 MCP 工具。用户要求「帮我备份」时如实说明这是定时任务，不要声称已经手动执行；需要立即备份只能由运维执行 `npm run db:backup`。
- 用户问"今天/明天要不要上班""哪天补班"时，用 `holiday {view: "is_workday", date}` 或 `view: "month"` 查准，**不要凭星期猜**。

## 输出格式

通知正文是 Markdown 表格。向用户转述时保持结构化（表格或键值对），不要把多行数据挤成一段文字。
