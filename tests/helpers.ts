import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDatabase } from "../src/core/database.js";
import { cancelPendingDrain } from "../src/core/notify.js";
import {
  initRuntime,
  resetRuntimeForTests,
  type PublishInput,
  type Services,
} from "../src/core/registry.js";
import { ensureProfile } from "../src/core/settings.js";

export interface Published {
  profileId: string;
  input: PublishInput;
}

export interface TestEnv {
  db: DatabaseSync;
  config: ResolvedConfig;
  dir: string;
  published: Published[];
}

export function makeTestEnv(extraEnv: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "life-assistant-test-"));
  const config = loadConfig({ DATA_DIR: dir, HERMES_PROFILE: "default", ...extraEnv });
  const db = openDatabase(config.dbPath);
  const published: Published[] = [];
  const services: Services = {
    publishProfile: async (profileId, input) => {
      published.push({ profileId, input });
      return { id: `n-${published.length}`, deduped: false };
    },
    publishGlobal: async (input) => {
      published.push({ profileId: "*", input });
      return { materialized: 1 };
    },
  };
  initRuntime({ db, config, services });
  ensureProfile(db, "default");
  return { db, config, dir, published };
}

export function cleanupTestEnv(env: TestEnv): void {
  resetRuntimeForTests();
  cancelPendingDrain();
  if (env.db.isOpen) env.db.close();
  rmSync(env.dir, { recursive: true, force: true });
}

export const SECRET = "a".repeat(64);

/**
 * 构造 QWeather v1 实时天气响应体（`GET /weather/v1/current/{lat}/{lon}`）。
 * 默认值刻意与旧 v7 mock 的展示结果一致（26°C / 28°C / 70% / 12 km/h / 多云），
 * 让既有断言尽量不变；需要验证单位换算时显式传 windMs / humidity。
 */
export function v1Current(
  over: {
    text?: string;
    temp?: number;
    feelsLike?: number;
    /** [0,1] 小数（v1 口径） */
    humidity?: number;
    /** m/s（走 m/s → km/h 换算） */
    windMs?: number;
    /** km/h（不走换算） */
    windKmh?: number;
  } = {},
): Record<string, unknown> {
  const { text = "多云", temp = 26, feelsLike = 28, humidity = 0.7 } = over;
  const wind =
    over.windMs !== undefined
      ? { speed: { value: over.windMs, unit: "m/s" } }
      : { speed: { value: over.windKmh ?? 12, unit: "km/h" } };
  return {
    metadata: { tag: "test" },
    condition: { text, code: "101" },
    temperature: { value: temp, unit: "°C" },
    feelsLike: { value: feelsLike, unit: "°C" },
    humidity,
    wind,
  };
}

/** 本地某天的零点（带 +08:00 偏移），用作 v1 逐日预报的 forecastStartTime */
export function localDayStart(date: string): string {
  return `${date}T00:00:00+08:00`;
}

/** 构造 v1 逐日预报的一天（`/weather/v1/daily/{lat}/{lon}` 的 days 元素） */
export function v1Day(over: {
  start: string;
  text?: string;
  tMax?: number;
  tMin?: number;
  precipDay?: number;
  precipNight?: number;
}): Record<string, unknown> {
  const { start, text = "晴", tMax = 30, tMin = 24, precipDay = 0, precipNight = 0 } = over;
  return {
    forecastStartTime: start,
    forecastEndTime: start,
    temperatureMax: { value: tMax, unit: "°C" },
    temperatureMin: { value: tMin, unit: "°C" },
    daytime: {
      condition: { text },
      precipitation: { amount: { value: precipDay, unit: "mm" } },
    },
    // 夜间天气留空，避免与白天文本混淆；降水单独给
    nighttime: {
      condition: { text: "" },
      precipitation: { amount: { value: precipNight, unit: "mm" } },
    },
  };
}

/** 构造 v1 逐日预报响应体 */
export function v1Daily(days: Record<string, unknown>[]): Record<string, unknown> {
  return { metadata: { tag: "test" }, days };
}
