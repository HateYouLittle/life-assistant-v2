import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../../config.js";
import { dayType, holidayDayName, holidayPeriods, nextHolidayPeriod } from "../../core/holiday.js";
import { logger } from "../../core/logger.js";
import { publishProfile } from "../../core/notify.js";
import type { LocationInfo, WeatherAlert } from "../../core/qweather.js";
import { airQuality, alerts, currentWeather, forecast } from "../../core/qweather.js";
import { errorMessage, type NotifyBlock, runtime } from "../../core/registry.js";
import { listProfiles } from "../../core/settings.js";
import { localToInstant, now, TZ, todayIso } from "../../time.js";
import {
  type AgendaItem,
  agendaForDate,
  type UpcomingSpecialDay,
  upcomingSpecialDays,
} from "../schedule/service.js";
import { addDays, calendarDaysBetween, resolveProfilePlace, type TravelPlan } from "./place.js";

/**
 * 推送面向手机：早报/晚报都是 3–4 行纯文本，没有内容的行整行省略（不写「无」「未知」）。
 * 只在真正需要行动时才多说一句（带伞、补班、预警），平常日子不加废话。
 */

/** 简报里预警的极简描述：`大风蓝色预警` */
function briefAlertText(alert: WeatherAlert): string {
  return `${alert.type}${alert.level.trim()}预警`;
}

/** 今天/明天是否要补班或放假（数据 unknown 时不猜，返回 null） */
function holidayLine(db: DatabaseSync, date: string, label: "今天" | "明天"): string | null {
  const type = dayType(db, date);
  if (type === "workday") {
    const name = holidayDayName(db, date);
    return name === null ? null : `🗓 ${label}要补班（${name}调休）`;
  }
  if (type === "holiday") {
    const period = holidayPeriods(db).find((candidate) => candidate.start === date);
    if (period !== undefined) {
      return `🎉 ${label}开始放假：${period.name}，共 ${period.days} 天`;
    }
  }
  return null;
}

/** 下个假期在 7 天内才提一句；进行中的假期不提（用户自己知道在放假） */
const HOLIDAY_COUNTDOWN_DAYS = 7;

function holidayCountdownLine(db: DatabaseSync, today: string): string | null {
  const period = nextHolidayPeriod(db, today);
  if (period === null || period.inProgress) return null;
  const daysLeft = calendarDaysBetween(today, period.start);
  if (daysLeft <= 1 || daysLeft > HOLIDAY_COUNTDOWN_DAYS) return null;
  return `🗓 ${period.name}还有 ${daysLeft} 天`;
}

/** 日程行最多列出的条数；超出只报「等 N 项」，避免一条通知被日程撑爆 */
const AGENDA_LIMIT = 4;

/** 日程条目的紧凑文本：全天日程不给时刻 */
function agendaItemText(item: AgendaItem): string {
  return item.all_day ? item.title : `${item.time} ${item.title}`;
}

function agendaLine(prefix: string, items: AgendaItem[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, AGENDA_LIMIT).map(agendaItemText);
  const more = items.length > AGENDA_LIMIT ? ` 等 ${items.length} 项` : "";
  return `${prefix}${shown.join("、")}${more}`;
}

/**
 * 日程行：只列「这一天」的待办与提醒，不列逾期 —— 循环待办过了当天已自动作废，
 * 剩下的逾期只有一次性/截止型待办，那些由各自的提醒与升级链负责追，不在简报里重复。
 * 查询失败只跳过该行，绝不让整份简报失败。
 */
function agendaLineFor(
  db: DatabaseSync,
  profileId: string,
  date: string,
  prefix: string,
): string | null {
  try {
    const items = agendaForDate(db, profileId, date).filter(
      (item) => item.event_date === date && item.kind === "todo",
    );
    return agendaLine(prefix, items);
  } catch (e) {
    logger.warn(`简报：日程行已跳过（${profileId}）: ${errorMessage(e)}`);
    return null;
  }
}

