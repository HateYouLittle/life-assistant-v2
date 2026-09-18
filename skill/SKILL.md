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
| 实时天气 / 预报 / 预警 / 设置位置 | `weather {view}` |
| 空气质量（国标 AQI） | `air_quality` |
| 下一假期 / 某月安排 / 某日是否上班 | `holiday {view}` |
| 待办、生日、纪念日提醒（公历+农历） | `schedule {action}` |
| 账本管理 | `ledger {action}` |
| 记一笔支出 / 明细 / 汇总 / 删除记错的一笔 | `expense {action}` |
| 拉通知 / 静默时段 / 推送路由 / 取消推送 | `notify {action}` |

硬性边界：

- 不要用 LLM cron 或其它机制伪造定时任务；所有确定性提醒走 `schedule`。
- `holiday` 数据未覆盖的日期返回"未知"，绝不按星期猜测调休。
- 不要虚构工具之外的能力（油价、共享账本角色、快递等 v1 能力已移除）。
- 只操作当前 Profile 的日程与通知；账本为所有 Profile 共享。

## 天气与位置

- 用户首次问天气时：`weather {view: "locate", city}` 让用户确认城市；已设置则直接用。
- `city` 参数可选；缺省用该 Profile 已设位置或服务端默认城市。
- 数据源为 QWeather：配额用尽或键缺失时工具返回明确错误，如实转告，不要编造数据。
- 简报（如用户问"今天穿什么"）：综合 current + air + 预报提示；标注数据来源时间。

## 日程

- 生日/纪念日默认按年循环；`calendar: "lunar"` 需给 `lunar_month/lunar_day`（1-12 / 1-30）。
- 农历日越界（如腊月三十缺失）默认取当月最后一天（`lunar_clamp` 默认 true）。
- `remind_offsets` 负数为提前提醒（如 [-30] 提前 30 分钟）；`resend_minutes` 是待办到点重发一次。
- `workday_filter` 让日程只在法定工作日/节假日触发；节假日数据未覆盖时日程会暂停，如实告知用户。
- 完成待办用 `complete`（可带 `occurrence_key` 只完成单次）；更新用 `update`；删除用 `delete`。
- **远期日程只保留「下一条」**：occurrence 只物化到未来 62 天；若某日程此刻一条待提醒都没有（远期生日、远期一次性待办），会额外保留 1 条越过该窗口的 occurrence。因此 `upcoming` 里远期日程只出现一条，这不是数据缺失，提醒也不会漏。
- 历史 occurrence 超 90 天由服务端自动清理（只清已提醒/已完成/已取消的行，未触发的永不删）。用户问「很久以前的提醒怎么查不到」时按此解释。

## 记账

- 只记支出，金额单位为元（`amount: 12.34`）。
- 账本全局共享：任何 Profile 创建/记账/汇总均可，回执与月报会推送给所有配置了路由的 Profile。
- 记账前先 `ledger {action: "list"}` 取得账本 id；`expense` 的 `add`/`list`/`summary` 三个 action 都必须传 `ledger_id`。
- `ledger.list` 默认不含归档账本；核账时传 `include_archived: true`。
- 汇总用 `expense {action: "summary"}`，可按 `month`、`from/to`、`by`（记账人）过滤。
- **没有编辑功能**：改金额/分类/备注只能 `expense {action: "delete", id}`（id 从 `list` 取）再重新 `add`。删除**不可恢复**，且重记后「记账人」会变成当前 Profile——动手前把这两点告知用户。用户说「改一下备注/金额」时按此处理，不要声称可以直接改。
- 账本改名用 `ledger {action: "rename", id, name}`；归档/恢复用 `action: "archive"`（`unarchive: true` 恢复）。**没有删除账本的接口**——要彻底删除只能直连服务端数据库操作。
- `expense {action: "list"}` 的 `month` 只覆盖当月，且默认只返回 20 条：返回里 `已返回` 与 `匹配总数` 是两个数，别把窗口当全量。
- 每月 1 号 09:00 自动推送上月月报（表格），不要手动复算。

## 通知

- 静默时段内主动推送暂停，`notify.pull` 不受影响——用户说"没收到通知"时先 pull。
- 推送路由配置：`notify {action: "route", url: "http://127.0.0.1:<port>/..."}`；secret 由环境变量提供，工具配置失败时检查服务端 env。

## 输出格式

通知正文是 Markdown 表格。向用户转述时保持结构化（表格或键值对），不要把多行数据挤成一段文字。
