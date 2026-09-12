import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { Lunar, LunarYear } from "lunar-javascript";
import { describeRecurrence, lunarToSolar, nextDate, type OccurrenceSource } from "../src/core/recurrence.js";
import { TZ } from "../src/time.js";

const at = (s: string): DateTime => DateTime.fromISO(s, { zone: TZ });
const HORIZON = at("2030-01-01");

const solarSource = (startDate: string, recurrence: OccurrenceSource["recurrence"]): OccurrenceSource => ({
  calendar: "solar",
  startDate,
  lunarMonth: null,
  lunarDay: null,
  leapPolicy: "follow",
  lunarClamp: true,
  recurrence,
});

const lunarSource = (
  month: number,
  day: number,
  opts: { leapPolicy?: "follow" | "regular"; lunarClamp?: boolean } = {},
): OccurrenceSource => ({
  calendar: "lunar",
  startDate: null,
  lunarMonth: month,
  lunarDay: day,
  leapPolicy: opts.leapPolicy ?? "follow",
  lunarClamp: opts.lunarClamp ?? true,
  recurrence: { freq: "yearly", interval: 1 },
});

const ymd = (dt: DateTime | null): string | null => (dt === null ? null : dt.toISODate());

describe("recurrence：公历", () => {
  it("daily 按间隔推进", () => {
    const src = solarSource("2026-01-01", { freq: "daily", interval: 2 });
    assert.equal(ymd(nextDate(src, at("2026-01-03T10:00"), HORIZON)), "2026-01-05");
  });

  it("weekly 指定星期（周一/周五）", () => {
    const src = solarSource("2026-01-05", { freq: "weekly", interval: 1, byweekday: [0, 4] });
    assert.equal(ymd(nextDate(src, at("2026-01-05T12:00"), HORIZON)), "2026-01-09");
    assert.equal(ymd(nextDate(src, at("2026-01-09T12:00"), HORIZON)), "2026-01-12");
  });

  it("weekly 按间隔跳周", () => {
    const src = solarSource("2026-01-05", { freq: "weekly", interval: 2, byweekday: [0] });
    assert.equal(ymd(nextDate(src, at("2026-01-05T12:00"), HORIZON)), "2026-01-19");
  });

  it("monthly 月末钳位（31 日 → 2 月 28 日）", () => {
    const src = solarSource("2026-01-31", { freq: "monthly", interval: 1 });
    assert.equal(ymd(nextDate(src, at("2026-01-31T12:00"), HORIZON)), "2026-02-28");
    assert.equal(ymd(nextDate(src, at("2026-02-28T12:00"), HORIZON)), "2026-03-31");
  });

  it("yearly 闰日钳位到 2 月 28 日", () => {
    const src = solarSource("2028-02-29", { freq: "yearly", interval: 1 });
    assert.equal(ymd(nextDate(src, at("2028-03-01"), HORIZON)), "2029-02-28");
  });

  it("until 边界（含当天）", () => {
    const src = solarSource("2026-01-01", { freq: "daily", interval: 1, until: "2026-01-03" });
    assert.equal(ymd(nextDate(src, at("2026-01-02T12:00"), HORIZON)), "2026-01-03");
    assert.equal(nextDate(src, at("2026-01-03T12:00"), HORIZON), null);
  });

  it("一次性日程（recurrence=null）", () => {
    const src = solarSource("2026-06-01", null);
    assert.equal(ymd(nextDate(src, at("2026-01-01"), HORIZON)), "2026-06-01");
    assert.equal(nextDate(src, at("2026-06-01T12:00"), HORIZON), null);
  });
});

describe("recurrence：农历", () => {
  it("端午（农历五月初五）与 lunar-javascript 一致", () => {
    const src = lunarSource(5, 5);
    const got = nextDate(src, at("2026-01-01"), HORIZON);
    const oracle = Lunar.fromYmd(2026, 5, 5).getSolar();
    assert.equal(got?.year, oracle.getYear());
    assert.equal(got?.month, oracle.getMonth());
    assert.equal(got?.day, oracle.getDay());
    assert.equal(got?.toISODate(), "2026-06-19", "2026 年端午应为 6 月 19 日");
  });

  it("闰月策略 follow / regular（2025 年闰六月）", () => {
    assert.equal(LunarYear.fromYear(2025).getLeapMonth(), 6);
    const follow = nextDate(lunarSource(6, 1, { leapPolicy: "follow" }), at("2025-01-02"), HORIZON);
    const regular = nextDate(lunarSource(6, 1, { leapPolicy: "regular" }), at("2025-01-02"), HORIZON);
    assert.equal(ymd(follow), Lunar.fromYmd(2025, -6, 1).getSolar().toYmd(), "follow 应落在闰六月");
    assert.equal(ymd(regular), Lunar.fromYmd(2025, 6, 1).getSolar().toYmd(), "regular 应落在平六月");
    assert.notEqual(ymd(follow), ymd(regular));
  });

  it("腊月三十：正常 30 天年份直接命中，缺失年份按 clamp/skip", () => {
    const twelfthMonthDays = (lunarYear: number): number => {
      const months = LunarYear.fromYear(lunarYear).getMonths();
      const m = months.find((mm) => Math.abs(mm.getMonth()) === 12 && mm.getYear() === lunarYear);
      return m?.getDayCount() ?? 0;
    };
    // 农历 2025 年腊月只有 29 天
    assert.equal(twelfthMonthDays(2025), 29);
    const clamped = lunarToSolar(2025, 12, 30, "follow", true);
    assert.equal(ymd(clamped), Lunar.fromYmd(2025, 12, 29).getSolar().toYmd(), "clamp 应取当月最后一天");
    assert.equal(lunarToSolar(2025, 12, 30, "follow", false), null, "no-clamp 当年跳过");

    const year30 = [2020, 2021, 2022, 2023, 2024, 2026, 2027, 2028].find((y) => twelfthMonthDays(y) === 30);
    assert.ok(year30 !== undefined, "测试假设存在腊月 30 天的年份");
    const got = lunarToSolar(year30, 12, 30, "follow", true);
    assert.equal(ymd(got), Lunar.fromYmd(year30, 12, 30).getSolar().toYmd());
  });
});

describe("recurrence：描述", () => {
  it("生成人话描述", () => {
    assert.equal(describeRecurrence(solarSource("2026-01-01", null), "2026-01-01"), "一次：2026-01-01");
    assert.equal(describeRecurrence(solarSource("2026-01-01", { freq: "daily", interval: 1 }), "2026-01-01"), "每天");
    assert.equal(
      describeRecurrence(solarSource("2026-01-05", { freq: "weekly", interval: 1, byweekday: [0, 4] }), "2026-01-05"),
      "每周一、五",
    );
    assert.equal(
      describeRecurrence(solarSource("2026-01-05", { freq: "weekly", interval: 2, byweekday: [0, 2] }), "2026-01-05"),
      "每 2 周 一、三",
      "多周间隔要读得通，不能拼成「每周2一、三」",
    );
    assert.equal(
      describeRecurrence(lunarSource(5, 5), null),
      "每年农历5月5日",
    );
  });
});