/** 近期纪念日单条：`周六 妈妈生日（还有 3 天）`；今天的写「今天」 */
function specialDayLabel(item: UpcomingSpecialDay): string {
  const when = item.days_left === 0 ? "今天" : `还有 ${item.days_left} 天`;
  const extra = item.milestone === null ? "" : `，${item.milestone}`;
  return `${item.title}（${when}${extra}）`;
}

/** 早报只提 7 天内的生日/纪念日；14 天的窗口在手机上太远，说了也记不住 */
const SPECIAL_DAY_BRIEF_DAYS = 7;

/** 生日/纪念日行：窗口内没有就整行省略 */
export function specialDayNotes(items: UpcomingSpecialDay[]): string[] {
  if (items.length === 0) return [];
  return [`🎂 ${items.map(specialDayLabel).join("；")}`];
}

function specialDayLineFor(db: DatabaseSync, profileId: string, today: string): string[] {
  try {
    return specialDayNotes(
      upcomingSpecialDays(db, profileId, today).filter(
        (item) => item.days_left <= SPECIAL_DAY_BRIEF_DAYS,
      ),
    );
  } catch (e) {
    logger.warn(`每日简报：生日/纪念日行已跳过（${profileId}）: ${errorMessage(e)}`);
    return [];
  }
}

/** 天气一行：`☀ 北京 晴 3~14°C，空气良`，后面按需追加带伞/温差/预警/污染提醒 */
function weatherLine(opts: {
  city: string;
  travel: TravelPlan | null;
  text: string | null;
  tMin: number | null;
  tMax: number | null;
  aqiCategory: string | null;
  tips: string[];
}): string {
  const parts: string[] = [];
  const where = opts.travel === null ? opts.city : `${opts.city}（出行中）`;
  const temp = opts.tMin === null || opts.tMax === null ? "" : ` ${opts.tMin}~${opts.tMax}°C`;
  parts.push(`${where} ${opts.text ?? ""}${temp}`.replace(/\s+/g, " ").trim());
  if (opts.aqiCategory !== null) parts.push(`空气${opts.aqiCategory}`);
  const tips = opts.tips.length > 0 ? `；${opts.tips.join("，")}` : "";
  return `${weatherIcon(opts.text)} ${parts.join("，")}${tips}`;
}

function weatherIcon(text: string | null): string {
  if (text === null) return "🌤";
  if (/雷/.test(text)) return "⛈";
  if (/雪/.test(text)) return "🌨";
  if (/雨/.test(text)) return "🌧";
  if (/雾|霾|沙|尘/.test(text)) return "🌫";
  if (/阴/.test(text)) return "☁";
  if (/云/.test(text)) return "⛅";
  if (/晴/.test(text)) return "☀";
  return "🌤";
}

/**
 * 预警缓存 TTL 与巡检间隔对齐（P1-9）。
 *
 * 预警巡检默认 `*\/20 * * * *`，而 qweather.alerts 固定 10 分钟 TTL：每 20 分钟一轮里
 * 上一轮写入的缓存早已过期，各地每轮都要重新出网 —— 上游请求量被放大约 3 倍
 * （真实用量采样 76–84 次/日，占 QWeather 配额的大头）。这里把 TTL 取
 * 「巡检间隔 + 30s 余量」：下一轮巡检必定落在缓存有效期内；30s 余量用于容忍
 * cron 触发/响应落地比整点略晚，否则同一轮可能刚好在过期瞬间穿透缓存。
 *
 * 复杂表达式（固定时刻、小时段等）的实际间隔无法静态推导，回退 15 分钟：
 * 宁可多花一点配额，也不能把 TTL 算短 —— 算短才是真正放大请求。
 * `* * * * *` 单独返回 90s（下一轮 60s 后触发，同样留 30s 余量）。
 */
