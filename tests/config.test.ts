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
    assert.equal(config.defaultCity, "北京");
    assert.equal(config.webApiToken, undefined);
  });

  it("非回环 HOST 无 token 拒绝启动，有 token 允许", () => {
    assert.throws(() => loadConfig({ ...BASE, HOST: "0.0.0.0" }), /WEB_API_TOKEN/);
    const config = loadConfig({ ...BASE, HOST: "0.0.0.0", WEB_API_TOKEN: "t".repeat(16) });
    assert.equal(config.webApiToken, "t".repeat(16));
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
