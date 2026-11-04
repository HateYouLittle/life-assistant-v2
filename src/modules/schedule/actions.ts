import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, todayIso, instantToLocalDate, TZ } from "../../time.js";
import { collapseLunarInterval, recurrenceDeclaresCount } from "../../core/recurrence.js";
import { errorMessage, type ToolContext } from "../../core/registry.js";
import { withTransaction } from "../../core/database.js";
import { ensureProfile } from "../../core/settings.js";
import { logger } from "../../core/logger.js";
import {
  ESCALATION_SUFFIX,
  RESEND_SUFFIX,
  SNOOZE_MAX_MINUTES,
  type ScheduleInput,
  type ScheduleRow,
  TIME_RE,
  eventPrefixOf,
  expiredOneOff,
  expiredOneOffError,
  newShortId,
  normalizeInheritedRecurrence,
  parseEscalation,
  parseOffsets,
  parseRecurrence,
  validateRemindOffsets,
  validateRequestId,
  validateScheduleInput,
} from "./validate.js";
import {
  getSchedule,
  insertSchedule,
  isNormalReminderKey,
  latestInterruptedEvent,
  materializeSchedule,
  updateNextRunAt,
} from "./materialize.js";

/**
 * 单次发生被「完成」之后的回调（schedule complete 的单次路径，含 match/recent 与一键链接）。
 * 返回值合并进 complete 回执；null = 无关。由工具层调用，服务层的 completeSchedule 不触发。
 */
export interface OccurrenceCompletedEvent {
  db: DatabaseSync;
  ctx: ToolContext;
  schedule: ScheduleRow;
  occurrenceKey: string;
  /** 本次发生的事件时刻（UTC ISO） */
  eventAt: string;
}
export type CompletionHook = (event: OccurrenceCompletedEvent) => Record<string, unknown> | null;

const completionHooks: CompletionHook[] = [];

export function registerCompletionHook(fn: CompletionHook): void {
  if (!completionHooks.includes(fn)) completionHooks.push(fn);
}

/** 依次跑完成回调，合并各回调的回执字段；单个回调抛错由回调自己负责转成回执（这里兜底 warn） */
export function runCompletionHooks(event: OccurrenceCompletedEvent): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const fn of completionHooks) {
    try {
      const extra = fn(event);
      if (extra !== null) merged = { ...merged, ...extra };
    } catch (e) {
      logger.warn(`日程完成回调失败（完成本身已生效）: ${event.schedule.id}: ${errorMessage(e)}`);
    }
  }
  return merged;
}

