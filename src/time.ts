import { DateTime } from "luxon";

/** v2 全部调度固定单时区，DST 相关复杂度不存在 */
export const TZ = "Asia/Shanghai";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function now(): DateTime {
  return DateTime.now().setZone(TZ);
}

/** UTC 瞬间，形如 2026-09-11T04:00:00.000Z，数据库统一存这种 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地日历日，形如 2026-09-11 */
export function todayIso(): string {
  return now().toISODate() as string;
}

export function isDate(value: string): boolean {
  return DATE_RE.test(value) && DateTime.fromISO(value, { zone: TZ }).isValid;
}

export function isTime(value: string): boolean {
  return TIME_RE.test(value);
}

/** 本地日历日 + 本地时刻 → UTC 瞬间 */
export function localToInstant(date: string, time: string): string {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: TZ });
  if (!dt.isValid) throw new Error(`本地时间不合法: ${date} ${time}`);
  return dt.toUTC().toISO() as string;
}

export function instantToLocalDate(iso: string): string {
  return DateTime.fromISO(iso, { zone: TZ }).toISODate() as string;
}

/** 跨午夜静默窗口判断：start=end 视为未配置 */
export function inQuietWindow(value: { start: string; end: string } | null | undefined, at: DateTime = now()): boolean {
  if (!value || !isTime(value.start) || !isTime(value.end) || value.start === value.end) return false;
  const minutes = at.hour * 60 + at.minute;
  const start = quietMinutes(value.start);
  const end = quietMinutes(value.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function quietMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}