export function alertCacheTtlMs(config: Pick<ResolvedConfig, "alertWatchCron">): number {
  const cron = config.alertWatchCron.trim();
  if (cron === "* * * * *") return 90_000;
  // 只认「分钟位为 `*\/N`、其余四位为 `*`」的严格形态：混合写法（如 `*\/20 8-20 * * *`）
  // 的间隔随小时变化，静态推导会给出偏小的 TTL，反而放大请求。
  const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyMinutes !== null) {
    const n = Number(everyMinutes[1]);
    // 分钟位合法范围是 1..59；0/越界是配置层不该放行的值，回退而不是抛错。
    if (Number.isInteger(n) && n >= 1 && n <= 59) return n * 60_000 + 30_000;
  }
  return 15 * 60_000;
}

type Runtime = ReturnType<typeof runtime>;

interface ProfilePlaceContext {
  rt: Runtime;
  host: string;
  key: string;
  profileId: string;
  cityCache: Map<string, LocationInfo>;
}

/**
 * 早报/晚报/预警巡检共用骨架：检查 QWeather 配置（缺失则 warn 并返回）→ `prepare`
 * （遍历前的一次性预备，返回 null 即中止）→ 建 cityCache → 按 listProfiles 逐个 Profile
 * 执行 `run`，每个 Profile 各自 try/catch（失败只记日志，不影响其它 Profile）。
 */
async function forEachProfilePlace<P>(opts: {
  skipLog: string;
  failLog: (profileId: string, e: unknown) => void;
  prepare?: (rt: Runtime) => P | null;
  run: (ctx: ProfilePlaceContext, prepared: P) => Promise<void>;
}): Promise<void> {
  const rt = runtime();
  if (rt.config.qweatherHost === undefined || rt.config.qweatherKey === undefined) {
    logger.warn(opts.skipLog);
    return;
  }
  const host = rt.config.qweatherHost;
  const key = rt.config.qweatherKey;
  const prepared = opts.prepare === undefined ? (undefined as P) : opts.prepare(rt);
  if (prepared === null) return;
  const cityCache = new Map<string, LocationInfo>();
  for (const profileId of listProfiles(rt.db)) {
    try {
      await opts.run({ rt, host, key, profileId, cityCache }, prepared);
    } catch (e) {
      opts.failLog(profileId, e);
    }
  }
}

/**
 * 每日简报：确定性组装，无 LLM；单边数据失败用另一侧，全部失败不发送。
 *
 * `at` = 这次运行对应的**参考时刻**：cron/手动调用传当前时刻（缺省 now()），
 * 启动补发则传「错过的那次原定触发时刻」。`DAILY_BRIEF_CRON` 是可配置项，配到 18:00
 * 之后时 6 小时补发窗口会跨午夜：若仍按 now() 取业务日，凌晨补发会写入「新一天」的
 * dedupeKey 并吞掉当晚的正常简报（与 B1 是同一缺陷的另一半）。
 */
