import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, instantToLocalDate, localToInstant, TZ } from "../../time.js";
import { ensureYears } from "../../core/holiday.js";
import { errorMessage, type NotifyBlock, type Services } from "../../core/registry.js";
import { logger } from "../../core/logger.js";
import { anniversaryMilestoneText, countdownText } from "./anniversary.js";
import {
  ESCALATION_SUFFIX,
  RESEND_SUFFIX,
  type ScheduleRow,
  escalationStepOf,
  eventPrefixOf,
  formatElapsed,
  parseEscalation,
  parseOffsets,
} from "./validate.js";
import {
  isNormalReminderKey,
  materializeSchedule,
  pausedWarned,
  recheckCrossYearOnce,
  updateNextRunAt,
  takeYearsNeedingBackfill,
} from "./materialize.js";

const CATCHUP_GRACE_MINUTES = 10;

export const REMINDER_REPLY_HINT = "做完回一句「好了」；要晚点再提醒就说「推迟半小时」";

/**
 * 提醒装饰：其它模块（如周期账 bills）给「挂在某条日程上」的提醒改标题、补表格行、换回复提示。
 * 日程模块不 import 那些模块（依赖方向只能是 bills → schedule），由对方在模块加载时注册。
 * 返回 null = 该日程与本装饰无关。装饰抛错只 warn、按原样发提醒（提醒本身绝不能因此丢）。
 */
export interface ReminderDecoration {
  title?: string;
  /** 追加在时间行之后的正文行（如周期账的「¥50 · 通讯 · 记到家庭」） */
  lines?: string[];
  /** 替换默认的 REMINDER_REPLY_HINT */
  hint?: string;
}
export type ReminderDecorator = (
  db: DatabaseSync,
  schedule: ScheduleRow,
) => ReminderDecoration | null;

const reminderDecorators: ReminderDecorator[] = [];
export function registerReminderDecorator(fn: ReminderDecorator): void {
  if (!reminderDecorators.includes(fn)) reminderDecorators.push(fn);
}

function decorationFor(db: DatabaseSync, schedule: ScheduleRow): ReminderDecoration | null {
  for (const fn of reminderDecorators) {
    try {
      const deco = fn(db, schedule);
      if (deco !== null) return deco;
    } catch (e) {
      logger.warn(
        `日程「${schedule.title}」(${schedule.id}) 提醒装饰失败，按原样发送: ${errorMessage(e)}`,
      );
    }
  }
  return null;
}

/**
 * 循环待办过了当天就作废：事件本地日期早于今天、仍未完成（pending/notified）的发生
 * 置 cancelled（与 skip 同一终态，物化不会复活）。打卡、巡检这类每日提醒没做就是没做，
 * 不该一直留在早报的「逾期未完成」里越积越多。
 *
 * 不碰：一次性待办（没有下一次，必须一直追）、截止型（设了 escalation，本来就要持续加压）、
 * 生日/纪念日（没有完成语义，提醒行到点即 notified，不进议程以外的逻辑）、
 * 以及被 snooze 到今天或以后的行（due_at 仍未过今天零点）。
 * 返回作废的行数。
 */
export function expireStaleRecurringTodos(db: DatabaseSync, at: DateTime = now()): number {
  const startOfToday = at.setZone(TZ).startOf("day").toUTC().toISO() as string;
  const targets = db
    .prepare(
      `SELECT DISTINCT o.schedule_id AS id FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE s.status = 'active' AND s.kind = 'todo' AND s.recurrence_json IS NOT NULL
         AND o.status IN ('pending','notified') AND o.event_at < ? AND o.due_at < ?`,
    )
    .all(startOfToday, startOfToday) as { id: string }[];
  let expired = 0;
  for (const { id } of targets) {
    const schedule = db.prepare("SELECT escalation_json FROM schedules WHERE id = ?").get(id) as
      | { escalation_json: string | null }
      | undefined;
    if (schedule === undefined || parseEscalation(schedule.escalation_json) !== null) continue;
    const result = db
      .prepare(
        `UPDATE occurrences SET status = 'cancelled'
         WHERE schedule_id = ? AND status IN ('pending','notified') AND event_at < ? AND due_at < ?`,
      )
      .run(id, startOfToday, startOfToday);
    expired += Number(result.changes);
    updateNextRunAt(db, id);
  }
  return expired;
}