export function createSchedule(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  clientToken: string | null = null,
): ScheduleRow {
  validateScheduleInput(input);
  // 服务层再收口一道 remind_offsets 边界（MCP 有 zod，quick 直接走工具层绕过了它）。
  validateRemindOffsets(input.remindOffsets);
  // P2-3：一次性日程的开始日期早于今天时，物化永远产不出 occurrence（游标从昨天起、
  // 引擎只产出严格晚于游标的日期）。此前这种写入会「成功」但 0 提醒、永久 active ——
  // 纯静默失败；现在明确 fail，并给出可操作的改法（改日期 / 改循环）。
  const expired = expiredOneOff(input);
  if (expired !== null) throw expiredOneOffError(expired);
  ensureProfile(db, profileId);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newShortId();
    try {
      // 插入与首次物化同事务：物化失败（规则不可满足等）时整体回滚，
      // 不留「报错但日程已入库」的半成品 —— 用户重试会造出第二条同名日程。
      withTransaction(db, () => {
        insertSchedule(db, profileId, input, id, clientToken);
        const created = getSchedule(db, profileId, id);
        if (created === undefined) throw new Error("日程创建后读取失败");
        materializeSchedule(db, created);
      });
      return getSchedule(db, profileId, id) as ScheduleRow;
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        // request_id 撞上已有行是**幂等命中**而不是瞬时 id 冲突：立刻抛出，
        // 由 createScheduleIdempotent 查回原日程；继续重试只会换 id 再撞同一个键。
        if (clientToken !== null && e.message.includes("client_token")) throw e;
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("日程创建失败");
}

export interface CreateScheduleOutcome {
  row: ScheduleRow;
  /** true = 同 request_id 的重复调用，返回的是首次创建的原日程（未重建 occurrence、未重复提醒） */
  existed: boolean;
}

/** 按 (profile_id, client_token) 查回首次创建的日程；跨 Profile 天然隔离 */
export function getScheduleByClientToken(
  db: DatabaseSync,
  profileId: string,
  clientToken: string,
): ScheduleRow | undefined {
  return db
    .prepare("SELECT * FROM schedules WHERE profile_id = ? AND client_token = ?")
    .get(profileId, clientToken) as ScheduleRow | undefined;
}

/**
 * 带幂等键的创建：MCP 超时/网络抖动后 agent 用同一 request_id 重试时，
 * 返回首次创建的**原日程**（并标记 existed），不重建 occurrence、不重复发提醒。
 * 先查后插；并发窗口里撞唯一索引（idx_schedules_client_token）再查回，两步都走索引。
 */
export function createScheduleIdempotent(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  requestId: string | null,
): CreateScheduleOutcome {
  if (requestId === null) return { row: createSchedule(db, profileId, input), existed: false };
  validateRequestId(requestId);
  const existing = getScheduleByClientToken(db, profileId, requestId);
  if (existing !== undefined) return { row: existing, existed: true };
  try {
    return { row: createSchedule(db, profileId, input, requestId), existed: false };
  } catch (e) {
    if (e instanceof Error && e.message.includes("client_token")) {
      const row = getScheduleByClientToken(db, profileId, requestId);
      if (row !== undefined) return { row, existed: true };
    }
    throw e;
  }
}

export interface SchedulePatch extends Partial<Omit<ScheduleInput, "calendar" | "remindOffsets">> {
  calendar?: "solar" | "lunar";
  /** null 与 undefined 同义：未提供，沿用库里的历史值 */
  remindOffsets?: number[] | null;
  status?: "active" | "done" | "cancelled";
}

export function updateSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  patch: SchedulePatch,
): ScheduleRow {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  // 只有**本次显式传入**的 remind_offsets 才做完整边界校验（quick 绕过 MCP schema 的
  // 路径主要走 create；update 的显式值同样要收口）。未传时沿用库里的历史值，
  // 存量脏数据（越界/多余项）不能被无关 patch 卡死 —— validateScheduleInput 里的
  // 「最多 5 个」长度检查保持不变，这里只补范围/整数/非空。
  // `null` 与 `undefined` 一样按「未提供」处理（JSON 里很常见）：旧实现直接取
  // `.length` 抛内部 TypeError，且下方 `??` 本来就把 null 当未提供 —— 校验必须先对齐。
  if (patch.remindOffsets !== undefined && patch.remindOffsets !== null) {
    validateRemindOffsets(patch.remindOffsets);
  }
  // 归一只服务校验：写回时仍用 inheritedRecurrence 的原值（用户设的 interval 不能被
  // 一次无关的 patch 顺手改掉）。patch 显式传了 recurrence 的按显式值校验。
  const inheritedRecurrence = parseRecurrence(row.recurrence_json);
  const merged: ScheduleInput = {
    title: patch.title ?? row.title,
    note: patch.note !== undefined ? patch.note : row.note,
    kind: patch.kind ?? row.kind,
    calendar: patch.calendar ?? row.calendar,
    startDate: patch.startDate !== undefined ? patch.startDate : row.start_date,
    lunarMonth: patch.lunarMonth !== undefined ? patch.lunarMonth : row.lunar_month,
    lunarDay: patch.lunarDay !== undefined ? patch.lunarDay : row.lunar_day,
    leapPolicy: patch.leapPolicy !== undefined ? patch.leapPolicy : (row.leap_policy ?? "follow"),
    lunarClamp: patch.lunarClamp !== undefined ? patch.lunarClamp : row.lunar_clamp === 1,
    time: patch.time ?? row.time,
    allDay: patch.allDay !== undefined ? patch.allDay : row.all_day === 1,
    recurrence: patch.recurrence !== undefined ? patch.recurrence : inheritedRecurrence,
    remindOffsets: patch.remindOffsets ?? parseOffsets(row.remind_offsets_json),
    resendMinutes: patch.resendMinutes ?? row.resend_minutes,
    escalation:
      patch.escalation !== undefined ? patch.escalation : parseEscalation(row.escalation_json),
    workdayFilter: patch.workdayFilter ?? row.workday_filter,
  };
  if (patch.status !== undefined && !["active", "done", "cancelled"].includes(patch.status)) {
    throw new Error(`状态不合法: ${String(patch.status)}`);
  }
  const status = patch.status ?? row.status;
  if (status === "active" && row.status === "done" && row.kind === "todo") {
    throw new Error("已完成的待办不能重新激活");
  }
  // patch 未显式传 recurrence 时，校验用归一值（存量农历 interval>1 与引擎行为等价，
  // 不该把这类行卡到连改名都不行）。
  validateScheduleInput({
    ...merged,
    recurrence:
      patch.recurrence === undefined
        ? normalizeInheritedRecurrence(merged.calendar, merged.recurrence)
        : merged.recurrence,
  });
  // 落库前的农历 interval 收口（写入侧单一收口，见 core/recurrence.ts）：
  // **只有本次 patch 新造出「农历+interval>1」的行**（solar→lunar 转换且没显式传
  // recurrence）才把 interval 收敛为 1 —— 校验看到的是归一值、落库若写回原值就会
  // 绕过写入侧拒错，造出引擎根本不读的 interval。
  // 对**既有**脏数据（本来就是农历、interval>1）的无关 patch（改标题/备注）仍原样
  // 保真：那次写入没造脏数据，且 describeRecurrence 的「interval=N 不生效」提示正
  // 靠它继续成立（见 N5 用例）。故收口条件要求「本次确实把日历改成了农历」。
  const storedRecurrence =
    patch.recurrence === undefined && patch.calendar === "lunar" && row.calendar !== "lunar"
      ? collapseLunarInterval(merged.calendar, merged.recurrence)
      : merged.recurrence;
  // 只有「会影响物化结果」的字段真的变了才删行 + 重建：只改标题/备注/类型时保留既有
  // occurrence 行（尤其 snooze 过的 due_at —— 删掉后按原始偏移重建会静默丢失顺延，
  // P1-1 的第二个症状）。
  const materializationAffected =
    (patch.time !== undefined && merged.time !== row.time) ||
    (patch.allDay !== undefined && merged.allDay !== (row.all_day === 1)) ||
    (patch.calendar !== undefined && merged.calendar !== row.calendar) ||
    (patch.startDate !== undefined && (merged.startDate ?? null) !== row.start_date) ||
    (patch.lunarMonth !== undefined && merged.lunarMonth !== row.lunar_month) ||
    (patch.lunarDay !== undefined && merged.lunarDay !== row.lunar_day) ||
    (patch.leapPolicy !== undefined &&
      (merged.leapPolicy ?? "follow") !== (row.leap_policy ?? "follow")) ||
    (patch.lunarClamp !== undefined && merged.lunarClamp !== (row.lunar_clamp === 1)) ||
    (patch.remindOffsets !== undefined &&
      JSON.stringify(merged.remindOffsets) !== row.remind_offsets_json) ||
    patch.recurrence !== undefined ||
    (patch.workdayFilter !== undefined && merged.workdayFilter !== row.workday_filter) ||
    (patch.status !== undefined && status !== row.status);
  // P2-3：update 不得走成第二条静默路径。本次写入会删 pending 行（materializationAffected）
  // 而新日期又是「一次性 + 已过期」时，删掉的正是这条日程**唯一的待发提醒**，且重物化永远
  // 产不出替代行 —— 静默丢失。此时明确 fail，并给出可操作的改法。
  // 无关 patch（只改标题/备注等不动物化的字段）不在此列：既有 pending 提醒原样保留，不做
  // 无谓阻断；把日期改回今天或之后、改成循环、或显式置 done/cancelled 收尾，也都不受影响
  // （前两者合并后不再是「过期一次性」，后者 status 已不是 active）。
  if (status === "active" && materializationAffected) {
    const expired = expiredOneOff(merged);
    if (expired !== null) throw expiredOneOffError(expired);
  }
  const ts = nowIso();
  withTransaction(db, () => {
    // 必须在 DELETE 之前取锚点：删除 pending 行后「最近一个 notified 事件还有 pending
    // 兄弟」的信息就没了（2026-10-27 P1-1：此前用 MAX(event_at) 判定，被 62 天前瞻
    // 的全 pending 行带偏，导致当天兄弟提醒与 snooze 被删后不再重建）。
    const rewindFrom = materializationAffected ? latestInterruptedEvent(db, id) : null;
    db.prepare(
      `UPDATE schedules SET title = ?, note = ?, kind = ?, calendar = ?, start_date = ?, lunar_month = ?,
         lunar_day = ?, leap_policy = ?, lunar_clamp = ?, time = ?, all_day = ?, recurrence_json = ?,
         remind_offsets_json = ?, resend_minutes = ?, escalation_json = ?, workday_filter = ?, status = ?,
         version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      merged.title.trim(),
      merged.note ?? null,
      merged.kind,
      merged.calendar,
      merged.calendar === "solar" ? (merged.startDate ?? null) : null,
      merged.calendar === "lunar" ? (merged.lunarMonth ?? null) : null,
      merged.calendar === "lunar" ? (merged.lunarDay ?? null) : null,
      merged.calendar === "lunar" ? (merged.leapPolicy ?? "follow") : null,
      merged.calendar === "lunar" ? (merged.lunarClamp === false ? 0 : 1) : 1,
      merged.time,
      merged.allDay ? 1 : 0,
      storedRecurrence === null ? null : JSON.stringify(storedRecurrence),
      JSON.stringify(merged.remindOffsets),
      merged.resendMinutes,
      merged.escalation === null ? null : JSON.stringify(merged.escalation),
      merged.workdayFilter,
      status,
      ts,
      id,
    );
    if (materializationAffected) {
      // 保留 :resend 与 #esc:* 行：它们的有效性由 fireDue 的触发前校验按当前排期判定
      // （改了 time/escalation、父事件被删/重排时在触发前作废），不能在这里一律删掉。
      db.prepare(
        `DELETE FROM occurrences WHERE schedule_id = ? AND status = 'pending'
           AND occurrence_key NOT LIKE '%' || ? AND occurrence_key NOT LIKE '%' || ?`,
      ).run(id, RESEND_SUFFIX, `${ESCALATION_SUFFIX}%`);
      // 更新与重物化同事务：物化失败整体回滚，不留「报错但改动已生效」；
      // rewind 从「最近一个进行中事件」回退，补回被删掉的兄弟偏移行。
      const updated = getSchedule(db, profileId, id) as ScheduleRow;
      materializeSchedule(db, updated, rewindFrom === null ? {} : { rewind: true, rewindFrom });
    }
  });
  return getSchedule(db, profileId, id) as ScheduleRow;
}

export interface CompleteOptions {
  /**
   * 结束整个系列（含循环日程）。循环日程裸调 complete（既无 occurrence_key 又不传 all）
   * 一律拒绝：不带 key 的「完成」会终止整条循环，而用户点「完成」绝大多数只想完成这一次。
   */
  all?: boolean;
}

export function completeSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  occurrenceKey: string | null,
  opts: CompleteOptions = {},
): ScheduleRow {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无需完成`);
  // 循环判定只看「是否声明了 recurrence」：recurrence_json 损坏时也按循环处理
  // （保守：无法解析时宁可要求显式 all=true，也不能一次误点清空整个系列）。
  const recurring = row.recurrence_json !== null;
  if (occurrenceKey === null && recurring && opts.all !== true) {
    throw new Error(
      "循环日程需带 occurrence_key 完成单次；结束整个系列请显式传 all=true。" +
        "可用 occurrence 列表从 schedule list 的「待办发生」或 schedule upcoming 获取。",
    );
  }
  if (occurrenceKey !== null) {
    const result = db
      .prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')`,
      )
      .run(id, occurrenceKey);
    if (result.changes !== 1) throw new Error(`occurrence 不存在或已结束: ${occurrenceKey}`);
    // 同一事件的所有提醒行一并终结：`<前缀>#0..#4` 每个偏移一行，另有派生行
    // `:resend` 与 `#esc:N`。只按给定 key 收敛派生行会漏掉兄弟偏移 ——
    // 用提前 30 分钟那条（#0）完成后，正点那条（#1）仍会再推一次；
    // 反过来用 #1 完成时，锚在 #0 上的升级阶梯会继续推「仍未完成」。
    const eventPrefix = eventPrefixOf(occurrenceKey);
    if (eventPrefix === null) {
      // 脏 key（不符合 `<前缀>#<序号>` 形态）：退化为只收敛以该 key 为前缀的派生行
      db.prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND (occurrence_key = ? || '${RESEND_SUFFIX}'
                OR substr(occurrence_key, 1, length(?) + ${ESCALATION_SUFFIX.length}) = ? || '${ESCALATION_SUFFIX}')`,
      ).run(id, occurrenceKey, occurrenceKey, occurrenceKey);
    } else {
      // 派生 key 都以事件前缀开头；用 substr 前缀比较而不是 LIKE，
      // 避免 key 中的 %/_ 被当成通配符误伤
      db.prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND substr(occurrence_key, 1, ?) = ?`,
      ).run(id, eventPrefix.length + 1, `${eventPrefix}#`);
    }
    // 一次性待办：它只有这一次发生，完成该次就等于完成整条日程（与裸调 complete 对齐）。
    // 此前这里只把 occurrence 置 done、日程仍停在 active：回执写着「已完成」，但该待办
    // 永远留在 list 里、再无提醒，用户没有任何收尾入口（裸调 complete 才会转 done）。
    // 循环日程不能这么做（只完成当前一次、系列继续），损坏的 recurrence_json 按循环处理。
    if (row.recurrence_json === null && row.kind === "todo") {
      db.prepare("UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ?").run(
        nowIso(),
        id,
      );
    }
  } else {
    db.prepare(
      `UPDATE occurrences SET status = 'done'
       WHERE schedule_id = ? AND status IN ('pending','notified')`,
    ).run(id);
    if (row.kind === "todo") {
      db.prepare("UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ?").run(
        nowIso(),
        id,
      );
    }
  }
  // P2-1 / C-02：all=true 是「结束整个系列」的唯一显式入口，必须对**任意 kind** 真的置终态。
  // 旧实现只在 kind==='todo' 时置 done，于是生日/纪念日 all=true 后回执写「已完成」而
  // status 仍是 active —— 下一轮 tick 继续物化下一年（实测 birthday yearly 会重建 2027 那次），
  // 与工具描述「结束整个系列请显式传 all=true」直接矛盾。终态口径与 P2-2 逐字一致：只有 done。
  // 裸调 complete（无 key、无 all）不在改动范围：一次性待办的收尾仍走上面 kind==='todo' 的分支。
  if (opts.all === true) {
    db.prepare("UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ?").run(
      nowIso(),
      id,
    );
  }
  updateNextRunAt(db, id);
  return getSchedule(db, profileId, id) as ScheduleRow;
}