export async function runDailyBrief(at?: DateTime): Promise<void> {
  await forEachProfilePlace({
    skipLog: "每日简报跳过：未配置 QWeather",
    failLog: (profileId, e) => logger.error(`每日简报失败 ${profileId}: ${errorMessage(e)}`),
    // 业务日锚定参考时刻：简报里的「今日日程/下个假期/假期提示」与 dedupeKey 都用它。
    // 预警缓存与巡检间隔对齐（P1-9）：早报与巡检共用同一缓存键，若这里按固定 10 分钟
    // 写缓存，会让随后那一轮巡检重新出网；用同一个 TTL 口径让两次自动查询共享结果。
    prepare: (rt) => ({
      calendarToday: (at ?? now()).toISODate() ?? todayIso(),
      alertTtlMs: alertCacheTtlMs(rt.config),
    }),
    // 覆盖所有已知 Profile，而不只是配置了推送路由的：publishProfile 明确「即使无路由
    // 也保留，供 notify.pull 兜底」，只发给有路由的 Profile 会让纯 pull 型 Profile
    // 永远收不到简报。
    run: async ({ rt, host, key, profileId, cityCache }, { calendarToday, alertTtlMs }) => {
      // 与工具查询同一解析口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY。
      // saved location 直接复用（含显式选定时的 lat/lon/cityId）：按城市名重新 Geo 查询
      // 会重新取「第一个同名结果」，可能偏离用户选定的位置，也会多消耗 GeoAPI 配额。
      const place = await resolveProfilePlace(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        cityCache,
        calendarToday,
      );
      const loc = place.loc;
      const [cur, fc, air, alertList] = await Promise.all([
        currentWeather(rt.db, host, key, loc).catch(() => null),
        forecast(rt.db, host, key, loc, 7).catch(() => null),
        airQuality(rt.db, host, key, loc).catch(() => null),
        alerts(rt.db, host, key, loc, alertTtlMs).catch(() => null),
      ]);
      if (cur === null && fc === null) {
        logger.warn(`每日简报跳过 ${profileId}(${loc.city})：天气与预报均失败`);
        return;
      }
      const today = fc?.[0];
      const tips: string[] = [];
      if (alertList !== null && alertList.length > 0) {
        tips.push(`有${alertList.map(briefAlertText).join("、")}`);
      }
      if (today?.precipMm !== undefined && today.precipMm > 0) tips.push("带伞");
      if (today !== undefined && today.tMax - today.tMin >= 10) tips.push("温差大");
      if (air !== null && air.aqi > 150) tips.push("少出门");
      const notes: string[] = [
        weatherLine({
          city: loc.city,
          travel: place.travel,
          text: today?.textDay ?? cur?.text ?? null,
          tMin: today?.tMin ?? null,
          tMax: today?.tMax ?? null,
          aqiCategory: air?.category ?? null,
          tips,
        }),
      ];
      const agenda = agendaLineFor(rt.db, profileId, calendarToday, "📌 今天：");
      if (agenda !== null) notes.push(agenda);
      notes.push(...specialDayLineFor(rt.db, profileId, calendarToday));
      // 今天补班由 holiday.workday 独立通知承载（单一来源，避免重复）；这里只说「明天」与倒计时
      const tomorrow = addDays(calendarToday, 1);
      const holiday =
        dayType(rt.db, calendarToday) === "unknown" || tomorrow === null
          ? null
          : (holidayLine(rt.db, tomorrow, "明天") ?? holidayCountdownLine(rt.db, calendarToday));
      if (holiday !== null) notes.push(holiday);

      await publishProfile(rt.db, rt.config, profileId, {
        kind: "weather.brief",
        title: "☀️ 早安",
        blocks: { notes },
        dedupeKey: `brief:${profileId}:${loc.city}:${calendarToday}`,
      });
    },
  });
}

/**
 * 预警级别 → 序号（越大越严重）。上游 level 既可能是中文色名（qweather 客户端已把英文
 * 色名转成中文），也可能直接是英文色名，两种都认。
 */
const ALERT_LEVEL_RANK: Record<string, number> = {
  blue: 1,
  蓝: 1,
  蓝色: 1,
  yellow: 2,
  黄: 2,
  黄色: 2,
  orange: 3,
  橙: 3,
  橙色: 3,
  red: 4,
  红: 4,
  红色: 4,
};

/**
 * 无法识别的级别（含空串）按最高优先级处理：宁可多推，不可漏推。
 */
const UNKNOWN_LEVEL_RANK = 5;

function levelRank(level: string): number {
  const key = level.trim().toLowerCase();
  if (key === "") return UNKNOWN_LEVEL_RANK;
  // 同 alertLevelOf：不能用裸索引，`constructor` 会取到 Object 构造函数（非 number），
  // 阈值比较恒为 false，会让级别过滤静默失效。
  return Object.hasOwn(ALERT_LEVEL_RANK, key)
    ? (ALERT_LEVEL_RANK[key] as number)
    : UNKNOWN_LEVEL_RANK;
}