/** 错过补发清理：每个日程只保留最近一次过期的 pending，其余取消 */
export function catchupSweep(db: DatabaseSync): void {
  const cutoff = now().minus({ minutes: CATCHUP_GRACE_MINUTES }).toUTC().toISO() ?? nowIso();
  const groups = db
    .prepare(
      `SELECT schedule_id, COUNT(*) AS n FROM occurrences
       WHERE status = 'pending' AND due_at < ? GROUP BY schedule_id HAVING n > 1`,
    )
    .all(cutoff) as { schedule_id: string }[];
  for (const g of groups) {
    const keep = db
      .prepare(
        "SELECT MAX(due_at) AS m FROM occurrences WHERE schedule_id = ? AND status = 'pending' AND due_at < ?",
      )
      .get(g.schedule_id, cutoff) as { m: string | null };
    db.prepare(
      `UPDATE occurrences SET status = 'cancelled'
       WHERE schedule_id = ? AND status = 'pending' AND due_at < ? AND due_at < ?`,
    ).run(g.schedule_id, cutoff, keep.m ?? cutoff);
  }
}

export function reminderBlocks(
  row: ScheduleRow,
  eventAt: string,
  note: string | null,
  /**
   * 手工改期（snooze）后的提醒时刻：提醒里的「时间」改用它，而不是物化时的旧快照。
   * 不传 = 常规提醒，沿用 event_at + 日程时刻（既有形状不变）。
   */
  displayAt?: string,
  /**
   * 本次提醒的本地业务日（fireDue 传触发时刻的日期）：生日/纪念日据此给「倒计时」。
   * 不传 = 不输出倒计时（既有调用方形状不变）。
   */
  today?: string,
): NotifyBlock {
  const at = DateTime.fromISO(displayAt ?? eventAt, { zone: TZ });
  const eventDate = instantToLocalDate(eventAt);
  // 手机上一眼能看完：只给「什么时候」+ 必要的补充，不再列类型/重复这类配置信息
  const when = row.all_day === 1 ? `${at.toFormat("MM-dd")} 全天` : at.toFormat("MM-dd HH:mm");
  const icon = row.kind === "todo" ? "⏰" : row.kind === "birthday" ? "🎂" : "💝";
  const extras: string[] = [];
  if (row.kind !== "todo") {
    const countdown = today === undefined ? null : countdownText(today, eventDate);
    if (countdown !== null) extras.push(countdown);
    const milestone = anniversaryMilestoneText(row, eventDate);
    if (milestone !== null) extras.push(milestone);
  }
  const lines = [`${icon} ${when}${extras.length > 0 ? `（${extras.join("，")}）` : ""}`];
  // 备注为空（NULL / 空串 / 纯空白）时整行省略，不输出空行
  if (row.note !== null && row.note.trim() !== "") lines.push(`📝 ${row.note.trim()}`);
  if (note !== null) lines.push(note);
  // 待办提醒给一句回复提示：推送不一定进入对话上下文，提示语让用户的短回复带上明确意图，
  // agent 侧对应 complete {recent:true} / snooze（见 SKILL.md「完成回执」）
  if (row.kind === "todo") lines.push(REMINDER_REPLY_HINT);
  return { notes: lines };
}

interface DueRow {
  schedule_id: string;
  occurrence_key: string;
  event_at: string;
  due_at: string;
}

/**
 * 正常提醒行的 key 形如 `<date>T<HH:MM>#<序号>`；校验其时刻是否与当前排期一致。
 * 派生行的父行不再限定 #0（见 fireDue 的派生逻辑），但仍要挡住在改 time 之后残留的旧行：
 * 旧 key 里的时刻与新排期对不上。
 */
function parentMatchesScheduleTime(key: string, time: string): boolean {
  const matched = /T(\d{2}:\d{2})#\d+$/.exec(key);
  return matched !== null && matched[1] === time;
}

/**
 * 该正常提醒行是否被手工顺延过（snooze）：其 due_at 不再等于 event_at + 偏移分钟。
 * 用「与期望值不一致」而不是新增数据库列来识别 —— 不改 schema，且 update 重排后
 * pending 行会被重建（due_at 回到期望值），不会把旧改期误判成 snooze。
 */