interface OccurrenceRow {
  occurrence_key: string;
  event_at: string;
  due_at: string;
  status: "pending" | "notified" | "done" | "cancelled";
}

function getOccurrence(
  db: DatabaseSync,
  scheduleId: string,
  occurrenceKey: string,
): OccurrenceRow | undefined {
  return db
    .prepare(
      `SELECT occurrence_key, event_at, due_at, status FROM occurrences
       WHERE schedule_id = ? AND occurrence_key = ?`,
    )
    .get(scheduleId, occurrenceKey) as OccurrenceRow | undefined;
}

/**
 * 缺省目标：该日程「最早未完成」的普通提醒行（pending/notified）。
 * 不取派生行的原因同上；同一事件有多个偏移行时取 due_at 最早的那条，
 * 它才是这次发生对用户最先可见的提醒。
 */
function earliestUnfinishedOccurrence(
  db: DatabaseSync,
  scheduleId: string,
): OccurrenceRow | undefined {
  const rows = db
    .prepare(
      `SELECT occurrence_key, event_at, due_at, status FROM occurrences
       WHERE schedule_id = ? AND status IN ('pending','notified')
       ORDER BY due_at, event_at`,
    )
    .all(scheduleId) as unknown as OccurrenceRow[];
  return rows.find((row) => isNormalReminderKey(row.occurrence_key));
}

