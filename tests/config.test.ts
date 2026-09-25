import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, parseProfileId } from "../src/config.js";
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
    assert.equal(config.alertWatchCron, "*/20 * * * *");
    assert.equal(config.alertMinLevel, "blue");
    assert.equal(config.workdayWatchCron, "0 7 * * *");
    assert.equal(config.workdayRemindDaysBefore, 3);
    assert.equal(config.defaultCity, "北京");
    assert.equal(config.webApiToken, undefined);
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

  it("Profile 名校验", () => {
    assert.equal(parseProfileId("default"), "default");
    assert.throws(() => parseProfileId(undefined), /HERMES_PROFILE/);
    assert.throws(() => parseProfileId("大写"), /HERMES_PROFILE/);
    assert.throws(() => parseProfileId("-leading"), /HERMES_PROFILE/);
  });
});
