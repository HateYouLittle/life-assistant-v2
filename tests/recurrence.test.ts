import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { Lunar, LunarYear } from "lunar-javascript";
import {
  describeRecurrence,
  lunarToSolar,
  nextDate,
  type OccurrenceSource,
} from "../src/core/recurrence.js";
import { TZ } from "../src/time.js";

const at = (s: string): DateTime => DateTime.fromISO(s, { zone: TZ });
const HORIZON = at("2030-01-01");

const solarSource = (
  startDate: string,
  recurrence: OccurrenceSource["recurrence"],
): OccurrenceSource => ({
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

/**
 * 从 after 起连续物化 count 个真实事件（走引擎，不复算规则），用于把文案与实际排期对照。
 * 夹具值由调用方给死，测试不依赖挂钟。
 */
function materialize(
  src: OccurrenceSource,
  after: DateTime,
  count: number,
  horizon: DateTime,
): string[] {
  const out: string[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextDate(src, cursor, horizon);
    if (next === null) break;
    out.push(next.toISODate() as string);
    cursor = next;
  }
  return out;
}

describe("recurrence：公历", () => {
  it("daily 按间隔推进", () => {
    const src = solarSource("2026-01-01", { freq: "daily", interval: 2 });
    assert.equal(ymd(nextDate(src, at("2026-01-03T10:00"), HORIZON)), "2026-01-05");
  });

  it("daily 起始日远在过去也能推进（不再耗尽迭代预算）", () => {
    // 回归：daily 曾从 start 逐日 while，start 早于约 5000 天时误报「规则无法产生日期」，
    // 任何 13.7 年以上的每日日程都会中招（创建报错但已落库）。
    const src = solarSource("2011-09-27", { freq: "daily", interval: 1 });
    assert.equal(ymd(nextDate(src, at("2026-09-28T10:00"), HORIZON)), "2026-09-29");

    const every3 = solarSource("2011-09-27", { freq: "daily", interval: 3 });
    const afterDay = at("2026-09-28T10:00");
    let expected = at("2011-09-27");
    while (expected <= afterDay) expected = expected.plus({ days: 3 });
    assert.equal(ymd(nextDate(every3, afterDay, HORIZON)), ymd(expected));
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

  it("weekly 空 byweekday 不再挂起：回退到开始日期的星期", () => {
    // 回归：uniqSorted(rec.byweekday ?? [start.weekday - 1]) 曾用 ?? 兜底，
    // 空数组不被兜住 → 内层 for 永不产出 → 外层 for(;;) 同步死循环卡死 daemon。
    const src = solarSource("2026-01-05", { freq: "weekly", interval: 1, byweekday: [] });
    assert.equal(ymd(nextDate(src, at("2026-09-13"), HORIZON)), "2026-09-14");
  });

  it("weekly 全部越界 byweekday 也回退而不是挂起", () => {
    const src = solarSource("2026-01-05", { freq: "weekly", interval: 1, byweekday: [9, -1] });
    assert.equal(ymd(nextDate(src, at("2026-09-13"), HORIZON)), "2026-09-14");
  });

  it("weekly 省略 byweekday 仍回退到开始日期的星期", () => {
    const src = solarSource("2026-01-05", { freq: "weekly", interval: 1 });
    assert.equal(ymd(nextDate(src, at("2026-09-13"), HORIZON)), "2026-09-14");
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

  it("yearly 按间隔跳年（曾忽略 interval，每 2 年变成每年都触发）", () => {
    const src = solarSource("2026-03-15", { freq: "yearly", interval: 2 });
    const horizon = at("2035-01-01");
    assert.equal(ymd(nextDate(src, at("2026-03-15T12:00"), horizon)), "2028-03-15");
    assert.equal(ymd(nextDate(src, at("2028-03-15T12:00"), horizon)), "2030-03-15");
    // 回显必须与实际排期一致
    assert.equal(describeRecurrence(src, "2026-03-15"), "每 2 年");
  });

  it("weekly 的 byweekday 含 null 时不会被静默当成周一", () => {
    // null >= 0 为真，旧的过滤条件放行了 null；luxon.plus({days:null}) 是 no-op，
    // 于是 weekly 会悄悄落到周一而不是回退到开始日期的星期。
    const src = solarSource("2026-01-05", {
      freq: "weekly",
      interval: 1,
      byweekday: [null as unknown as number, 4],
    });
    assert.equal(ymd(nextDate(src, at("2026-01-05T12:00"), HORIZON)), "2026-01-09", "周五");
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
    const regular = nextDate(
      lunarSource(6, 1, { leapPolicy: "regular" }),
      at("2025-01-02"),
      HORIZON,
    );
    assert.equal(ymd(follow), Lunar.fromYmd(2025, -6, 1).getSolar().toYmd(), "follow 应落在闰六月");
    assert.equal(
      ymd(regular),
      Lunar.fromYmd(2025, 6, 1).getSolar().toYmd(),
      "regular 应落在平六月",
    );
    assert.notEqual(ymd(follow), ymd(regular));
  });

  it("元旦至春节之间：农历年必须按公历日所属农历年取，不能漏掉整段", () => {
    // 2026 年春节为 2026-02-17，2026-01-10 仍属农历 2025 年（腊月）。
    // 回归：iterateLunar 曾用 Lunar.fromYmd(公历年, ...).getYear() 取到 2026，
    // 于是跳过农历 2025 年腊月十八（2026-02-05），直接报出 2027-01-25。
    const expected = Lunar.fromYmd(2025, 12, 18).getSolar().toYmd();
    assert.equal(expected, "2026-02-05", "测试假设：农历 2025 腊月十八 = 2026-02-05");
    assert.equal(ymd(nextDate(lunarSource(12, 18), at("2026-01-10"), HORIZON)), expected);
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
    assert.equal(
      ymd(clamped),
      Lunar.fromYmd(2025, 12, 29).getSolar().toYmd(),
      "clamp 应取当月最后一天",
    );
    assert.equal(lunarToSolar(2025, 12, 30, "follow", false), null, "no-clamp 当年跳过");

    const year30 = [2020, 2021, 2022, 2023, 2024, 2026, 2027, 2028].find(
      (y) => twelfthMonthDays(y) === 30,
    );
    assert.ok(year30 !== undefined, "测试假设存在腊月 30 天的年份");
    const got = lunarToSolar(year30, 12, 30, "follow", true);
    assert.equal(ymd(got), Lunar.fromYmd(year30, 12, 30).getSolar().toYmd());
  });
});

describe("recurrence：描述", () => {
  it("生成人话描述", () => {
    assert.equal(
      describeRecurrence(solarSource("2026-01-01", null), "2026-01-01"),
      "一次：2026-01-01",
    );
    assert.equal(
      describeRecurrence(solarSource("2026-01-01", { freq: "daily", interval: 1 }), "2026-01-01"),
      "每天",
    );
    assert.equal(
      describeRecurrence(
        solarSource("2026-01-05", { freq: "weekly", interval: 1, byweekday: [0, 4] }),
        "2026-01-05",
      ),
      "每周一、五",
    );
    assert.equal(
      describeRecurrence(
        solarSource("2026-01-05", { freq: "weekly", interval: 2, byweekday: [0, 2] }),
        "2026-01-05",
      ),
      "每 2 周 一、三",
      "多周间隔要读得通，不能拼成「每周2一、三」",
    );
    assert.equal(describeRecurrence(lunarSource(5, 5), null), "每年农历5月5日");
  });

  it("会夹到月末的日号必须在文案里体现（每月31日 → 11 月只得 30 日）", () => {
    // 回归：文案直接切 startDate 的日号，曾把「每月31日」说得像每月都有 31 号，
    // 而引擎实际物化 2026-11-30 —— 回显与排期矛盾（yearly interval 修过同类问题）。
    const src = solarSource("2026-01-31", { freq: "monthly", interval: 1 });
    const text = describeRecurrence(src, "2026-01-31");
    // 基准取自引擎真实物化的日期（nextDate 语义：严格晚于 after 的下一个日历日）
    const dates = materialize(src, at("2026-01-31T12:00"), 14, at("2027-04-01"));
    assert.ok(dates.includes("2026-11-30"), `11 月无 31 日应夹到 30 日：${dates.join(", ")}`);
    // 文案里的日号 + 文案承诺的夹取，必须能还原出引擎的每一个实际日期
    for (const date of dates) {
      assert.equal(
        Number(date.slice(8, 10)),
        Math.min(31, at(date).daysInMonth ?? 30),
        `引擎应把 31 夹到该月最后一天：${date}`,
      );
    }
    assert.match(text, /^每月31日/, "日号要照实说（标称 31）");
    assert.match(text, /月末/, "文案必须体现夹取到月末，否则与实际排期矛盾");
  });

  it("夹不到月末的规则不加多余提示（每月15日）", () => {
    assert.equal(
      describeRecurrence(solarSource("2026-01-15", { freq: "monthly", interval: 1 }), "2026-01-15"),
      "每月15日",
    );
  });

  it("yearly 闰日文案同样要体现夹取（2 月 29 日 → 平年 2 月 28 日）", () => {
    const src = solarSource("2028-02-29", { freq: "yearly", interval: 1 });
    const dates = materialize(src, at("2028-03-01"), 3, at("2032-01-01"));
    assert.deepEqual(dates, ["2029-02-28", "2030-02-28", "2031-02-28"]);
    assert.match(describeRecurrence(src, "2028-02-29"), /^每年0?2月29日/);
    assert.match(describeRecurrence(src, "2028-02-29"), /月末/);
    // 3 月 15 日这类夹不到月末的 yearly 规则不加提示
    assert.equal(
      describeRecurrence(solarSource("2026-03-15", { freq: "yearly", interval: 1 }), "2026-03-15"),
      "每年03月15日",
    );
  });

  it("农历三十日的文案必须跟着 lunar_clamp 分两种口径", () => {
    const clamp = lunarSource(12, 30);
    const dates = materialize(clamp, at("2026-01-01"), 12, at("2040-01-01"));
    assert.ok(
      dates.some((d) => Number(d.slice(8, 10)) < 30),
      `腊月只有 29 天时必须夹到月末，实际 ${dates.join(", ")}`,
    );
    assert.match(describeRecurrence(clamp, null), /^每年农历12月30日/);
    assert.match(describeRecurrence(clamp, null), /月末/);

    // 回归（Hermes 实测）：lunarClamp=false 时 lunarToSolar 对「小月无三十」返回 null，
    // iterateLunar 直接 continue —— 引擎**整年静默跳过**（实测首个缺口横跨 3 个农历年），
    // 而文案只写「每年农历12月30日」，用户以为提醒丢了。必须明确写出跳过。
    const strict = lunarSource(12, 30, { lunarClamp: false });
    const strictText = describeRecurrence(strict, null);
    assert.doesNotMatch(strictText, /月末/, "不夹取时不该承诺夹取");
    assert.match(
      strictText,
      /跳过/,
      `clamp=false + day=30 必须提示整年跳过，实际「${strictText}」`,
    );

    // 二十九日在大小月都存在 → 两种 clamp 口径下都不会被跳过，绝不能加任何注记，
    // 否则会把 29 也误标成会跳过。
    for (const lunarClamp of [true, false]) {
      assert.equal(
        describeRecurrence(lunarSource(12, 29, { lunarClamp }), null),
        "每年农历12月29日",
        `day=29 且 clamp=${lunarClamp} 不该有任何注记`,
      );
    }
  });

  it("农历腊月三十 clamp=false 的文案与实际排期一致（回显不得与物化脱节）", () => {
    // 把文案和引擎物化结果对起来：这是防止「回显说每年、实际隔几年才跳一次」再次脱节的保险。
    const from = at("2026-01-01");
    const horizon = at("2040-01-01");
    const clampOn = materialize(lunarSource(12, 30), from, 6, horizon);
    const clampOff = materialize(lunarSource(12, 30, { lunarClamp: false }), from, 6, horizon);
    assert.equal(clampOn.length, 6, "夹具应能物化出 6 次");
    assert.equal(clampOff.length, 6, "夹具应能物化出 6 次");

    // clamp=false 时每年腊月不一定有三十日，六年里必然出现跨年缺口（夹具实测首现为
    // 2030-02-02 → 2033-01-30，缺 3 年）
    const gaps = clampOff
      .slice(1)
      .map((d, i) => Number(d.slice(0, 4)) - Number(clampOff[i]?.slice(0, 4) ?? d.slice(0, 4)));
    assert.ok(
      gaps.some((g) => g >= 2),
      `clamp=false + day=30 必须存在跨年缺口（文案要说明跳过），实际 ${clampOff.join(", ")}`,
    );
    // 缺口存在 ⇒ 文案必须带「跳过」；两种 clamp 口径的物化结果必须不同（否则夹具没意义）
    assert.notDeepEqual(clampOff, clampOn, "两种 clamp 口径的物化结果必须不同");
    assert.match(describeRecurrence(lunarSource(12, 30, { lunarClamp: false }), null), /跳过/);
    assert.doesNotMatch(
      describeRecurrence(lunarSource(12, 30), null),
      /跳过/,
      "clamp=true 不会跳过",
    );
  });

  it("农历小日（初五）文案保持原样", () => {
    assert.equal(describeRecurrence(lunarSource(5, 5), null), "每年农历5月5日");
  });

  it("农历畸形存量行的回显必须说清「不会提醒」，不得出现 null 或谎称「一次」", () => {
    // N12 的 B 类死行的回显侧。两类畸形都会产出零 occurrence（iterateLunar 的范围判断 /
    // recurrence===null 早退），文案必须如实说明，且不得把模板漏洞（农历null月null日）
    // 或「一次：」这种会让人以为会触发一次的表述留给用户。
    const missingMd: OccurrenceSource = {
      ...lunarSource(5, 5),
      lunarMonth: null,
      lunarDay: null,
      recurrence: { freq: "yearly", interval: 1 },
    };
    const noRecurrence: OccurrenceSource = { ...lunarSource(5, 5), recurrence: null };

    for (const [label, src] of [
      ["缺月日", missingMd],
      ["无循环规则", noRecurrence],
    ] as const) {
      const text = describeRecurrence(src, null);
      assert.doesNotMatch(text, /null/, `${label} 的文案不得出现 null（模板漏字）`);
      assert.match(text, /不会产生任何提醒/, `${label} 必须如实说明不会提醒，实际「${text}」`);
      assert.doesNotMatch(
        text,
        /一次/,
        `${label} 不是「一次性」，写「一次」会让人以为它会触发一次`,
      );
      // 文案说不会提醒，物化就必须真的是零 occurrence —— 两边必须一致
      assert.deepEqual(
        materialize(src, at("2026-01-01"), 5, at("2040-01-01")),
        [],
        `${label} 的文案说不提醒，物化就不该产出 occurrence`,
      );
    }
  });

  it("农历的 interval 不被静默忽略：要么报错，要么物化间隔真的是 N 年", () => {
    // 回归：iterateLunar 曾只做 lunarYear++（从不乘 interval），describeRecurrence 又无条件
    // 写「每年X」—— 设 interval:2/3 的文案与物化完全相同，且无任何报错（实测）。
    // 本项目选「报错」口径（validateScheduleInput 拒绝 calendar=lunar && interval!==1，
    // 与既有「农历只支持按年循环」一致），所以这里断言引擎侧的口径是：
    //   农历 interval=2 的物化结果必须与 interval=1 **不同**，否则就是静默忽略；
    //   同时 describeRecurrence 不得对 interval>1 谎称「每年」。
    const withInterval = (n: number): OccurrenceSource => ({
      ...lunarSource(12, 15),
      recurrence: { freq: "yearly", interval: n },
    });
    const base = materialize(withInterval(1), at("2026-01-01"), 5, at("2040-01-01"));
    const two = materialize(withInterval(2), at("2026-01-01"), 5, at("2040-01-01"));
    assert.equal(base.length, 5, "夹具应能物化出 5 次农历腊月十五");
    // 记录引擎的既有事实：农历的 interval 不参与推进（2 年与 1 年物化完全相同）。
    // 这不是「正确行为」，而是「为什么必须在写入侧拒掉 interval>1」的依据。
    assert.deepEqual(two, base, "农历 interval 当前不参与推进（这正是校验必须拒掉它的原因）");

    // 公历 yearly 的对照组：interval 确实生效（证明引擎在别的分支上没坏）
    const solarTwo = materialize(
      solarSource("2026-03-05", { freq: "yearly", interval: 2 }),
      at("2026-03-05T12:00"),
      5,
      at("2040-01-01"),
    );
    assert.deepEqual(solarTwo, [
      "2028-03-05",
      "2030-03-05",
      "2032-03-05",
      "2034-03-05",
      "2036-03-05",
    ]);
    assert.equal(
      describeRecurrence(solarSource("2026-03-05", { freq: "yearly", interval: 2 }), null),
      "每 2 年",
    );

    // 农历：interval 不生效（引擎只按农历年推进），所以绝不能对它谎称「每 N 年」。
    // describeRecurrence 必须把 interval>1 显式暴露出来，而不是无条件写「每年」。
    const textTwo = describeRecurrence(withInterval(2), null);
    assert.notEqual(
      textTwo,
      describeRecurrence(withInterval(1), null),
      "农历 interval=2 不得与 interval=1 输出完全相同的文案（那正是静默忽略的回显）",
    );
    assert.doesNotMatch(textTwo, /每 ?2 ?年/, "农历不得谎称「每 2 年」（引擎并不跳年）");
    assert.match(textTwo, /interval=2 不生效/, "农历 interval>1 的文案必须点明它会被忽略");
  });
});