function resolveDisposalTarget(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string | null,
): OccurrenceRow {
  if (occurrenceKey !== null) {
    const occ = getOccurrence(db, schedule.id, occurrenceKey);
    if (occ === undefined) throw new Error(`occurrence 不存在: ${occurrenceKey}`);
    return occ;
  }
  const occ = earliestUnfinishedOccurrence(db, schedule.id);
  if (occ === undefined) {
    throw new Error(`日程「${schedule.title}」没有未完成的提醒可处置（可能已完成或已取消）`);
  }
  return occ;
}

/** 该日程剩余未完成的发生次数（按事件前缀去重；同一事件的多个提醒行只算一次） */
function countUnfinishedEvents(db: DatabaseSync, scheduleId: string): number {
  const rows = db
    .prepare(
      "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? AND status IN ('pending','notified')",
    )
    .all(scheduleId) as { occurrence_key: string }[];
  const events = new Set(
    rows.map((row) => eventPrefixOf(row.occurrence_key) ?? row.occurrence_key),
  );
  return events.size;
}

/** snooze/skip 的写路径与 updateSchedule 同口径：version 自增 + updated_at 前进 */
function touchSchedule(db: DatabaseSync, scheduleId: string): void {
  db.prepare("UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?").run(
    nowIso(),
    scheduleId,
  );
}

