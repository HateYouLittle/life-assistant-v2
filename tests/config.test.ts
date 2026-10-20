import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { bindHost, loadConfig, parseProfileId, urlHost } from "../src/config.js";
import { SECRET } from "./helpers.js";

const BASE = { DATA_DIR: "/tmp/la-test", HERMES_PROFILE: "default" };

describe("config", () => {
  it("缺 DATA_DIR 拒绝启动", () => {
    assert.throws(() => loadConfig({}), /DATA_DIR/);
  });

  it("相对路径 DATA_DIR 拒绝启动", () => {
    assert.throws(() => loadConfig({ DATA_DIR: "relative/path" }), /绝对路径/);
  });

  it("默认值：回环绑定、3080 端口、07:00 简报", () => {
    const config = loadConfig(BASE);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3080);
    assert.equal(config.dailyBriefCron, "0 7 * * *");
    assert.equal(config.eveningBriefCron, "0 21 * * *");
    assert.equal(config.alertWatchCron, "*/20 * * * *");
    assert.equal(config.alertMinLevel, "blue");
    assert.equal(config.workdayWatchCron, "0 7 * * *");
    assert.equal(config.workdayRemindDaysBefore, 3);
    assert.equal(config.backupCron, "0 3 * * *");
    assert.equal(config.backupKeep, 14);
    assert.equal(config.defaultCity, "北京");
    assert.equal(config.webApiToken, undefined);
    assert.equal(config.requireAuth, false);
    assert.deepEqual(config.allowedHosts, []);
  });

  it("REQUIRE_AUTH：开启但无 token 拒绝启动；有 token 允许；非法取值拒绝", () => {
    for (const flag of ["1", "true", "TRUE", "yes", "on"]) {
      assert.throws(
        () => loadConfig({ ...BASE, REQUIRE_AUTH: flag }),
        /REQUIRE_AUTH=1 但未设置 WEB_API_TOKEN/,
        flag,
      );
      const config = loadConfig({ ...BASE, REQUIRE_AUTH: flag, WEB_API_TOKEN: SECRET });
      assert.equal(config.requireAuth, true, flag);
    }
    for (const flag of ["0", "false", "no", "off"]) {
      assert.equal(loadConfig({ ...BASE, REQUIRE_AUTH: flag }).requireAuth, false, flag);
    }
    assert.equal(loadConfig(BASE).requireAuth, false, "未设置时默认关闭（回环零配置）");
    // 拼错开关名等同于把安全开关关掉，必须拒绝而不是静默按 false
    assert.throws(() => loadConfig({ ...BASE, REQUIRE_AUTH: "treu" }), /REQUIRE_AUTH 不合法/);
  });

  it("WEB_ALLOWED_HOSTS：逗号分隔、去空白空项、可带端口", () => {
    const config = loadConfig({
      ...BASE,
      WEB_ALLOWED_HOSTS: "example.com, 192.168.1.10:3080 ,,http://nas.lan/",
    });
    assert.deepEqual(config.allowedHosts, ["example.com", "192.168.1.10:3080", "nas.lan"]);
    assert.deepEqual(loadConfig({ ...BASE, WEB_ALLOWED_HOSTS: "  " }).allowedHosts, []);
  });

  it("EVENING_BRIEF_CRON 非法拒绝启动，合法则生效", () => {
    assert.throws(
      () => loadConfig({ ...BASE, EVENING_BRIEF_CRON: "not-cron" }),
      /EVENING_BRIEF_CRON/,
    );
    const config = loadConfig({ ...BASE, EVENING_BRIEF_CRON: "30 20 * * *" });
    assert.equal(config.eveningBriefCron, "30 20 * * *");
  });

  it("非回环 HOST 无 token 拒绝启动，有 token 允许", () => {
    assert.throws(() => loadConfig({ ...BASE, HOST: "0.0.0.0" }), /WEB_API_TOKEN/);
    const config = loadConfig({ ...BASE, HOST: "0.0.0.0", WEB_API_TOKEN: SECRET });
    assert.equal(config.webApiToken, SECRET);
  });

  it("非回环 HOST 配弱 token 拒绝启动；回环只告警不打断", () => {
    assert.throws(
      () => loadConfig({ ...BASE, HOST: "0.0.0.0", WEB_API_TOKEN: "t".repeat(16) }),
      /至少 32 字符/,
    );
    // 回环地址是本地零配置场景，短 token 不该让进程起不来
    const local = loadConfig({ ...BASE, WEB_API_TOKEN: "t".repeat(8) });
    assert.equal(local.webApiToken, "t".repeat(8));
  });

  it("HOST 归一化 scheme；误写端口给出明确报错（IPv6 不受影响）", () => {
    assert.equal(loadConfig({ ...BASE, HOST: "http://127.0.0.1" }).host, "127.0.0.1");
    assert.throws(() => loadConfig({ ...BASE, HOST: "127.0.0.1:3080" }), /端口/);
    assert.throws(() => loadConfig({ ...BASE, HOST: "http://localhost:3080" }), /端口/);
    // 方括号 IPv6 后面再接端口同样属于「把端口写进 HOST」
    assert.throws(() => loadConfig({ ...BASE, HOST: "[::1]:3080" }), /端口/);
    // IPv6 字面量含多个冒号/方括号，不能被误判成「主机:端口」
    assert.equal(loadConfig({ ...BASE, HOST: "[::1]" }).host, "[::1]");
  });

  it("IPv6 字面量：listen 用主机剥方括号，展示用主机补方括号（曾让 daemon 起不来）", async () => {
    // 回归：配置接受 URL 形态的 `[::1]`，但 Node 的 listen 不接受带方括号的字面量
    // （`getaddrinfo ENOTFOUND`）。这里既钉住两个纯函数，也真的监听一次 ::1，
    // 让「配置通过但启动即失败」这个回归在单测层面就能复现。
    const cfg = loadConfig({ ...BASE, HOST: "[::1]" });
    assert.equal(cfg.host, "[::1]", "配置保留展示形态");
    assert.equal(bindHost(cfg.host), "::1", "listen 必须剥方括号");
    assert.equal(urlHost(cfg.host), "[::1]", "URL 展示保留方括号");

    // 不带方括号的写法同样可用；URL 展示会自动补回方括号（否则 http://::1:3080 非法）
    assert.equal(bindHost("::1"), "::1");
    assert.equal(urlHost("::1"), "[::1]");
    assert.equal(bindHost("127.0.0.1"), "127.0.0.1");
    assert.equal(urlHost("127.0.0.1"), "127.0.0.1");

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, bindHost(cfg.host), () => server.close(() => resolve()));
    });
  });

  it("QWeather 必须成对配置", () => {
    assert.throws(() => loadConfig({ ...BASE, QWEATHER_API_HOST: "h.example.com" }), /同时/);
    assert.throws(() => loadConfig({ ...BASE, QWEATHER_KEY: "k" }), /同时/);
    const config = loadConfig({
      ...BASE,
      QWEATHER_API_HOST: "https://h.example.com/",
      QWEATHER_KEY: "k",
    });
    assert.equal(config.qweatherHost, "h.example.com");
  });

  it("DAILY_BRIEF_CRON 非法拒绝启动", () => {
    assert.throws(() => loadConfig({ ...BASE, DAILY_BRIEF_CRON: "not-cron" }), /cron/);
  });

  it("ALERT_WATCH_CRON 非法拒绝启动，合法则生效", () => {
    assert.throws(() => loadConfig({ ...BASE, ALERT_WATCH_CRON: "not-cron" }), /cron/);
    const config = loadConfig({ ...BASE, ALERT_WATCH_CRON: "*/5 * * * *" });
    assert.equal(config.alertWatchCron, "*/5 * * * *");
  });

  it("WORKDAY_WATCH_CRON 非法拒绝启动，合法则生效", () => {
    assert.throws(() => loadConfig({ ...BASE, WORKDAY_WATCH_CRON: "not-cron" }), /cron/);
    const config = loadConfig({ ...BASE, WORKDAY_WATCH_CRON: "0 6 * * *" });
    assert.equal(config.workdayWatchCron, "0 6 * * *");
  });

  it("BACKUP_CRON 非法拒绝启动，合法则生效", () => {
    assert.throws(() => loadConfig({ ...BASE, BACKUP_CRON: "not-cron" }), /BACKUP_CRON/);
    const config = loadConfig({ ...BASE, BACKUP_CRON: "30 2 * * *" });
    assert.equal(config.backupCron, "30 2 * * *");
  });

  it("BACKUP_KEEP 默认 14，且必须是 1..365 的整数", () => {
    assert.equal(loadConfig(BASE).backupKeep, 14);
    for (const bad of ["0", "366", "-1", "1.5", "abc"]) {
      assert.throws(() => loadConfig({ ...BASE, BACKUP_KEEP: bad }), /BACKUP_KEEP/, bad);
    }
    assert.equal(loadConfig({ ...BASE, BACKUP_KEEP: "1" }).backupKeep, 1);
    assert.equal(loadConfig({ ...BASE, BACKUP_KEEP: "365" }).backupKeep, 365);
  });

  it("WORKDAY_REMIND_DAYS_BEFORE 非法拒绝启动，合法则生效", () => {
    assert.throws(
      () => loadConfig({ ...BASE, WORKDAY_REMIND_DAYS_BEFORE: "abc" }),
      /WORKDAY_REMIND_DAYS_BEFORE/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, WORKDAY_REMIND_DAYS_BEFORE: "-1" }),
      /WORKDAY_REMIND_DAYS_BEFORE/,
    );
    const config = loadConfig({ ...BASE, WORKDAY_REMIND_DAYS_BEFORE: "5" });
    assert.equal(config.workdayRemindDaysBefore, 5);
  });

  it("ALERT_MIN_LEVEL 非法拒绝启动，合法则生效", () => {
    assert.throws(() => loadConfig({ ...BASE, ALERT_MIN_LEVEL: "purple" }), /ALERT_MIN_LEVEL/);
    const config = loadConfig({ ...BASE, ALERT_MIN_LEVEL: "orange" });
    assert.equal(config.alertMinLevel, "orange");
  });

  it("PORT 非法拒绝启动", () => {
    assert.throws(() => loadConfig({ ...BASE, PORT: "0" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE, PORT: "99999" }), /PORT/);
  });

  it("PROFILE_ROUTE_SECRETS_JSON 校验", () => {
    assert.throws(() => loadConfig({ ...BASE, PROFILE_ROUTE_SECRETS_JSON: "{bad" }), /JSON/);
    assert.throws(
      () => loadConfig({ ...BASE, PROFILE_ROUTE_SECRETS_JSON: '{"default":"short"}' }),
      /32 字符/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, PROFILE_ROUTE_SECRETS_JSON: `{"Bad Name":"${"a".repeat(64)}"}` }),
      /不合法/,
    );
    const config = loadConfig({
      ...BASE,
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }),
    });
    assert.equal(config.profileRouteSecrets.default, SECRET);
  });

  it("PROFILE_TOKENS_JSON：合法映射生效；非 JSON / 短 token / 非法名 / 重复 token / 与 master 相同都拒绝", () => {
    const bestie = "b".repeat(64);
    const config = loadConfig({
      ...BASE,
      WEB_API_TOKEN: SECRET,
      PROFILE_TOKENS_JSON: JSON.stringify({ bestie }),
    });
    assert.deepEqual(config.profileTokens, { bestie });

    for (const [name, raw] of [
      ["非法 JSON", "{not-json"],
      ["不是对象", JSON.stringify(["a"])],
      ["token 过短", JSON.stringify({ bestie: "short" })],
      ["非字符串", JSON.stringify({ bestie: 123 })],
      ["非法 Profile 名", JSON.stringify({ "Bad Name": bestie })],
      ["重复 token", JSON.stringify({ bestie, default: bestie })],
      ["与 master 相同", JSON.stringify({ bestie: SECRET })],
    ] as const) {
      assert.throws(
        () => loadConfig({ ...BASE, WEB_API_TOKEN: SECRET, PROFILE_TOKENS_JSON: raw }),
        /PROFILE_TOKENS_JSON/,
        name,
      );
    }
    // 未配置时为空对象（退化为单 token 模式）
    assert.deepEqual(loadConfig({ ...BASE, WEB_API_TOKEN: SECRET }).profileTokens, {});
  });

  it("RATE_LIMIT_PER_MINUTE / TRUST_PROXY：默认值与非法值", () => {
    const base = loadConfig(BASE);
    assert.equal(base.rateLimitPerMinute, 120);
    assert.equal(base.trustProxy, false);
    assert.equal(loadConfig({ ...BASE, RATE_LIMIT_PER_MINUTE: "30" }).rateLimitPerMinute, 30);
    assert.equal(loadConfig({ ...BASE, RATE_LIMIT_PER_MINUTE: "0" }).rateLimitPerMinute, 0);
    assert.throws(
      () => loadConfig({ ...BASE, RATE_LIMIT_PER_MINUTE: "-1" }),
      /RATE_LIMIT_PER_MINUTE/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, RATE_LIMIT_PER_MINUTE: "abc" }),
      /RATE_LIMIT_PER_MINUTE/,
    );
    assert.equal(loadConfig({ ...BASE, TRUST_PROXY: "1" }).trustProxy, true);
    assert.throws(() => loadConfig({ ...BASE, TRUST_PROXY: "treu" }), /TRUST_PROXY/);
  });

  it("Profile 名校验", () => {
    assert.equal(parseProfileId("default"), "default");
    assert.throws(() => parseProfileId(undefined), /HERMES_PROFILE/);
    assert.throws(() => parseProfileId("大写"), /HERMES_PROFILE/);
    assert.throws(() => parseProfileId("-leading"), /HERMES_PROFILE/);
  });
});