/** endsAt 已早于当前时刻的预警不再推送；无 endsAt 或解析失败时保留（不误杀）。 */
function isExpiredAlert(alert: WeatherAlert, nowMs: number): boolean {
  if (alert.endsAt === undefined) return false;
  const end = Date.parse(alert.endsAt);
  return Number.isFinite(end) && end < nowMs;
}

/**
 * 去重键：weather.alert:<内容键>:<级别>。内容键有 id 用 id、缺 id 回退到标题（不同预警
 * 不能共用空串相互覆盖）。同一预警同级别只推一次；级别升级会得到新键而再推一次。
 */
const ALERT_DEDUPE_PREFIX = "weather.alert:";

/** 同一预警的内容键：有 id 用 id，缺 id 回退到 `title:<标题>`（与去重键一一对应） */
function alertContentKey(alert: WeatherAlert): string {
  const id = alert.id.trim();
  return id === "" ? `title:${alert.title.trim()}` : id;
}

function alertDedupeKey(alert: WeatherAlert): string {
  return `${ALERT_DEDUPE_PREFIX}${alertContentKey(alert)}:${alert.level.trim()}`;
}

/**
 * 从已落库的去重键还原「内容键 + 级别」；非本类键返回 null。
 * 级别恒在最后一个冒号之后（色名不含冒号），内容键本身可能含冒号（标题回退）。
 */
function parseAlertDedupeKey(key: string): { contentKey: string; level: string } | null {
  if (!key.startsWith(ALERT_DEDUPE_PREFIX)) return null;
  const rest = key.slice(ALERT_DEDUPE_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  return { contentKey: rest.slice(0, cut), level: rest.slice(cut + 1) };
}

/**
 * 各预警内容键「已推送过的最高级别」。级别降级不重推的依据：去重键含 level，若不查历史，
 * orange→yellow 也会得到新键再推一次，与「只有级别升级才再推」的口径不符。
 * 回看 30 天：既要覆盖持续数天的长预警（24h 窗口会让降级在窗口外漏判），
 * 又要避免用极远古的同 id 记录误压当前预警。空级别（未知，按最高优先级处理）
 * 不纳入历史，否则会误压后续真实级别。
 */
function notifiedAlertRanks(db: DatabaseSync, profileId: string): Map<string, number> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      "SELECT dedupe_key FROM notifications WHERE profile_id = ? AND kind = 'weather.alert' AND dedupe_key IS NOT NULL AND created_at >= ?",
    )
    .all(profileId, since) as { dedupe_key: string }[];
  const ranks = new Map<string, number>();
  for (const { dedupe_key } of rows) {
    const parsed = parseAlertDedupeKey(dedupe_key);
    if (parsed === null || parsed.level === "") continue;
    const rank = levelRank(parsed.level);
    ranks.set(parsed.contentKey, Math.max(ranks.get(parsed.contentKey) ?? 0, rank));
  }
  return ranks;
}

function alertTitle(alert: WeatherAlert): string {
  const level = alert.level.trim();
  return level === "" ? `⚠️ ${alert.type}预警` : `⚠️ ${alert.type}${level}预警`;
}

function alertBlocks(alert: WeatherAlert, travel: TravelPlan | null): NotifyBlock {
  const end = alert.endsAt === undefined ? null : DateTime.fromISO(alert.endsAt, { zone: TZ });
  const where = travel === null ? "" : `${travel.city}（出行中）`;
  const until = end?.isValid === true ? `，至 ${end.toFormat("MM-dd HH:mm")}` : "";
  return { notes: [`${where}${briefAlertText(alert)}${until}`.trim()] };
}

