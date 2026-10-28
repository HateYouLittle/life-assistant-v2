import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, it } from "node:test";
import {
  type ChannelDeliveryInput,
  openclawChannel,
  resetOpenclawGlobalTokenWarnings,
} from "../src/core/channels.js";
import { cancelPendingDrain, drainDue, getPushRoute, publishProfile } from "../src/core/notify.js";
import { ensureProfile, setSetting } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-17 / S-01：OpenClaw 通道的凭据边界。
 *
 * 修复前的语义：任何 profile 都能给自己配一条 openclaw 回环路由（任意端口/路径），
 * daemon 投递时把 **全局** OPENCLAW_HOOK_TOKEN 发到那个 URL —— 一个有独立 Profile token
 * 的隔离用户只要改自己的推送路由，就能把运维者的 hooks token 引到自己的本地服务上。
 *
 * 修复后的契约（组合方案：per-profile secret 优先 + 三档准入 + /hooks/ 路径收紧）：
 * 1. 隔离用户（登记在 PROFILE_TOKENS_JSON **且不是部署自身 profile**）**配置/换 URL** 时必须
 *    提供自己的 route secret；没有就**明确失败**，绝不回退全局 token；
 * 1b.（N-2）收紧前已落库的存量隔离路由**可以重新启用**（投递层本来就照投），但走与投递层
 *    同口径的一次性 warn —— 旧实现是「可停用、不可重新启用」的单向门，误点一次就开不回来；
 * 2. 提供了独立 secret 时，投递的 Authorization 必须用该 secret（而不是全局 token）；
 * 3. 部署自身 profile（HERMES_PROFILE，缺省 default）即使也登记了 Profile token，仍按运维者
 *    本人处理，可以继续用全局 OPENCLAW_HOOK_TOKEN（本部署 default|push_route 就属于这种）；
 * 4. 未登记独立 token 的 profile（PROFILE_TOKENS_JSON 为空或未含它）行为不变，按 master 代表；
 * 5. openclaw 路由路径只接受 /hooks/<name>。
 *
 * 「有牙齿」：断言的是真实 HTTP 请求收到的 Authorization 头，而不是函数返回值。
 * - 删掉 notify/index.ts 的准入门槛 → 用例 ② 在「配置必须失败」与「不得有请求」两处失败；
 * - 把 channels.ts 的凭据优先级改成「先全局后 profile」→ 用例 ③ 失败；
 * - 把「部署自身 profile」判断去掉（回到「登记即隔离」）→ 用例 ①/④ 变红；
 * - 把「重新启用」改回 fail（单向门）→ 用例 ⑨ 变红。
 */

/** master 的 WEB_API_TOKEN（运维者身份，与各 Profile token 不同） */
const MASTER_TOKEN = "m".repeat(32);
/** 部署自身 profile `default` 自己的 Profile token（本部署就是这样） */
const OWNER_TOKEN = "o".repeat(32);
/** 真正的隔离用户 bestie 的 Profile token */
const BESTIE_TOKEN = "b".repeat(32);
/** bestie 自己的 route secret（P2-17 后 openclaw 隔离用户路由必须提供） */
const BESTIE_SECRET = "s".repeat(40);
/** daemon 全局 hooks token（属于运维者 / 部署自身 profile） */
const GLOBAL_HOOK_TOKEN = "global-openclaw-hook-token";

interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** 起一个本地 http 服务，记录每次请求的 URL/头/正文（用于断言 Authorization 头） */
function withCaptureServer(
  fn: (url: string, captured: Captured[], server: Server) => Promise<void>,
  path = "/hooks/life-default",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push({
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fn(url, captured, server)
        .then(() => server.close(() => resolve()))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

async function withOpenclawToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_HOOK_TOKEN;
  if (token === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
  else process.env.OPENCLAW_HOOK_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
    else process.env.OPENCLAW_HOOK_TOKEN = previous;
  }
}

/** 投递层的一次性告警按 daemon 进程环境判定，这里显式摆好环境快照 */
async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tool(env: TestEnv, args: Record<string, unknown>, profileId: string) {
  return notifyTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 0 }),
    },
  });
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function deliveryRows(env: TestEnv): Record<string, unknown>[] {
  return env.db.prepare("SELECT * FROM deliveries").all() as Record<string, unknown>[];
}

