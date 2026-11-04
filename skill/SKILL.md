---
name: life-assistant
description: 个人生活助理：天气/空气质量/节假日调休/日程提醒（公历+农历）/完成回执/支出记账/周期账/通知
read_when:
  - 用户问天气、空气、预警、穿衣出行建议
  - 用户问节假日、调休、某天是否上班
  - 用户想设提醒、待办、生日、纪念日（含农历）
  - 用户说某件事做完了/搞定了/打了/交了，或回一句「好了」
  - 用户想记账、查支出、看这个月/这周花了多少
  - 用户提到通知、静默时段、推送设置
---

# Life Assistant

工具前缀 `mcp_life_assistant_`：`weather`、`air_quality`、`holiday`、`schedule`、`ledger`、`expense`、`bill`、`notify`。参数名统一用 `action`。

## 通用规则

- 会话开始先调一次 `notify {action:"pull"}`，有未读就转告用户，没有就不提。
- 定时提醒只走 `schedule`，不要用 LLM cron 或别的机制。
- 工具报错时照实转述错误文案。错误文案本身就说明了该怎么改，不要编造工具没有的能力（油价、快递等都没有）。
- 报时间一律用回执里带「(本地)」的键，不带的是 UTC。
- 写操作重试时带同一个 `request_id`，服务端会回 `已存在: true`，不要再建一条。
- 服务端会自动推送早报（07:00）、晚报（21:00）、到点提醒、气象预警和调休提醒。这些不用你手动查，也不要重复播报。

## 天气

| 用户说 | 调用 |
|---|---|
| 今天/现在天气怎么样 | `weather {action:"current"}` |
| 这几天/周末天气 | `weather {action:"forecast"}`（`days` 只能 3 或 7） |
| 有没有预警 | `weather {action:"alert"}` |
| 空气怎么样 | `air_quality` |
| 我住在上海 | `weather {action:"locate", city:"上海"}` |
| 下周去成都出差 | `weather {action:"set", city:"成都", start, end}`；`show`/`clear` 查看或取消 |

- `city` 可省略，服务端按「出行计划 > 已设位置 > 默认城市」解析。
- 转述时带上回执里的「更新时间 / 数据获取时间」。配额用尽或没配 key 时如实说明，不要编数据。

## 节假日

- 「哪天放假 / 下个假期」→ `holiday {action:"next"}`。回执里 `进行中: true` 表示正在放假。
- 「明天上不上班 / 哪天补班」→ `holiday {action:"is_workday", date}` 或 `{action:"month"}`。
- 返回「未知」就说数据还没发布，**不要按星期猜**。

## 日程与提醒

**新建**：`schedule {action:"add", title, date, time}`。

- 默认是一次性待办、09:00。
- 循环用 `recurrence: {freq:"daily"|"weekly"|"monthly"|"yearly", interval}`。
- 生日和纪念日用 `kind:"birthday"|"anniversary"`，默认每年一次，并会提前 7 天、前 1 天、当天各提醒一次。
- `calendar:"lunar"` 时要给 `lunar_month`、`lunar_day`。
- 农历日程只支持按年循环：显式传 `recurrence: {interval: 2}` 这类非 1 的间隔会直接报错；旧数据（回显带「interval=N 不生效」）仍可正常编辑。
- 只在工作日或节假日提醒，加 `workday_filter:"workday"|"holiday"`。

**查看**：

- 「接下来有什么事」→ `{action:"upcoming"}`。
- 「我设了哪些提醒」→ `{action:"list"}`。
- 改用 `update`，删用 `delete`。

**循环待办的规则**（巡检、打卡这类）：

- 到点推送一次。当天 20:00 还没完成，会再推一条「晚间再提醒一次」。
- 过了当天没完成的自动作废，不算逾期，也不会出现在第二天的早报里。

## 完成回执（最常用）

用户说「好了 / 打了 / 交了 / 搞定了 / 巡检做了」，是在回复刚才的提醒，不是让你新建日程。**不要先 list 再自己挑**：

1. 话里有事项关键词 → `schedule {action:"complete", match:"巡检"}`；说的是别的日子，再加 `date`。
2. 只说「好了」→ `schedule {action:"complete", recent:true}`，匹配**今天**已推送、还没处理的提醒。不要反问用户指哪件。
3. 对话里有 `[Webhook delivery: life-…]` 开头的提醒原文时，用它的标题作 `match`。

按回执的 `结果` 回复用户：

- `已完成` → 「好的，<标题> 已完成」。一次性待办 `状态` 为 done 时，说这件事结束了。
- `多个候选` → 列出标题和时间，让用户选。选定后用 `id` + `occurrence_key` 调 `complete`。
- `已处理` → 之前已经标记过了。
- `未找到` → 如实说没找到，可以问要不要新建，但不要擅自 `add`。

「推迟半小时 / 晚点提醒」→ 用同一个 `id` 调 `snooze {minutes:30}`；「这次不做了」→ `skip`。
日常回执**永远不要**用 `all:true`，它会结束整个系列。

## 记账

- 「记一笔 / 午饭 35」→ `expense {action:"add", amount:35, category:"餐饮"}`。
  - `ledger_id` 可省略：有默认账本或只有一个账本时直接记。报错列出候选时，问用户记哪本，或用 `expense {action:"set_default_ledger", ledger_id}` 设默认。
  - 没说分类时，可以拿回执里的「常用分类」问一句，但不要替用户填。
- 「这个月花了多少」→ `expense {action:"summary"}`，默认整个自然月。「上个月」传 `month:"YYYY-MM"`，「这周」传 `from`/`to`。
- 「看看明细」→ `expense {action:"list"}`。默认 20 条，`匹配总数` 才是全量。
- 「记错了，改成 40」→ `update {id, amount:40}`；「删掉那笔」→ `delete {id}`。删除不可恢复，动手前告诉用户。
- 「导出」→ `export {month}`。CSV 不要贴进聊天，只说文件名和行数。
- 账本分家庭（共享）和个人（`ledger {action:"create", name, personal:true}`）。
- 预算：`ledger {action:"budget", amount}` 设置，不传 `amount` 是查看。预算只做对照，不会推送提醒。

## 周期账（话费、会员、物业费）

- 「每月交话费 50，提醒我」→ `bill {action:"add", name:"话费", amount:50, category:"通讯", date:"<下次到期日>"}`。不要另建日程。
- 到期会推「该交话费了」。用户回「交了」→ `bill {action:"pay", match:"话费"}`，这一步同时完成提醒并入账；同一期重复调用只记一笔。
- 停用和恢复用 `pause`/`resume`，历史入账不受影响。

## 通知

- 「没收到提醒」→ 先 `notify {action:"pull"}`，再 `notify {action:"history"}` 查投递状态，失败的用 `retry`。
- 「晚上别打扰」→ `notify {action:"quiet_hours", start:"23:00", end:"07:00"}`；`clear:true` 取消。
- 「不想收某类推送」→ `notify {action:"prefs", kind:"weather.alert", push:false}`。关掉后通知仍入库，pull 能取到。
- 「测一下推送」→ `notify {action:"test"}`。
- 备份和恢复是服务端定时任务加运维 CLI（`npm run db:backup` / `db:restore`），没有对应工具，不要说你已经执行了。