/** 未完成的「待办发生」：按事件前缀去重，供 list 回执给 agent 拿 occurrence_key */
export interface PendingOccurrence {
  occurrence_key: string;
  event_at: string;
  due_at: string;
}

export function pendingOccurrences(
  db: DatabaseSync,
  scheduleId: string,
  limit: number,
): PendingOccurrence[] {
  const rows = db
    .prepare(
      `SELECT occurrence_key, event_at, due_at FROM occurrences
       WHERE schedule_id = ? AND status IN ('pending','notified')
       ORDER BY event_at, due_at, occurrence_key`,
    )
    .all(scheduleId) as unknown as OccurrenceRow[];
  const seen = new Set<string>();
  const items: PendingOccurrence[] = [];
  for (const row of rows) {
    const event = eventPrefixOf(row.occurrence_key) ?? row.occurrence_key;
    if (seen.has(event)) continue;
    seen.add(event);
    items.push({
      occurrence_key: row.occurrence_key,
      event_at: row.event_at,
      due_at: row.due_at,
    });
    if (items.length >= limit) break;
  }
  return items;
}

export interface SnoozeOptions {
  /** 指定单次发生；缺省取该日程最早未完成的普通提醒行 */
  occurrenceKey?: string | null;
  /** 从现在起（原提醒更晚时从原提醒时刻起）顺延的分钟数，1-10080 */
  minutes?: number | null;
  /** 绝对时刻 HH:mm：解析为下一个该本地时刻 */
  until?: string | null;
}