function isSnoozedRow(schedule: ScheduleRow, occ: DueRow): boolean {
  if (!isNormalReminderKey(occ.occurrence_key)) return false;
  const matched = /#(\d+)$/.exec(occ.occurrence_key);
  if (matched === null) return false;
  const offset = parseOffsets(schedule.remind_offsets_json)[Number(matched[1])];
  if (offset === undefined) return false;
  const expected = DateTime.fromISO(occ.event_at).plus({ minutes: offset }).toUTC().toISO();
  return expected !== occ.due_at;
}

/** 循环待办「晚上追一次」的本地时刻 */
export const EVENING_CHASE_TIME = "20:00";
/** 事件时刻离追提醒不足这么多分钟就不追（如 19:45 的提醒，20:00 再追一次没有意义） */
const EVENING_CHASE_MIN_GAP_MINUTES = 30;

/**
 * 循环待办的晚间追提醒时刻：没设 resend_minutes、没设 escalation 的循环 todo，
 * 当天 20:00 还没完成就再提醒一次。事件本身在 19:30 之后时不追。
 * 返回 UTC ISO；不适用返回 null。
 */
export function eveningChaseDue(schedule: ScheduleRow, eventAt: string): string | null {
  if (schedule.kind !== "todo" || schedule.recurrence_json === null) return null;
  if (schedule.resend_minutes > 0 || parseEscalation(schedule.escalation_json) !== null) {
    return null;
  }
  const event = DateTime.fromISO(eventAt, { zone: TZ });
  const chase = localToInstant(event.toISODate() as string, EVENING_CHASE_TIME);
  const gap = DateTime.fromISO(chase).diff(event, "minutes").minutes;
  return gap >= EVENING_CHASE_MIN_GAP_MINUTES ? chase : null;
}

/** 该日程派生行（:resend）的期望触发时刻：显式 resend_minutes 优先，否则晚间追提醒 */
function resendDueFor(schedule: ScheduleRow, eventAt: string): string | null {
  if (schedule.resend_minutes > 0) {
    return DateTime.fromISO(eventAt).plus({ minutes: schedule.resend_minutes }).toUTC().toISO();
  }
  return eveningChaseDue(schedule, eventAt);
}

/**
 * 强提醒行的触发前校验。update 会保留 pending 的 :resend 行（本意是别丢掉强提醒），
 * 但用户改了时间、把 resend_minutes 调小/归零、或该事件已被重排删除之后，旧行仍会按
 * 旧时间点打扰一次。这里按当前日程重新判定，并强制 due_at = event_at + resend_minutes。
 * 返回 null 表示该行应作废。
 */
function resendDueOrNull(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string,
  eventAt: string,
): string | null {
  if (resendDueFor(schedule, eventAt) === null) return null;
  // 当前日程已设置 escalation：resend_minutes 被忽略，遗留的 :resend 行一并作废。
  // 否则同一事件会同时收到「强提醒」与「升级链」两条「仍未完成」提醒
  // （先建 resend、后补 escalation 即可触发，复核发现的回归）。
  // 作废是终局的：之后即使再清除 escalation，本次发生的强提醒也不会复活
  // （主键已被 cancelled 行占用）——换取同一事件绝不双通知，属已知取舍。
  if (parseEscalation(schedule.escalation_json) !== null) return null;
  const eventKey = occurrenceKey.slice(0, -RESEND_SUFFIX.length);
  // key 里带着当时的提醒时刻：改了 time 之后旧 key 与新排期对不上，必须作废，
  // 否则会用旧时间点推一条「强提醒」。
  if (!parentMatchesScheduleTime(eventKey, schedule.time)) return null;
  // 父行已完成（done）时强提醒一并失效：complete 会收敛派生行，这里是第二道防线，
  // 挡住绕过 completeSchedule 直接改库把父行置 done 的路径。pending/notified 均视为在途。
  const parent = db
    .prepare(
      "SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
    )
    .get(schedule.id, eventKey);
  if (parent === undefined) return null;
  return resendDueFor(schedule, eventAt);
}