/**
 * 气象预警巡检：为每个 Profile（与每日简报同为 listProfiles 口径）检查其位置的生效预警，
 * 命中即推。走普通通知路径（publishProfile）——静默时段由投递层照常拦截，这里不做任何绕过。
 * 单个 Profile 失败只记日志，不影响其它 Profile，也不让 job 抛出。
 */
export async function runAlertWatch(): Promise<void> {
  await forEachProfilePlace({
    skipLog: "气象预警巡检跳过：未配置 QWeather",
    failLog: (profileId, e) => logger.warn(`气象预警巡检失败 ${profileId}: ${errorMessage(e)}`),
    prepare: (rt) => ({
      minRank: ALERT_LEVEL_RANK[rt.config.alertMinLevel] ?? 1,
      nowMs: Date.now(),
      alertTtlMs: alertCacheTtlMs(rt.config),
    }),
    run: async ({ rt, host, key, profileId, cityCache }, { minRank, nowMs, alertTtlMs }) => {
      // 与每日简报同口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY。
      const place = await resolveProfilePlace(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        cityCache,
      );
      const loc = place.loc;
      const list = await alerts(rt.db, host, key, loc, alertTtlMs);
      const notified = notifiedAlertRanks(rt.db, profileId);
      for (const alert of list) {
        try {
          if (isExpiredAlert(alert, nowMs)) continue;
          const currentRank = levelRank(alert.level);
          if (currentRank < minRank) continue;
          const contentKey = alertContentKey(alert);
          const previousRank = notified.get(contentKey);
          // 级别降级不再重推：去重键含级别，不比较历史的话 orange→yellow 也会再推一次，
          // 与 README/SKILL「只有级别升级才再推」的口径不符（同级别仍由去重键兜底）。
          if (previousRank !== undefined && previousRank > currentRank) continue;
          await publishProfile(rt.db, rt.config, profileId, {
            kind: "weather.alert",
            title: alertTitle(alert),
            blocks: alertBlocks(alert, place.travel),
            dedupeKey: alertDedupeKey(alert),
            // 预警失效时刻即投递截止：静默时段结束后不再补投已失效的预警
            expiresAt: alert.endsAt,
          });
          // 空级别不纳入历史（未知按最高优先级处理，纳入会误压后续真实级别）
          if (alert.level.trim() !== "") {
            notified.set(contentKey, Math.max(previousRank ?? 0, currentRank));
          }
        } catch (e) {
          // 逐条隔离：一条坏预警只损失它自己，不能让同批其余预警一起丢
          logger.warn(`气象预警处理失败（跳过该条，不影响其余）: ${errorMessage(e)}`);
        }
      }
    },
  });
}

/**
 * 晚报内容：明日天气一行 + 明日日程一行 + 明天补班/放假一行 + 今天记账一句话。
 * 天气与日程各自隔离：任一取数失败只省略对应行，另一侧照常送达。
 * 今天没做完的事不在这里列：循环待办 20:00 已追提醒过一次，过了今天自动作废。
 */