export interface SnoozeOutcome {
  row: ScheduleRow;
  occurrenceKey: string;
  /** 顺延后的提醒时刻（UTC ISO，与 occurrences.due_at 同值） */
  dueAt: string;
}

/**
 * 把一次发生的提醒顺延（snooze）：
 * - 只改该行的 due_at 并重置为 pending，事件本身（event_at）不动；
 * - fireDue 按新 due_at 触发，并把通知里的时间显示改为 due_at（见 reminderBlocks 的 displayAt）；
 * - 物化用 INSERT OR IGNORE，tick 不会覆盖这一行；
 * - 通知 dedupeKey 带 due_at 后缀（见 fireDue），否则同 key 的二次提醒会被 outbox 去重吞掉。
 */
export function snoozeSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  opts: SnoozeOptions,
): SnoozeOutcome {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无法推迟提醒`);
  const hasMinutes = opts.minutes !== null && opts.minutes !== undefined;
  const hasUntil = opts.until !== null && opts.until !== undefined;
  if (hasMinutes === hasUntil) throw new Error("snooze 需要且只能提供 minutes 或 until 之一");
  const target = resolveDisposalTarget(db, row, opts.occurrenceKey ?? null);
  if (target.status === "done" || target.status === "cancelled") {
    throw new Error(
      `occurrence ${target.occurrence_key} 已是${target.status === "done" ? "完成" : "取消"}状态，不能 snooze`,
    );
  }
  if (!isNormalReminderKey(target.occurrence_key)) {
    throw new Error(
      `snooze 只支持普通提醒行（occurrence_key 形如 <日期>T<时刻>#N）；${target.occurrence_key} 是派生提醒行，请对同一事件的原提醒行操作`,
    );
  }
  let newDue: DateTime;
  if (hasMinutes) {
    const minutes = opts.minutes as number;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SNOOZE_MAX_MINUTES) {
      throw new Error(`snooze 的 minutes 需为 1-${SNOOZE_MAX_MINUTES} 的整数（分钟）`);
    }
    const at = now();
    // 「顺延」的基准取 max(现在, 原提醒)：未到点的提醒按原时刻后移，
    // 已经到点/提醒过的则从此刻起算，避免推迟到一个仍然过期的时刻。
    const original = DateTime.fromISO(target.due_at, { zone: TZ });
    const base = original > at ? original : at;
    newDue = base.plus({ minutes });
  } else {
    const until = opts.until as string;
    if (!TIME_RE.test(until)) throw new Error(`snooze 的 until 不合法: ${until}（需为 HH:mm）`);
    const [hour, minute] = until.split(":").map(Number) as [number, number];
    const at = now();
    let next = at.set({ hour, minute, second: 0, millisecond: 0 });
    // 「下一个该时刻」：今天这个点已过（或正好是现在）就落到明天
    if (next <= at) next = next.plus({ days: 1 });
    newDue = next;
  }
  const dueAt = newDue.toUTC().toISO() as string;
  withTransaction(db, () => {
    db.prepare(
      "UPDATE occurrences SET due_at = ?, status = 'pending' WHERE schedule_id = ? AND occurrence_key = ?",
    ).run(dueAt, id, target.occurrence_key);
    touchSchedule(db, id);
    updateNextRunAt(db, id);
  });
  return {
    row: getSchedule(db, profileId, id) as ScheduleRow,
    occurrenceKey: target.occurrence_key,
    dueAt,
  };
}

export interface SkipOutcome {
  row: ScheduleRow;
  occurrenceKey: string;
  /** 跳过这次发生之后，该日程剩余未完成的发生次数（按事件去重） */
  remaining: number;
  /**
   * 本次 skip 是否同时把整条日程收尾（status → done）。仅一次性待办为 true：
   * 它没有「下一次」，跳过这一次就是整条待办结束，回执必须如实说明（见 skipSchedule）。
   */
  ended: boolean;
}

/**
 * 跳过单次发生：把该事件的提醒行（含同事件的兄弟偏移与派生行）置为 cancelled。
 *
 * 重复系列只动 occurrence 行、不改 schedules.status —— 系列继续，下一次仍会照常物化/提醒。
 * cancelled 是终态：materialize 的 INSERT OR IGNORE 不会复活它，catchupSweep 只碰 pending。
 *
 * 一次性待办（recurrence_json 为空）例外：它没有「下一次」，跳过这一次就是整条待办结束，
 * 因此同时把 schedules.status 置为 done —— 与 complete 对同形态日程的终态完全一致
 * （completeSchedule 对 recurrence_json=null 的 todo 同样置 done，不引入第三种半终态）。
 * 此前只置 occurrence=cancelled 而日程仍 active：物化撞上 cancelled 行永不重建、next_run_at
 * 变 NULL，该待办永留 active 列表、不再提醒，complete 又报「已结束」，只剩 all=true/delete
 * 能收尾 —— 而回执只写「已跳过」，与真实状态不符。
 */