/**
 * 逾期升级行的触发前校验（与 resendDueOrNull 同构）。update 会保留 pending 的 #esc:* 行，
 * 但用户改了 time、缩短/清除了 escalation、或父事件被删/重排之后，旧行仍会按旧排期打扰一次。
 * 这里按当前日程重新判定：该步必须仍存在（1 ≤ N < escalation.length），父事件 key 必须与当前
 * time 对得上且未被取消，due_at 强制等于 event_at + escalation[N]。返回 null 表示该行应作废。
 */
function escalationDueOrNull(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string,
  eventAt: string,
): string | null {
  const step = escalationStepOf(occurrenceKey);
  if (step === null) return null;
  // 升级提醒只属于 todo（截止型）：kind 被改成生日/纪念日后遗留的 escalation_json
  // 不该继续按阶梯发（复审 T-1027-02c 指出：派生行不参与 update 的删行，这里是唯一守卫）
  if (schedule.kind !== "todo") return null;
  const escalation = parseEscalation(schedule.escalation_json);
  if (escalation === null) return null;
  // 第 0 步是截止时刻的 #0，不走此路径；#esc:N 只在第 N 个偏移仍存在时有效
  if (step < 1 || step >= escalation.length) return null;
  const suffix = `${ESCALATION_SUFFIX}${step}`;
  const parentKey = occurrenceKey.slice(0, occurrenceKey.length - suffix.length);
  // key 里带着当时的提醒时刻：改了 time 之后旧 key 与新排期对不上，必须作废
  // （父行不限定 #0，见 fireDue 的派生逻辑）。
  if (!parentMatchesScheduleTime(parentKey, schedule.time)) return null;
  // 与 resendDueOrNull 同构：父行 done（已完成）时升级行一并失效，第二道防线
  const parent = db
    .prepare(
      "SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
    )
    .get(schedule.id, parentKey);
  if (parent === undefined) return null;
  return DateTime.fromISO(eventAt)
    .plus({ minutes: escalation[step] as number })
    .toUTC()
    .toISO();
}