async function eveningBriefBlocks(
  db: DatabaseSync,
  host: string,
  key: string,
  defaultCity: string,
  profileId: string,
  today: string,
  tomorrow: string,
  cityCache: Map<string, LocationInfo>,
): Promise<NotifyBlock> {
  const notes: string[] = [];
  try {
    // 与早报同一解析口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY。
    // 出行计划的生效判定同样用本次运行的业务日（补发跨午夜时按原定触发那天算）。
    const place = await resolveProfilePlace(
      db,
      host,
      key,
      defaultCity,
      profileId,
      cityCache,
      today,
    );
    const list = await forecast(db, host, key, place.loc, 7);
    // 「第 2 天」按日期匹配而不是按下标取：上游跨零点/少返回一天时下标会错位；
    // 匹配不到再退回下标 1（QWeather 首行固定是今天）。
    const day = list.find((candidate) => candidate.date === tomorrow) ?? list[1];
    if (day !== undefined) {
      const tips: string[] = [];
      if (day.precipMm !== undefined && day.precipMm > 0) tips.push("带伞");
      if (day.tMax - day.tMin >= 10) tips.push("温差大");
      notes.push(
        weatherLine({
          city: `明天 ${place.loc.city}`,
          travel: place.travel,
          text: day.textDay,
          tMin: day.tMin,
          tMax: day.tMax,
          aqiCategory: null,
          tips,
        }),
      );
    }
  } catch (e) {
    logger.warn(`晚报：明日天气获取失败（${profileId}），省略该行: ${errorMessage(e)}`);
  }
  const agenda = agendaLineFor(db, profileId, tomorrow, "📌 明天：");
  if (agenda !== null) notes.push(agenda);
  const holiday = holidayLine(db, tomorrow, "明天");
  if (holiday !== null) notes.push(holiday);
  const spent = todaySpendingLine(db, profileId, today);
  if (spent !== null) notes.push(spent);
  return { notes };
}

/**
 * 「今天记了 3 笔共 ¥128」：只算本人记的账（与原每日记账摘要同口径），没记账整行省略。
 * 直接读 expenses 表而不 import 记账模块内部（模块间只走只读 SQL，避免反向依赖）。
 */
function todaySpendingLine(db: DatabaseSync, profileId: string, today: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM expenses
         WHERE spent_on = ? AND created_by_profile = ?`,
      )
      .get(today, profileId) as { n: number; cents: number };
    if (row.n === 0) return null;
    const yuan = (row.cents / 100).toFixed(2).replace(/\.?0+$/, "");
    return `🧾 今天记了 ${row.n} 笔，共 ¥${yuan}`;
  } catch (e) {
    logger.warn(`晚报：记账行已跳过（${profileId}）: ${errorMessage(e)}`);
    return null;
  }
}

/**
 * 21:00 晚报：睡前把「明天」一次说清。与早报同为确定性组装（无 LLM），
 * 覆盖所有已知 Profile（与早报同口径：无推送路由也保留，供 notify.pull 兜底）。
 * 同一天重复触发由 dedupeKey 去重；expiresAt 设为明天中午 12:00 ——
 * 晚报是睡前信息，静默时段结束后也不再补投一条已经过期的「明日安排」。
 *
 * `at` = 这次运行对应的**参考时刻**：cron/手动调用传当前时刻（缺省 now()），
 * 启动补发则传「错过的那次原定触发时刻」。跨午夜补发（21:00 的触发在次日 00:00–03:00
 * 才补跑）若仍按 now() 推导「今天/明天」，内容与 dedupeKey 都会漂移一天：补发算出的
 * `evening:<profile>:<后天>` 会与当天 21:00 的正常运行同键，把当晚的晚报静默吞掉。
 */
export async function runEveningBrief(at?: DateTime): Promise<void> {
  await forEachProfilePlace({
    skipLog: "晚报跳过：未配置 QWeather",
    failLog: (profileId, e) => logger.error(`晚报失败 ${profileId}: ${errorMessage(e)}`),
    prepare: () => {
      const today = (at ?? now()).toISODate() ?? todayIso();
      const tomorrow = addDays(today, 1);
      if (tomorrow === null) {
        logger.warn(`晚报跳过：无法从 ${today} 推算明天`);
        return null;
      }
      return { today, tomorrow, expiresAt: localToInstant(tomorrow, "12:00") };
    },
    run: async ({ rt, host, key, profileId, cityCache }, { today, tomorrow, expiresAt }) => {
      const blocks = await eveningBriefBlocks(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        today,
        tomorrow,
        cityCache,
      );
      await publishProfile(rt.db, rt.config, profileId, {
        kind: "weather.evening",
        title: "🌙 明天",
        blocks,
        dedupeKey: `evening:${profileId}:${tomorrow}`,
        expiresAt,
      });
    },
  });
}