/**
 * 本部署形态：PROFILE_TOKENS_JSON 同时登记了运维者自己的 default 与隔离用户 bestie，
 * HERMES_PROFILE=default 指出「部署自身 profile」。
 */
function deploymentEnv(extra: Record<string, string> = {}): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER_TOKEN,
    HERMES_PROFILE: "default",
    PROFILE_TOKENS_JSON: JSON.stringify({ default: OWNER_TOKEN, bestie: BESTIE_TOKEN }),
    ...extra,
  });
}

function openclawDeliveryInput(
  url: string,
  over: Partial<ChannelDeliveryInput> = {},
): ChannelDeliveryInput {
  return {
    profileId: "bestie",
    notificationId: "n-openclaw-sec",
    kind: "test.kind",
    title: "OpenClaw 标题",
    bodyMd: "OpenClaw 正文",
    createdAt: "2026-10-24T00:00:00.000Z",
    requestId: "request-openclaw-sec-1",
    generation: 0,
    route: { name: "openclaw-route", url },
    ...over,
  };
}

describe("OpenClaw 通道凭据边界（P2-17）", () => {
  it("① 部署自身 profile（default，也登记了 Profile token）仍可配置 openclaw 并用全局 token", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv();
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "default");
          assert.ok(!configured.isError, `运维者本人不得被误判成隔离用户: ${text(configured)}`);

          const pub = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "运维者通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "部署自身 profile 的路由必须照常投递");
          assert.equal(captured[0]?.headers.authorization, `Bearer ${GLOBAL_HOOK_TOKEN}`);
          const row = deliveryRows(env).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "sent");
        }, "/hooks/life-default");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("② 隔离用户（bestie）没有自己的 secret 时配置 openclaw：明确 fail，且全局 token 不发往该 URL", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv();
      try {
        await withCaptureServer(async (url, captured) => {
          const result = tool(env, { action: "route", channel: "openclaw", url }, "bestie");
          assert.equal(result.isError, true, "隔离用户不得借用全局 hooks token 配置 openclaw");
          assert.match(text(result), /仅部署自身 profile|独立 secret/);
          assert.equal(getPushRoute(env.db, "bestie"), null, "失败时不得落任何路由");

          // 配置被拒后即便发布通知，也不该有任何请求到达该 URL（更不该带上全局 token）
          publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "不该被投递",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 0, "被拒的路由不得产生投递请求");
          assert.equal(deliveryRows(env).length, 0, "无路由时不应落投递行");
        }, "/hooks/attacker");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("③ 隔离用户配置了自己的 secret：投递的 Authorization 是 profile secret，不是全局 token", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv({
        PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ bestie: BESTIE_SECRET }),
      });
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "bestie");
          assert.ok(!configured.isError, `带独立 secret 时应允许配置: ${text(configured)}`);

          const pub = publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "隔离用户通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "应当真的投递到该 URL");
          const request = captured[0];
          assert.ok(request !== undefined);
          assert.equal(request.headers.authorization, `Bearer ${BESTIE_SECRET}`);
          assert.notEqual(
            request.headers.authorization,
            `Bearer ${GLOBAL_HOOK_TOKEN}`,
            "隔离用户的投递绝不能带上运维者的全局 token",
          );
          const row = deliveryRows(env).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "sent");
        }, "/hooks/bestie");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("④ 口径由 HERMES_PROFILE 决定：把它设成 bestie，则 bestie 可用全局 token、default 被拒", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv({ HERMES_PROFILE: "bestie" });
      try {
        await withCaptureServer(async (url, captured) => {
          // bestie 现在是部署自身 profile → 允许，且投递用全局 token
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "bestie");
          assert.ok(!configured.isError, `部署自身 profile 应允许配置: ${text(configured)}`);
          publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "部署自身通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.headers.authorization, `Bearer ${GLOBAL_HOOK_TOKEN}`);

          // 反向：default 现在只是「登记了 token 的隔离用户」→ 拒绝
          const denied = tool(
            env,
            { action: "route", channel: "openclaw", url: `${url}?x=1` },
            "default",
          );
          assert.equal(denied.isError, true, "非部署自身的登记用户仍必须自带 secret");
          assert.equal(getPushRoute(env.db, "default"), null);
        }, "/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Ax");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("⑤ 未登记独立 token 的 profile 行为不变（仍按 master 代表用全局 token）", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv();
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "guest");
          assert.ok(!configured.isError, `未登记 token 的 profile 应允许配置: ${text(configured)}`);
          publishProfile(env.db, env.config, "guest", {
            kind: "test.kind",
            title: "零配置通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.headers.authorization, `Bearer ${GLOBAL_HOOK_TOKEN}`);
        }, "/hooks/guest");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("⑥ PROFILE_TOKENS_JSON 为空：所有 profile 仍可用全局 token（既有零配置行为）", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = makeTestEnv({ WEB_API_TOKEN: MASTER_TOKEN, HERMES_PROFILE: "default" });
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "bestie");
          assert.ok(!configured.isError, `无独立身份时不应拦截: ${text(configured)}`);
          publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "无身份部署通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.headers.authorization, `Bearer ${GLOBAL_HOOK_TOKEN}`);
        }, "/hooks/bestie");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("⑦ 路由路径收紧：非 /hooks/<name> 一律拒绝（工具层与通道层）", async () => {
    const env = deploymentEnv({
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ bestie: BESTIE_SECRET }),
    });
    try {
      for (const url of [
        "http://127.0.0.1:18789/hook",
        "http://127.0.0.1:18789/",
        "http://127.0.0.1:18789/hooks",
        "http://127.0.0.1:18789/admin?x=1",
      ]) {
        assert.throws(() => openclawChannel.validateRoute({ url }), /\/hooks\//, url);
        // 部署自身 profile 也一样拒绝：路径收紧与身份无关
        const viaTool = tool(env, { action: "route", channel: "openclaw", url }, "default");
        assert.equal(viaTool.isError, true, `工具层应拒绝 ${url}`);
        assert.match(text(viaTool), /\/hooks\//);
        assert.equal(getPushRoute(env.db, "default"), null);
      }
      assert.equal(
        openclawChannel.validateRoute({ url: "http://127.0.0.1:18789/hooks/life-default" }),
        "http://127.0.0.1:18789/hooks/life-default",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("⑧ 没有全局 token 时 profile secret 单独可用；两者都没有时错误信息点明两个来源", async () => {
    await withOpenclawToken(undefined, async () => {
      await withCaptureServer(async (url, captured) => {
        const outcome = await openclawChannel.deliver(
          openclawDeliveryInput(url, { secret: BESTIE_SECRET }),
        );
        assert.equal(outcome.status, "sent");
        assert.equal(captured[0]?.headers.authorization, `Bearer ${BESTIE_SECRET}`);
      }, "/hooks/bestie");

      const missing = await openclawChannel.deliver(
        openclawDeliveryInput("http://127.0.0.1:1/hooks/bestie"),
      );
      assert.equal(missing.status, "terminal_failure");
      if (missing.status === "terminal_failure") {
        assert.match(missing.error, /PROFILE_ROUTE_SECRETS_JSON/);
        assert.match(missing.error, /OPENCLAW_HOOK_TOKEN/);
      }
    });
  });

  it("⑨ 收紧前遗留的隔离用户 openclaw 路由：可重新启用 + 同口径一次性 warn + requeue（N-2）", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = deploymentEnv();
      try {
        resetOpenclawGlobalTokenWarnings();
        ensureProfile(env.db, "bestie");
        // 模拟 P2-17 之前落库的路由：openclaw + 无 profile secret。先在启用状态下发一条通知，
        // 这样才有「停用期间落 fallback 的待投递行」可以验证 requeue。
        setSetting(env.db, "bestie", "push_route", {
          name: "life-assistant-bestie",
          url: "http://127.0.0.1:9/hooks/legacy",
          platform: null,
          enabled: true,
          channel: "openclaw",
        });
        const pub = publishProfile(env.db, env.config, "bestie", {
          kind: "test.kind",
          title: "存量路由通知",
          blocks: {},
        });
        // publishProfile 会排一次去抖 drain；测试用显式 drainDue，避免它把行投掉
        cancelPendingDrain();
        const row = (): Record<string, unknown> | undefined =>
          deliveryRows(env).find((r) => r.notification_id === pub.id);
        assert.equal(row()?.status, "queued");

        // 用户误点「停用」→ drain 把这批待投递打成 fallback
        const disabled = tool(env, { action: "route", enabled: false }, "bestie");
        assert.ok(!disabled.isError, text(disabled));
        env.db.exec("UPDATE deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
        await drainDue(env.db, env.config);
        assert.equal(row()?.status, "fallback", "停用期间的待投递应落 fallback");

        // 重新启用：必须是成功（不再是单向门），且打 1 条与投递层同口径的 warn
        const lines: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
          lines.push(args.map((a) => String(a)).join(" "));
        };
        let enabledResult: { isError?: boolean; content: { text: string }[] };
        try {
          enabledResult = tool(env, { action: "route", enabled: true }, "bestie");
        } finally {
          console.error = originalError;
        }
        assert.ok(!enabledResult.isError, `存量路由必须能重新启用: ${text(enabledResult)}`);
        assert.equal(getPushRoute(env.db, "bestie")?.enabled, true, "路由必须真的被启用");
        assert.equal(row()?.status, "queued", "重新启用必须 requeue 停用期间的 fallback 行");
        assert.equal(row()?.generation, 1, "重新入队应递增 generation");
        const warnings = lines.filter(
          (line) => line.includes('"bestie"') && line.includes("OPENCLAW_HOOK_TOKEN"),
        );
        assert.equal(
          warnings.length,
          1,
          `应恰好 1 条一次性 warn，实际 ${warnings.length} 条：${lines.join(" | ")}`,
        );
        assert.match(warnings[0] ?? "", /PROFILE_ROUTE_SECRETS_JSON/);

        // 一次性：同一 profile 再启用一次不得重复告警
        const again: string[] = [];
        console.error = (...args: unknown[]) => {
          again.push(args.map((a) => String(a)).join(" "));
        };
        try {
          tool(env, { action: "route", enabled: true }, "bestie");
        } finally {
          console.error = originalError;
        }
        assert.equal(
          again.filter((line) => line.includes('"bestie"') && line.includes("OPENCLAW_HOOK_TOKEN"))
            .length,
          0,
          `一次性 warn 不得重复：${again.join(" | ")}`,
        );

        // 准入门槛仍在：隔离用户「配置新 openclaw 路由」（换 URL）依旧必须自带 secret
        const reconfigure = tool(
          env,
          { action: "route", channel: "openclaw", url: "http://127.0.0.1:9/hooks/other" },
          "bestie",
        );
        assert.equal(reconfigure.isError, true, "新配置仍必须自带 secret");
        assert.match(text(reconfigure), /仅部署自身 profile|独立 secret/);
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("⑩ 投递侧：隔离用户回退全局 token 时每个 profile 只告警一次，部署自身不告警", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      await withProcessEnv(
        {
          HERMES_PROFILE: "default",
          PROFILE_TOKENS_JSON: JSON.stringify({ default: OWNER_TOKEN, bestie: BESTIE_TOKEN }),
        },
        async () => {
          resetOpenclawGlobalTokenWarnings();
          const lines: string[] = [];
          const originalError = console.error;
          console.error = (...args: unknown[]) => {
            lines.push(args.map((a) => String(a)).join(" "));
          };
          try {
            await withCaptureServer(async (url, captured) => {
              for (const profileId of ["bestie", "bestie", "default"]) {
                const outcome = await openclawChannel.deliver(
                  openclawDeliveryInput(url, {
                    profileId,
                    requestId: `req-${profileId}-${captured.length}`,
                  }),
                );
                assert.equal(outcome.status, "sent", "告警不得改变投递结果（不拒绝投递）");
                assert.equal(
                  captured[captured.length - 1]?.headers.authorization,
                  `Bearer ${GLOBAL_HOOK_TOKEN}`,
                );
              }
            }, "/hooks/mixed");
          } finally {
            console.error = originalError;
          }

          const bestieWarnings = lines.filter(
            (line) => line.includes('"bestie"') && line.includes("OPENCLAW_HOOK_TOKEN"),
          );
          assert.equal(
            bestieWarnings.length,
            1,
            `隔离用户应只告警一次，实际 ${bestieWarnings.length} 条：${lines.join(" | ")}`,
          );
          assert.match(bestieWarnings[0] ?? "", /PROFILE_ROUTE_SECRETS_JSON/);
          assert.equal(
            lines.filter((line) => line.includes('"default"')).length,
            0,
            "部署自身 profile 回退全局 token 不应告警",
          );
        },
      );
    });
  });
});
