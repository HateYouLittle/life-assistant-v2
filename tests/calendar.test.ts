import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  CALENDAR_SIGNATURE_MISMATCH,
  escapeIcsText,
  formatIcsUtc,
  signCalendarUrl,
  verifyCalendarSignature,
} from "../src/core/ics.js";
import { ensureProfile } from "../src/core/settings.js";
import { createCalendarApp } from "../src/server/calendar.js";
import { createStatusApp } from "../src/server/status.js";
import { TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/** master token：≥32 字符，也是签名密钥 */
const TOKEN = "t".repeat(40);

function app(env: TestEnv) {
  return createCalendarApp(env.config, env.db);
}

/** 本地（Asia/Shanghai）某天某时刻 → UTC Date */
function localAt(daysFromNow: number, hour = 9, minute = 0): Date {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days: daysFromNow })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** 与物化逻辑同形的 occurrence_key（`<本地日>T<时刻>#<偏移序号>`） */
function occurrenceKey(at: Date, hour = 9, minute = 0, index = 0): string {
  const local = DateTime.fromJSDate(at).setZone(TZ);
  return `${local.toISODate()}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}#${index}`;
}

function addSchedule(
  db: DatabaseSync,
  over: {
    id: string;
    title: string;
    profile?: string;
    note?: string | null;
    allDay?: boolean;
    status?: string;
  },
): void {
  db.prepare(
    `INSERT INTO schedules (id, profile_id, title, note, kind, calendar, start_date, time, all_day, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'todo', 'solar', NULL, '09:00', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(
    over.id,
    over.profile ?? "default",
    over.title,
    over.note ?? null,
    over.allDay === false ? 0 : 1,
    over.status ?? "active",
  );
}

function addOccurrence(
  db: DatabaseSync,
  scheduleId: string,
  key: string,
  at: Date,
  status = "pending",
): void {
  const iso = at.toISOString();
  db.prepare(
    `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(scheduleId, key, iso, iso, status);
}

/** 把签名 URL 拆成 verify 需要的三个字段 */
function parseSigned(url: string): { p?: string; exp?: string; sig?: string } {
  const u = new URL(url, "http://localhost");
  return {
    p: u.searchParams.get("p") ?? undefined,
    exp: u.searchParams.get("exp") ?? undefined,
    sig: u.searchParams.get("sig") ?? undefined,
  };
}

describe("日历订阅签名", () => {
  it("签名 URL 往返一致：p/exp/sig 都能被校验通过", () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const url = signCalendarUrl(env.config, "default", Date.now() + 3600_000);
      assert.match(url, /^\/calendar\.ics\?p=default&exp=\d+&sig=[0-9a-f]{64}$/);
      assert.deepEqual(verifyCalendarSignature(env.config, parseSigned(url)), { ok: true });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("60s 时钟偏移：正好容忍 60s，多 1ms 即过期", () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      // 固定基准时刻：exp 只有整秒精度，用真实 Date.now() 会让边界断言随时钟抖动
      const base = 1_700_000_000_000;
      const url = signCalendarUrl(env.config, "default", base + 3600_000, base);
      const input = parseSigned(url);
      const expSeconds = Number(input.exp);
      assert.equal(expSeconds * 1000, base + 3600_000, "exp 应是秒精度且与入参同刻");

      assert.equal(verifyCalendarSignature(env.config, input, base).ok, true);
      assert.equal(
        verifyCalendarSignature(env.config, input, expSeconds * 1000 + 60_000).ok,
        true,
        "时钟慢 60s 的客户端仍应能订阅",
      );
      assert.equal(
        verifyCalendarSignature(env.config, input, expSeconds * 1000 + 60_001).ok,
        false,
        "超过容忍窗口即视为过期",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("篡改 exp / sig / p 都被拒绝", () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const url = signCalendarUrl(env.config, "default", Date.now() + 3600_000);
      const input = parseSigned(url);
      const sig = input.sig ?? "";
      const otherSig = sig === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);

      const badSig = verifyCalendarSignature(env.config, { ...input, sig: otherSig });
      assert.equal(badSig.ok, false);
      assert.equal(badSig.ok === false ? badSig.reason : "", CALENDAR_SIGNATURE_MISMATCH);

      // exp 也参与签名：改 exp 后原 sig 必须失效（否则过期时间形同虚设）
      const badExp = verifyCalendarSignature(env.config, {
        ...input,
        exp: String(Number(input.exp) + 3600),
      });
      assert.equal(badExp.ok, false);

      // 换 Profile：签名绑定 p，不能拿 default 的链接读别人的日程
      const badP = verifyCalendarSignature(env.config, { ...input, p: "bestie" });
      assert.equal(badP.ok, false);

      // 非 hex / 长度不对的 sig 也要挡住（timingSafeEqual 长度不等会抛错，必须先做形状校验）
      assert.equal(verifyCalendarSignature(env.config, { ...input, sig: "zz" }).ok, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile 名非法：签发与校验都拒绝", () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      assert.throws(
        () => signCalendarUrl(env.config, "Bad Name", Date.now() + 3600_000),
        /Profile 名不合法/,
      );
      const result = verifyCalendarSignature(env.config, {
        p: "../etc/passwd",
        exp: String(Math.floor(Date.now() / 1000) + 3600),
        sig: "0".repeat(64),
      });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.reason : "", /Profile 名不合法/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配置 WEB_API_TOKEN：签名功能明确报错，不静默放行", async () => {
    const env = makeTestEnv();
    try {
      assert.throws(
        () => signCalendarUrl(env.config, "default", Date.now() + 3600_000),
        /WEB_API_TOKEN/,
      );
      const result = verifyCalendarSignature(env.config, {
        p: "default",
        exp: "9999999999",
        sig: "0".repeat(64),
      });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.reason : "", /WEB_API_TOKEN/);

      const res = await app(env).request(
        `/calendar.ics?p=default&exp=9999999999&sig=${"0".repeat(64)}`,
      );
      assert.equal(res.status, 503, "没有密钥时不能把订阅放行成 200");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("缺少 p/exp/sig 或 exp 非数字 → 401", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const a = app(env);
      assert.equal((await a.request("/calendar.ics")).status, 401);
      assert.equal((await a.request("/calendar.ics?p=default")).status, 401);
      assert.equal(
        (await a.request(`/calendar.ics?p=default&exp=soon&sig=${"0".repeat(64)}`)).status,
        401,
      );
      assert.equal(
        (await a.request(`/calendar.ics?p=default&exp=1.5e9&sig=${"0".repeat(64)}`)).status,
        401,
        "科学计数法/小数不是合法的 Unix 秒",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("ICS 文本工具", () => {
  it("TEXT 转义覆盖反斜杠、分号、逗号与换行（反斜杠最先替换）", () => {
    assert.equal(escapeIcsText("a,b;c\\d"), "a\\,b\\;c\\\\d");
    assert.equal(escapeIcsText("第一行\n第二行"), "第一行\\n第二行");
    assert.equal(escapeIcsText("CRLF\r\n也要转"), "CRLF\\n也要转");
    assert.equal(escapeIcsText("单独\r回车"), "单独\\n回车");
  });

  it("formatIcsUtc 输出 UTC 基本格式", () => {
    assert.equal(formatIcsUtc(new Date("2026-10-21T01:02:03Z")), "20261021T010203Z");
    assert.throws(() => formatIcsUtc(new Date("不是时间")), /时间不合法/);
  });
});

describe("GET /calendar.ics", () => {
  it("签名正确 → 200，返回合法 VCALENDAR 与预期 VEVENT", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const at = localAt(3);
      addSchedule(env.db, { id: "s1", title: "交房租", note: "记得开发票", allDay: false });
      addOccurrence(env.db, "s1", occurrenceKey(at), at);

      const res = await app(env).request(
        signCalendarUrl(env.config, "default", Date.now() + 3600_000),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/calendar;\s*charset=utf-8$/i);
      assert.equal(res.headers.get("cache-control"), "no-store");

      const body = await res.text();
      for (const line of [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//life-assistant//v2//CN",
        "CALSCALE:GREGORIAN",
        "X-WR-TIMEZONE:Asia/Shanghai",
        "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
        "X-PUBLISHED-TTL:PT30M",
        "BEGIN:VEVENT",
        `UID:s1-${occurrenceKey(at)}@life-assistant`,
        `DTSTART:${formatIcsUtc(at)}`,
        "SUMMARY:交房租",
        "DESCRIPTION:记得开发票",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ]) {
        assert.ok(body.includes(line), `日历缺少行: ${line}`);
      }
      assert.equal(body.match(/BEGIN:VEVENT/g)?.length, 1);
      // DTEND 必须晚于 DTSTART：零长度事件在多数客户端里根本不显示
      const start = /DTSTART:(\d{8}T\d{6}Z)/.exec(body)?.[1] ?? "";
      const end = /DTEND:(\d{8}T\d{6}Z)/.exec(body)?.[1] ?? "";
      assert.ok(start !== "" && end > start, `DTEND(${end}) 应晚于 DTSTART(${start})`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("行结束统一 CRLF，文件末尾一个空行", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const at = localAt(2);
      addSchedule(env.db, { id: "s1", title: "散步" });
      addOccurrence(env.db, "s1", occurrenceKey(at), at);

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(!/[^\r]\n/.test(body), "不允许出现裸 LF");
      assert.ok(body.endsWith("END:VCALENDAR\r\n\r\n"), "末尾必须是一个空行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("篡改 sig → 403，过期 exp → 401（中文说明）", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const a = app(env);
      const url = signCalendarUrl(env.config, "default", Date.now() + 3600_000);
      const u = new URL(url, "http://localhost");
      const original = u.searchParams.get("sig") ?? "";
      u.searchParams.set("sig", original === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64));
      const tampered = await a.request(`${u.pathname}${u.search}`);
      assert.equal(tampered.status, 403);
      const tamperedBody = (await tampered.json()) as { error: string };
      assert.match(tamperedBody.error, /签名/);

      // 过期链接：用过去的时刻签发（exp 已过 60s 容忍）
      const past = Date.now() - 30 * 60_000;
      const expired = await a.request(signCalendarUrl(env.config, "default", past + 1000, past));
      assert.equal(expired.status, 401);
      const expiredBody = (await expired.json()) as { error: string };
      assert.match(expiredBody.error, /过期/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile 名非法 → 401", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const res = await app(env).request(
        `/calendar.ics?p=Bad%20Name&exp=${exp}&sig=${"0".repeat(64)}`,
      );
      assert.equal(res.status, 401);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("空库仍返回合法的空 VCALENDAR", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const res = await app(env).request(
        signCalendarUrl(env.config, "default", Date.now() + 3600_000),
      );
      assert.equal(res.status, 200, "没有日程不是错误，客户端不该因为空而报错");
      const body = await res.text();
      assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
      assert.ok(body.endsWith("END:VCALENDAR\r\n\r\n"));
      assert.ok(!body.includes("BEGIN:VEVENT"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile 隔离：只出现签名对应 Profile 的日程", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      ensureProfile(env.db, "bestie");
      const mine = localAt(2);
      const theirs = localAt(4);
      addSchedule(env.db, { id: "mine", title: "我的日程" });
      addOccurrence(env.db, "mine", occurrenceKey(mine), mine);
      addSchedule(env.db, { id: "theirs", title: "别人的日程", profile: "bestie" });
      addOccurrence(env.db, "theirs", occurrenceKey(theirs), theirs);

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body.includes("UID:mine-"), "自己的日程必须出现");
      assert.ok(!body.includes("别人的日程"), "别人的日程绝不能出现在我的订阅里");
      assert.ok(!body.includes("theirs"), "连 UID 都不能泄漏");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("标题/备注含逗号、分号、换行、反斜杠时正确转义", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const at = localAt(1);
      addSchedule(env.db, {
        id: "s1",
        title: "买,牛奶;面包\\酸奶",
        note: "第一行\n第二行, 带逗号;分号\\反斜杠",
      });
      addOccurrence(env.db, "s1", occurrenceKey(at), at);

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body.includes("SUMMARY:买\\,牛奶\\;面包\\\\酸奶"), "SUMMARY 未按 RFC 5545 转义");
      assert.ok(
        body.includes("DESCRIPTION:第一行\\n第二行\\, 带逗号\\;分号\\\\反斜杠"),
        "DESCRIPTION 未按 RFC 5545 转义",
      );
      // 转义后不能再有裸换行：否则客户端会把一行内容截成两行、解析出非法属性
      const summaryLine = body.split("\r\n").find((l) => l.startsWith("SUMMARY:"));
      assert.equal(summaryLine, "SUMMARY:买\\,牛奶\\;面包\\\\酸奶");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("all_day 用 VALUE=DATE，DTEND 是次日", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const day = DateTime.now().setZone(TZ).plus({ days: 5 }).set({
        hour: 9,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      addSchedule(env.db, { id: "s1", title: "生日", allDay: true });
      addOccurrence(env.db, "s1", occurrenceKey(day.toUTC().toJSDate()), day.toUTC().toJSDate());

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body.includes(`DTSTART;VALUE=DATE:${day.toFormat("yyyyMMdd")}`));
      assert.ok(
        body.includes(`DTEND;VALUE=DATE:${day.plus({ days: 1 }).toFormat("yyyyMMdd")}`),
        "全天事件的 DTEND 必须是非含的次日",
      );
      assert.ok(!body.includes("DTSTART:"), "全天事件不该出现 UTC 时刻形式的 DTSTART");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("窗口外的 occurrence 与已结束/已取消的行都不出现", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const soon = localAt(1);
      const old = localAt(-3); // 超出「往前 1 天」
      const far = localAt(70); // 超出「往后 62 天」
      addSchedule(env.db, { id: "keep", title: "窗口内" });
      addOccurrence(env.db, "keep", occurrenceKey(soon), soon);
      addSchedule(env.db, { id: "old", title: "过期太久" });
      addOccurrence(env.db, "old", occurrenceKey(old), old);
      addSchedule(env.db, { id: "far", title: "太远" });
      addOccurrence(env.db, "far", occurrenceKey(far), far);
      addSchedule(env.db, { id: "done", title: "已完成" });
      addOccurrence(env.db, "done", occurrenceKey(soon), soon, "done");
      addSchedule(env.db, { id: "cancelled", title: "已取消" });
      addOccurrence(env.db, "cancelled", occurrenceKey(soon), soon, "cancelled");
      addSchedule(env.db, { id: "deleted", title: "已删除的日程", status: "cancelled" });
      addOccurrence(env.db, "deleted", occurrenceKey(soon), soon);

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body.includes("窗口内"));
      for (const gone of ["过期太久", "太远", "已完成", "已取消", "已删除的日程"]) {
        assert.ok(!body.includes(gone), `不该出现: ${gone}`);
      }
      // notified 也算「未结束」，必须保留（提醒已发不等于事件已办完）
      addSchedule(env.db, { id: "notified", title: "已提醒" });
      addOccurrence(env.db, "notified", occurrenceKey(soon), soon, "notified");
      const body2 = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body2.includes("已提醒"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("按 event_at 升序输出", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const later = localAt(5);
      const sooner = localAt(2);
      addSchedule(env.db, { id: "b", title: "后发生" });
      addOccurrence(env.db, "b", occurrenceKey(later), later);
      addSchedule(env.db, { id: "a", title: "先发生" });
      addOccurrence(env.db, "a", occurrenceKey(sooner), sooner);

      const body = await (
        await app(env).request(signCalendarUrl(env.config, "default", Date.now() + 3600_000))
      ).text();
      assert.ok(body.indexOf("先发生") < body.indexOf("后发生"), "应按 event_at 升序");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("与状态页组合挂载后仍可访问（daemon 的接线方式）", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: TOKEN });
    try {
      const at = localAt(2);
      addSchedule(env.db, { id: "s1", title: "组合挂载" });
      addOccurrence(env.db, "s1", occurrenceKey(at), at);
      // 状态页 app 自带 "*" 中间件（安全响应头）与 "/api/*" 鉴权中间件；
      // 日历路由挂在同一 app 上时不能被它们误伤（否则接线后 401/404）
      const combined = createStatusApp(env.config, env.db).route(
        "/",
        createCalendarApp(env.config, env.db),
      );
      const res = await combined.request(
        signCalendarUrl(env.config, "default", Date.now() + 3600_000),
      );
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes("组合挂载"));
    } finally {
      cleanupTestEnv(env);
    }
  });
});
