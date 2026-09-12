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