export function skipSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  occurrenceKey: string | null,
): SkipOutcome {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无法跳过提醒`);
  const target = resolveDisposalTarget(db, row, occurrenceKey);
  if (target.status === "done" || target.status === "cancelled") {
    throw new Error(
      `occurrence ${target.occurrence_key} 已是${target.status === "done" ? "完成" : "取消"}状态，无需跳过`,
    );
  }
  const eventPrefix = eventPrefixOf(target.occurrence_key);
  // 与 completeSchedule 的终态判定逐字对齐（recurrence_json === null && kind === 'todo'）：
  // 两条路径必须得出同一个终态，否则「跳过」和「完成」会对同一条待办给出不同收尾。
  const ended = row.recurrence_json === null && row.kind === "todo";
  let remaining = 0;
  withTransaction(db, () => {
    if (eventPrefix === null) {
      // 脏 key（不符合事件前缀形态）：只能取消它自己
      db.prepare(
        "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
      ).run(id, target.occurrence_key);
    } else {
      // 同一事件的各偏移行与派生行一并取消，否则兄弟偏移仍会再推一次
      db.prepare(
        `UPDATE occurrences SET status = 'cancelled'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND substr(occurrence_key, 1, ?) = ?`,
      ).run(id, eventPrefix.length + 1, `${eventPrefix}#`);
    }
    touchSchedule(db, id);
    if (ended) {
      db.prepare("UPDATE schedules SET status = 'done' WHERE id = ?").run(id);
    }
    updateNextRunAt(db, id);
    remaining = countUnfinishedEvents(db, id);
  });
  return {
    row: getSchedule(db, profileId, id) as ScheduleRow,
    occurrenceKey: target.occurrence_key,
    remaining,
    ended,
  };
}

export function deleteSchedule(db: DatabaseSync, profileId: string, id: string): void {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  withTransaction(db, () => {
    // recurrence.count 的次数上限依赖历史 occurrence 行数：删掉它们会让
    // 「删除后重新激活」的循环复活（与 occurrence 清理/保留策略同一豁免口径）。
    // 取消状态已能阻止 fireDue/materialize 继续触发，保留行没有行为副作用。
    if (!recurrenceDeclaresCount(row.recurrence_json)) {
      db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(id);
    }
    db.prepare("UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      nowIso(),
      id,
    );
  });
}

/** 「按描述完成」的候选：一个事件（同一事件的多条提醒行只算一次） */
export interface CompletionCandidate {
  schedule: ScheduleRow;
  occurrenceKey: string;
  eventAt: string;
  dueAt: string;
}

export type CompletionResolution =
  | { kind: "single"; candidate: CompletionCandidate }
  | { kind: "candidates"; candidates: CompletionCandidate[] }
  | { kind: "already"; schedule: ScheduleRow; eventDate: string }
  | { kind: "none"; reason: string };

export interface CompletionQuery {
  /** 标题/备注关键词（子串匹配） */
  match?: string | null;
  /** match 模式的目标本地日期，缺省今天 */
  date?: string | null;
  /** recent 模式：今天（本地日）已推送、尚未处理的提醒 */
  recent?: boolean | null;
}

const MAX_COMPLETION_CANDIDATES = 10;

/** 按事件前缀去重，代表行优先取普通提醒行、其次 due_at 最早 */
function groupByEvent(
  rows: (OccurrenceRow & { schedule_id: string })[],
): Map<string, OccurrenceRow & { schedule_id: string }> {
  const chosen = new Map<string, OccurrenceRow & { schedule_id: string }>();
  for (const row of rows) {
    const key = `${row.schedule_id}|${eventPrefixOf(row.occurrence_key) ?? row.occurrence_key}`;
    const prev = chosen.get(key);
    if (
      prev === undefined ||
      (!isNormalReminderKey(prev.occurrence_key) && isNormalReminderKey(row.occurrence_key))
    ) {
      chosen.set(key, row);
    }
  }
  return chosen;
}

/**
 * 「用户口头说做完了」的服务端定位（替代 agent 自己 list → 匹配 → 挑 key 的多步流程）。
 *
 * - match：在该 Profile 的 active 日程里按标题/备注子串匹配，取**本地日期 = date（缺省今天）**
 *   的未完成发生；一次性日程在未显式给 date 时不限日期（「取消酒店订单搞定了」的事件可能在未来）。
 *   匹配到日程但当天那次已完成 → already（如实告知，不重复操作）。
 * - recent：不需要任何关键词，取**今天**（本地零点起）**已推送（notified）且未处理**的提醒。
 *   昨天及更早的循环待办已被 expireStaleRecurringTodos 作废，不会被拿来凑数。
 *   用于推送没有进入对话上下文、用户只回一句「交了 / 巡检过了」的场景。
 *
 * 只读：真正的完成仍由调用方走 completeSchedule（同一套事件前缀收敛与一次性收尾语义）。
 */
