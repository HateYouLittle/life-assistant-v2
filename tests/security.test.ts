import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  applySecureUmask,
  buildHostAllowList,
  createRequestGuard,
  hardenDataDir,
} from "../src/core/security.js";
import { SECRET } from "./helpers.js";

/**
 * Host/Origin 守卫：DNS rebinding、跨站 Origin、IPv6、默认端口省略、WEB_ALLOWED_HOSTS。
 * 守卫是纯函数（只读 req.headers），因此直接喂伪造的 IncomingMessage，
 * 不必真的监听端口。
 */

const BASE = { DATA_DIR: "/tmp/la-security-test" };

function request(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function guardFor(extraEnv: Record<string, string> = {}) {
  const config = loadConfig({ ...BASE, ...extraEnv });
  return { config, guard: createRequestGuard(config) };
}

describe("Host/Origin 请求守卫", () => {
  it("默认回环配置：localhost / 127.0.0.1 / [::1] 带监听端口放行（大小写不敏感）", () => {
    const { guard } = guardFor();
    for (const host of ["127.0.0.1:3080", "localhost:3080", "[::1]:3080", "LOCALHOST:3080"]) {
      assert.deepEqual(guard(request({ host })), { ok: true }, host);
    }
  });

  it("DNS rebinding：Host 是攻击者域名时 403，并给出中文说明", () => {
    const { guard } = guardFor();
    const result = guard(request({ host: "attacker.com:3080" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.match(result.body, /Host 不被允许/);
    assert.match(result.body, /WEB_ALLOWED_HOSTS/, "提示用户如何显式放行");
  });

  it("Host 缺失拒绝；回环主机名不限端口，非回环主机端口必须精确匹配", () => {
    const { guard } = guardFor();
    const missing = guard(request({}));
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 403);
      assert.match(missing.body, /Host 不被允许/);
    }
    // 回环按主机名放行：Host 端口不参与路由（HTTP 测试以端口 0 监听也能访问）
    assert.equal(guard(request({ host: "127.0.0.1:9999" })).ok, true);
    // 非回环主机来自 config.host：<host>:<port> 精确匹配
    const named = guardFor({ HOST: "life.example.com", WEB_API_TOKEN: SECRET }).guard;
    assert.equal(named(request({ host: "life.example.com:3080" })).ok, true);
    assert.equal(named(request({ host: "life.example.com:9999" })).ok, false);
  });

  it("没有 Origin 头一律放行（CLI/agent 非浏览器请求）", () => {
    const { guard } = guardFor();
    assert.deepEqual(guard(request({ host: "127.0.0.1:3080" })), { ok: true });
  });

  it("同源 Origin 放行；跨站 Origin 403；file:// 与 null 也拒绝", () => {
    const { guard } = guardFor();
    assert.deepEqual(guard(request({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })), {
      ok: true,
    });
    assert.deepEqual(
      guard(request({ host: "127.0.0.1:3080", origin: "http://localhost:3080" })),
      { ok: true },
      "同机不同写法的主机也应属于允许集合",
    );

    const crossSite = guard(request({ host: "127.0.0.1:3080", origin: "https://evil.example" }));
    assert.equal(crossSite.ok, false);
    if (!crossSite.ok) {
      assert.equal(crossSite.status, 403);
      assert.match(crossSite.body, /Origin 不被允许/);
    }

    for (const origin of ["null", "file://", "chrome-extension://abc"]) {
      assert.equal(
        guard(request({ host: "127.0.0.1:3080", origin })).ok,
        false,
        `${origin} 不是合法 http(s) 来源`,
      );
    }

    // Origin 必须端口精确：Host 回环不限端口，但「同机另一个端口上的网页」不算同源
    assert.equal(
      guard(request({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" })).ok,
      false,
      "跨端口来源必须拒绝，否则本地其它服务的页面可以跨站驱动 MCP",
    );
  });

  it("IPv6：配置 HOST=[::1] 时 Host 与 Origin 都用方括号形态", () => {
    const { config, guard } = guardFor({ HOST: "[::1]" });
    assert.equal(config.host, "[::1]");
    assert.deepEqual(guard(request({ host: "[::1]:3080" })), { ok: true });
    assert.deepEqual(guard(request({ host: "[::1]:3080", origin: "http://[::1]:3080" })), {
      ok: true,
    });
    // 裸 IPv6 写法只出现在配置里；Host 头必须带方括号
    assert.equal(guard(request({ host: ":::1" })).ok, false);
  });

  it("默认端口可省略：PORT=80 时 Host=localhost 与 localhost:80 都放行", () => {
    const { guard } = guardFor({ PORT: "80" });
    assert.deepEqual(guard(request({ host: "localhost" })), { ok: true });
    assert.deepEqual(guard(request({ host: "localhost:80" })), { ok: true });
    assert.deepEqual(guard(request({ host: "localhost", origin: "http://localhost" })), {
      ok: true,
    });
  });

  it("WEB_ALLOWED_HOSTS：裸主机不限端口，带端口条目只放行该端口", () => {
    const { guard } = guardFor({ WEB_ALLOWED_HOSTS: "mybox.lan,other.lan:8080" });
    assert.deepEqual(guard(request({ host: "mybox.lan:3080" })), { ok: true });
    assert.deepEqual(guard(request({ host: "mybox.lan:9999" })), { ok: true }, "裸主机不限端口");
    assert.deepEqual(guard(request({ host: "other.lan:8080" })), { ok: true });
    assert.equal(guard(request({ host: "other.lan:3080" })).ok, false, "带端口条目必须精确匹配");
    assert.equal(guard(request({ host: "evil.lan:3080" })).ok, false);
    // Origin 用同一个允许集合
    assert.deepEqual(guard(request({ host: "mybox.lan:3080", origin: "http://mybox.lan:3080" })), {
      ok: true,
    });
  });

  it("非回环 HOST：自身主机名放行；绑定 0.0.0.0 时回环 Host 仍可访问", () => {
    const named = guardFor({ HOST: "life.example.com", WEB_API_TOKEN: SECRET });
    assert.deepEqual(named.guard(request({ host: "life.example.com:3080" })), { ok: true });
    assert.equal(named.guard(request({ host: "attacker.com:3080" })).ok, false);

    const wildcard = guardFor({ HOST: "0.0.0.0", WEB_API_TOKEN: SECRET });
    assert.deepEqual(
      wildcard.guard(request({ host: "127.0.0.1:3080" })),
      { ok: true },
      "通配绑定地址不是真实 Host，不能靠它放行，但本机回环访问仍应可用",
    );
    // 局域网 IP 必须显式进 WEB_ALLOWED_HOSTS
    const lan = guardFor({
      HOST: "0.0.0.0",
      WEB_API_TOKEN: SECRET,
      WEB_ALLOWED_HOSTS: "192.168.1.10:3080",
    });
    assert.deepEqual(lan.guard(request({ host: "192.168.1.10:3080" })), { ok: true });
  });

  it("buildHostAllowList 导出：裸主机与带端口条目落在不同集合", () => {
    const { config } = guardFor({ WEB_ALLOWED_HOSTS: "Bare.Lan,withport.lan:8080" });
    const list = buildHostAllowList(config);
    assert.ok(list.hostOnly.has("bare.lan"));
    assert.ok(list.hostWithPort.has("withport.lan:8080"));
  });
});

describe("文件权限加固", () => {
  it("applySecureUmask 把默认 umask 收紧到 077", () => {
    const previous = process.umask();
    try {
      applySecureUmask();
      assert.equal(process.umask(), 0o077);
    } finally {
      process.umask(previous);
    }
  });

  it("hardenDataDir：数据目录 0700、DB/WAL/SHM 0600、备份目录 0700、*.db 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "la-harden-"));
    try {
      const dataDir = join(dir, "data");
      const backupDir = join(dataDir, "backups");
      mkdirSync(backupDir, { recursive: true });
      const dbPath = join(dataDir, "life-assistant.db");
      writeFileSync(dbPath, "db");
      writeFileSync(`${dbPath}-wal`, "wal");
      writeFileSync(`${dbPath}-shm`, "shm");
      writeFileSync(join(backupDir, "life-assistant-20260101-000000.db"), "b1");
      writeFileSync(join(backupDir, "life-assistant-pre-v3-20260101-000000.db"), "b2");

      hardenDataDir(dataDir, dbPath, backupDir);

      if (process.platform !== "win32") {
        assert.equal(statSync(dataDir).mode & 0o777, 0o700);
        assert.equal(statSync(dbPath).mode & 0o777, 0o600);
        assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600);
        assert.equal(statSync(`${dbPath}-shm`).mode & 0o777, 0o600);
        assert.equal(statSync(backupDir).mode & 0o777, 0o700);
        assert.equal(
          statSync(join(backupDir, "life-assistant-20260101-000000.db")).mode & 0o777,
          0o600,
        );
        assert.equal(
          statSync(join(backupDir, "life-assistant-pre-v3-20260101-000000.db")).mode & 0o777,
          0o600,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hardenDataDir：路径不存在时只跳过、不抛（best-effort）", () => {
    const dir = mkdtempSync(join(tmpdir(), "la-harden-missing-"));
    try {
      assert.doesNotThrow(() =>
        hardenDataDir(
          join(dir, "no-data"),
          join(dir, "no-data", "db"),
          join(dir, "no-data", "bak"),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