/** 派生一条升级行：`<parentKey>#esc:<step>`，due_at = event_at + escalation[step]；已存在则忽略 */
function insertEscalation(
  db: DatabaseSync,
  scheduleId: string,
  parentKey: string,
  eventAt: string,
  step: number,
  escalation: number[],
): void {
  const due = DateTime.fromISO(eventAt).plus({ minutes: escalation[step] as number });
  db.prepare(
    `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(
    scheduleId,
    `${parentKey}${ESCALATION_SUFFIX}${step}`,
    eventAt,
    due.toUTC().toISO() ?? eventAt,
  );
}

function cancelOccurrence(db: DatabaseSync, occ: DueRow): void {
  db.prepare(
    "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ?",
  ).run(occ.schedule_id, occ.occurrence_key);
}

/**
 * 该事件前缀下是否已存在某类派生行（`:resend` 或 `#esc:N`）。
 * 用 JS 前缀匹配而不是 LIKE：数据损坏时 key 里可能混入 %/_（LIKE 通配符）误伤。
 */
function hasDerivedRow(
  db: DatabaseSync,
  scheduleId: string,
  eventPrefix: string,
  suffix: string,
): boolean {
  const head = `${eventPrefix}#`;
  const rows = db
    .prepare("SELECT occurrence_key FROM occurrences WHERE schedule_id = ?")
    .all(scheduleId) as { occurrence_key: string }[];
  return rows.some((r) => r.occurrence_key.startsWith(head) && r.occurrence_key.includes(suffix));
}

/** 到点触发提醒；返回发布的条数 */
export async function fireDue(db: DatabaseSync, services: Services, at: DateTime): Promise<number> {
  const cutoff = at.toUTC().toISO() ?? nowIso();
  const due = db
    .prepare(
      `SELECT o.schedule_id, o.occurrence_key, o.event_at, o.due_at
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE o.status = 'pending' AND o.due_at <= ? AND s.status = 'active'
       ORDER BY o.due_at LIMIT 50`,
    )
    .all(cutoff) as unknown as DueRow[];
  let published = 0;
  for (const occ of due) {
    try {
      const schedule = db.prepare("SELECT * FROM schedules WHERE id = ?").get(occ.schedule_id) as
        | ScheduleRow
        | undefined;
      if (schedule === undefined) continue;
      const isResend = occ.occurrence_key.endsWith(RESEND_SUFFIX);
      const isEscalation = !isResend && escalationStepOf(occ.occurrence_key) !== null;
      let dueAt = occ.due_at;
      if (isResend) {
        const expected = resendDueOrNull(db, schedule, occ.occurrence_key, occ.event_at);
        if (expected === null) {
          cancelOccurrence(db, occ);
          continue;
        }
        if (expected !== occ.due_at) {
          db.prepare(
            "UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?",
          ).run(expected, occ.schedule_id, occ.occurrence_key);
          if (expected > cutoff) continue; // 校正后尚未到点，本轮不推
          dueAt = expected;
        }
      } else if (isEscalation) {
        const expected = escalationDueOrNull(db, schedule, occ.occurrence_key, occ.event_at);
        if (expected === null) {
          cancelOccurrence(db, occ);
          continue;
        }
        if (expected !== occ.due_at) {
          db.prepare(
            "UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?",
          ).run(expected, occ.schedule_id, occ.occurrence_key);
          if (expected > cutoff) continue; // 校正后尚未到点，本轮不推
          dueAt = expected;
        }
      }
      const lateMinutes = at.diff(DateTime.fromISO(dueAt), "minutes").minutes;
      const note = isEscalation
        ? `（截止已过 ${formatElapsed(occ.event_at, at)}，仍未完成）`
        : isResend
          ? schedule.resend_minutes > 0
            ? "（强提醒：以上事项仍未完成）"
            : "（晚间再提醒一次：还没做的话记得做）"
          : lateMinutes > CATCHUP_GRACE_MINUTES
            ? `（补发：该提醒已错过约 ${Math.round(lateMinutes)} 分钟）`
            : null;
      // 手工顺延（snooze）过的正常提醒行：通知里的「时间」取新的 due_at（而不是物化时的
      // 旧 event_at 快照）；dedupeKey 也带上 due_at，否则同一 occurrence_key 的二次提醒
      // 会被 outbox 的 (profile_id, dedupe_key) 唯一约束当成重复静默吞掉。
      const snoozed = !isResend && !isEscalation && isSnoozedRow(schedule, occ);
      const dedupeKey = snoozed
        ? `sched:${schedule.id}:${occ.occurrence_key}@${occ.due_at}`
        : `sched:${schedule.id}:${occ.occurrence_key}`;
      const blocks = reminderBlocks(
        schedule,
        occ.event_at,
        note,
        snoozed ? occ.due_at : undefined,
        at.setZone(TZ).toISODate() ?? undefined,
      );
      const deco = schedule.kind === "todo" ? decorationFor(db, schedule) : null;
      if (deco !== null) {
        if (deco.lines !== undefined && deco.lines.length > 0) {
          const [first, ...rest] = blocks.notes ?? [];
          blocks.notes = first === undefined ? deco.lines : [first, ...deco.lines, ...rest];
        }
        if (deco.hint !== undefined) {
          const hint = deco.hint;
          blocks.notes = (blocks.notes ?? []).map((n) => (n === REMINDER_REPLY_HINT ? hint : n));
        }
      }
      await services.publishProfile(schedule.profile_id, {
        kind: "schedule.reminder",
        title: deco?.title ?? schedule.title,
        blocks,
        dedupeKey,
      });
      published += 1;
      db.prepare(
        "UPDATE occurrences SET status = 'notified' WHERE schedule_id = ? AND occurrence_key = ?",
      ).run(occ.schedule_id, occ.occurrence_key);
      const escalation = parseEscalation(schedule.escalation_json);
      if (isEscalation) {
        const step = escalationStepOf(occ.occurrence_key);
        if (escalation !== null && step !== null && step + 1 < escalation.length) {
          const suffix = `${ESCALATION_SUFFIX}${step}`;
          const parentKey = occ.occurrence_key.slice(0, occ.occurrence_key.length - suffix.length);
          insertEscalation(db, schedule.id, parentKey, occ.event_at, step + 1, escalation);
        }
      } else if (!isResend && schedule.kind === "todo") {
        // 派生「未完成加压」行：升级阶梯下一步 / 到点重发。
        // 锚点从固定的 #0 放宽为「该事件的任意正常提醒行」：晚录入或停机跨过事件时刻时，
        // catchupSweep 会取消 #0、只保留更晚的偏移行，死守 #0 会让阶梯/重发永不启动
        // （README 承诺「到达截止时刻后按阶梯依次重发……直到 complete 才停」）。
        // 同一事件只允许一条链条：hasDerivedRow 去重，避免 #1 再派生一份。
        const eventPrefix = eventPrefixOf(occ.occurrence_key);
        if (eventPrefix !== null) {
          if (escalation !== null) {
            // 设置了阶梯：派生出 #esc:1；resend_minutes 被忽略
            // （要么按阶梯加压，要么只重发一次，同一事件不该收到两条「仍未完成」）
            if (
              escalation.length > 1 &&
              !hasDerivedRow(db, schedule.id, eventPrefix, ESCALATION_SUFFIX)
            ) {
              insertEscalation(db, schedule.id, occ.occurrence_key, occ.event_at, 1, escalation);
            }
          } else {
            // 「到点后 N 分钟重发」或循环待办的晚间追提醒，都以事件时刻为基准
            // （用 due_at 会被偏移的提前量带偏）
            const resendDue = resendDueFor(schedule, occ.event_at);
            if (resendDue !== null && !hasDerivedRow(db, schedule.id, eventPrefix, RESEND_SUFFIX)) {
              db.prepare(
                `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
                 VALUES (?, ?, ?, ?, 'pending')`,
              ).run(schedule.id, `${occ.occurrence_key}${RESEND_SUFFIX}`, occ.event_at, resendDue);
            }
          }
        }
      }
    } catch (e) {
      // 逐行隔离：一条脏数据/一次意外失败只影响该行（occurrence 保持 pending，下一轮重试），
      // 不能让整个 tick 停摆 —— 否则所有日程的提醒与物化都会一起冻结。
      logger.warn(
        `日程提醒处理失败（该行保留 pending，下轮重试）: ${occ.schedule_id}/${occ.occurrence_key}: ${errorMessage(e)}`,
      );
    }
  }
  return published;
}

export async function tickSchedules(
  at: DateTime,
  services: Services,
  db: DatabaseSync,
  fetchYear?: (url: string) => Promise<unknown>,
): Promise<void> {
  catchupSweep(db);
  const expired = expireStaleRecurringTodos(db, at);
  if (expired > 0) logger.info(`循环待办过期作废 ${expired} 条（前一天及更早未完成的发生）`);
  await fireDue(db, services, at);
  const active = db
    .prepare("SELECT * FROM schedules WHERE status = 'active'")
    .all() as unknown as ScheduleRow[];
  // 删除/取消的日程不会再进入 materialize，其告警去重记录需在这里回收
  const activeIds = new Set(active.map((r) => r.id));
  for (const id of [...pausedWarned.keys()]) {
    if (!activeIds.has(id)) pausedWarned.delete(id);
  }
  for (const row of active) {
    // 逐行隔离：一条脏数据（如 recurrence_json 非法）不能带走整批物化。
    // 曾经这里直接抛出，结果是该行之后的**所有**日程都不再产生 occurrence，
    // 且每分钟重复抛错，直到有人手改数据库。
    try {
      materializeSchedule(db, row);
    } catch (e) {
      logger.warn(`日程「${row.title}」(${row.id}) 物化失败，已跳过: ${errorMessage(e)}`);
    }
  }
  // 物化撞到的未就绪年份：收尾时尝试补齐。ensureYears 自带 6h 冷却
  // （cn_holiday_years.status='failed' + last_attempt_at），失败不会每分钟重试。
  const years = takeYearsNeedingBackfill();
  if (years.length > 0) {
    try {
      const result = await ensureYears(db, years, fetchYear);
      if (result.failed.length > 0) {
        logger.warn(`日程物化补齐节假日数据失败: ${result.failed.join("; ")}`);
      }
    } catch (e) {
      logger.warn(`日程物化补齐节假日数据异常: ${errorMessage(e)}`);
    }
  }
  // P2-5 / C-06 ②：跨年区间（12-25~12-31）的权威分类来自下一年度文件。数据就绪后，
  // 把此前按星期兜底物化的 pending 行按新 dayType 复核一次（每进程每个年度一次）。
  // 放在 ensureYears 之后：本轮刚抓回来的数据必须参与复核，否则要等下一分钟。
  try {
    recheckCrossYearOnce(db);
  } catch (e) {
    logger.warn(`跨年节假日复核异常: ${errorMessage(e)}`);
  }
}