export function resolveCompletionTarget(
  db: DatabaseSync,
  profileId: string,
  query: CompletionQuery,
): CompletionResolution {
  const match = query.match?.trim() ?? "";
  const hasMatch = match !== "";
  const hasRecent = query.recent === true;
  if (hasMatch === hasRecent) throw new Error("按描述完成需要且只能提供 match 或 recent 之一");

  if (hasRecent) {
    const since = now().startOf("day").toUTC().toISO() as string;
    const rows = db
      .prepare(
        `SELECT o.schedule_id, o.occurrence_key, o.event_at, o.due_at, o.status
         FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
         WHERE s.profile_id = ? AND s.status = 'active' AND o.status = 'notified'
           AND o.due_at >= ? AND o.due_at <= ?
         ORDER BY o.due_at DESC`,
      )
      .all(profileId, since, nowIso()) as unknown as (OccurrenceRow & { schedule_id: string })[];
    // 同一事件若还有未推送的兄弟行（如 #1 尚 pending）也照样算这一个事件；已 done 的事件
    // 不会出现在 notified 里（completeSchedule 按前缀整体收敛）。
    const candidates = toCandidates(db, profileId, groupByEvent(rows));
    if (candidates.length === 0) {
      return { kind: "none", reason: "今天没有已推送且未处理的提醒" };
    }
    return candidates.length === 1
      ? { kind: "single", candidate: candidates[0] as CompletionCandidate }
      : { kind: "candidates", candidates: candidates.slice(0, MAX_COMPLETION_CANDIDATES) };
  }

  const explicitDate = query.date !== null && query.date !== undefined;
  const date = explicitDate ? (query.date as string) : todayIso();
  const schedules = db
    .prepare(
      `SELECT * FROM schedules
       WHERE profile_id = ? AND status = 'active'
         AND (instr(lower(title), lower(?)) > 0 OR instr(lower(COALESCE(note, '')), lower(?)) > 0)
       ORDER BY created_at`,
    )
    .all(profileId, match, match) as unknown as ScheduleRow[];
  if (schedules.length === 0)
    return { kind: "none", reason: `没有标题或备注包含「${match}」的进行中日程` };

  const picked = new Map<string, OccurrenceRow & { schedule_id: string }>();
  let already: { schedule: ScheduleRow; eventDate: string } | null = null;
  for (const schedule of schedules) {
    const rows = (
      db
        .prepare(
          `SELECT occurrence_key, event_at, due_at, status FROM occurrences
           WHERE schedule_id = ? ORDER BY event_at, due_at, occurrence_key`,
        )
        .all(schedule.id) as unknown as OccurrenceRow[]
    ).map((row) => ({ ...row, schedule_id: schedule.id }));
    const oneOffAnyDate = schedule.recurrence_json === null && !explicitDate;
    const onDate = rows.filter((row) => oneOffAnyDate || instantToLocalDate(row.event_at) === date);
    const open = onDate.filter((row) => row.status === "pending" || row.status === "notified");
    if (open.length === 0) {
      if (already === null && onDate.some((row) => row.status === "done")) {
        already = { schedule, eventDate: date };
      }
      continue;
    }
    // 一次性日程不限日期时取最早那次；其余情况当天的发生按事件去重
    for (const [key, row] of groupByEvent(open)) {
      picked.set(key, row);
      if (oneOffAnyDate) break;
    }
  }
  const candidates = toCandidates(db, profileId, picked);
  if (candidates.length === 1)
    return { kind: "single", candidate: candidates[0] as CompletionCandidate };
  if (candidates.length > 1) {
    return { kind: "candidates", candidates: candidates.slice(0, MAX_COMPLETION_CANDIDATES) };
  }
  if (already !== null) return { kind: "already", ...already };
  return {
    kind: "none",
    reason: `「${match}」相关日程在 ${date} 没有待完成的发生`,
  };
}

function toCandidates(
  db: DatabaseSync,
  profileId: string,
  grouped: Map<string, OccurrenceRow & { schedule_id: string }>,
): CompletionCandidate[] {
  const out: CompletionCandidate[] = [];
  for (const row of grouped.values()) {
    const schedule = getSchedule(db, profileId, row.schedule_id);
    if (schedule === undefined) continue;
    out.push({
      schedule,
      occurrenceKey: row.occurrence_key,
      eventAt: row.event_at,
      dueAt: row.due_at,
    });
  }
  return out;
}
