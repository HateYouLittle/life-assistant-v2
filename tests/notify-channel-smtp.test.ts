import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { describe, it } from "node:test";
import { type ChannelOutcome, getChannel, smtpChannel } from "../src/core/channels.js";
import { drainDue, publishProfile, setPushRoute } from "../src/core/notify.js";
import {
  buildSmtpMessage,
  dotStuff,
  encodeHeaderValue,
  parseSmtpRouteUrl,
  resolveSmtpTls,
  sendSmtpMail,
} from "../src/core/smtp.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * SMTP 通道：本地假 SMTP 服务（net.createServer + 脚本化应答）验会话顺序、AUTH、
 * 中文主题编码、错误映射与超时；另有纯函数用例覆盖路由解析/端口加密约定/报文组装。
 *
 * 说明：**TLS 握手成功路径没有单测**——真实握手需要服务器持有一张受信任的证书，
 * 而自签证书会让 `tls.connect` 的默认校验失败（不能为了测试关掉校验）。这里只覆盖
 * 「STARTTLS 命令确实发出、握手失败按传输失败处理」，以及端口→加密方式的纯函数映射。
 */

interface Convo {
  /** 服务器收到的明文命令行（DATA 段之前） */
  lines: string[];
  /** DATA 段内容（不含结尾的 `.` 行） */
  data: string;
  /** AUTH LOGIN 的两段 base64（用户名、密码） */
  authTokens: string[];
}

interface FakeSmtpOptions {
  greeting?: string;
  ehlo?: string;
  mail?: string;
  rcpt?: string;
  dataStart?: string;
  dataEnd?: string;
  authStart?: string;
  authUser?: string;
  authPass?: string;
  /** STARTTLS 回 220 后立刻掐断连接（模拟无法完成握手的服务器） */
  breakAfterStartTls?: boolean;
  /** 接受连接但什么都不回（测总超时） */
  hang?: boolean;
}

const DEFAULT_EHLO = "250-fake.test\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME";

function withFakeSmtp(
  over: FakeSmtpOptions,
  fn: (base: { host: string; port: number }, convo: Convo) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const convo: Convo = { lines: [], data: "", authTokens: [] };
    // net.Server 没有 http.Server 的 closeAllConnections()：自己记连接，收尾时逐个 destroy。
    // 不这么做的话 server.close() 会等客户端长连接，测试进程退不出去（表现为整套挂住）。
    const sockets = new Set<Socket>();
    const server = createServer((socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      if (over.hang === true) return;
      let buffer = "";
      let authStep = 0;
      let dataLines: string[] | null = null;
      let startTls = false;
      const send = (text: string): void => {
        socket.write(`${text}\r\n`);
      };
      const process = (): void => {
        while (true) {
          const eol = buffer.indexOf("\r\n");
          if (eol < 0) return;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          if (dataLines !== null) {
            if (line === ".") {
              convo.data = dataLines.join("\r\n");
              dataLines = null;
              send(over.dataEnd ?? "250 2.0.0 queued");
            } else {
              // 反点填充，还原客户端写入的内容
              dataLines.push(line.replace(/^\.\./, "."));
            }
            continue;
          }
          convo.lines.push(line);
          const verb = (line.split(/\s+/)[0] ?? "").toUpperCase();
          if (verb === "EHLO") {
            send(over.ehlo ?? DEFAULT_EHLO);
            continue;
          }
          if (verb === "STARTTLS") {
            startTls = true;
            send("220 2.0.0 ready to start TLS");
            if (over.breakAfterStartTls === true) socket.destroy();
            continue;
          }
          if (verb === "AUTH") {
            authStep = 1;
            send(over.authStart ?? "334 VXNlcm5hbWU6");
            continue;
          }
          if (authStep === 1) {
            authStep = 2;
            convo.authTokens.push(line);
            send(over.authUser ?? "334 UGFzc3dvcmQ6");
            continue;
          }
          if (authStep === 2) {
            authStep = 3;
            convo.authTokens.push(line);
            send(over.authPass ?? "235 2.7.0 authenticated");
            continue;
          }
          if (verb === "MAIL") {
            send(over.mail ?? "250 2.1.0 ok");
            continue;
          }
          if (verb === "RCPT") {
            send(over.rcpt ?? "250 2.1.5 ok");
            continue;
          }
          if (verb === "DATA") {
            dataLines = [];
            send(over.dataStart ?? "354 go ahead");
            continue;
          }
          if (verb === "QUIT") {
            send("221 2.0.0 bye");
            continue;
          }
          send("502 5.5.2 command not implemented");
        }
      };
      socket.write(`${over.greeting ?? "220 fake ESMTP ready"}\r\n`);
      socket.on("data", (chunk: Buffer) => {
        // STARTTLS 之后进来的是 TLS 握手字节，不能再按明文解析
        if (startTls) return;
        buffer += chunk.toString("utf8");
        process();
      });
      socket.on("error", () => undefined);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const base = { host: "127.0.0.1", port: addr.port };
      const shutdown = (done: () => void): void => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      };
      fn(base, convo).then(
        () => shutdown(resolve),
        (e) => shutdown(() => reject(e)),
      );
    });
  });
}

/** 本地明文路由（测试端口是随机的，故必须显式 `?tls=plain`） */
function plainRoute(base: { host: string; port: number }, query = "tls=plain") {
  return parseSmtpRouteUrl(
    `smtp://user:secret@${base.host}:${base.port}?from=me@example.com&to=you@example.com&${query}`,
  );
}

/** 拆出 DATA 段里的 header 与解码后的正文 */
function parseMessage(data: string): { header: string; body: string } {
  const index = data.indexOf("\r\n\r\n");
  const header = index < 0 ? data : data.slice(0, index);
  const encoded = index < 0 ? "" : data.slice(index + 4);
  return { header, body: Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

function headerValue(header: string, name: string): string {
  const line = header.split("\r\n").find((item) => item.startsWith(`${name}: `));
  return line === undefined ? "" : line.slice(name.length + 2);
}

function decodeRfc2047(value: string): string {
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(value);
  return match === null ? value : Buffer.from(match[1] ?? "", "base64").toString("utf8");
}

describe("SMTP 路由解析", () => {
  it("完整 URL：user/pass、from/to（to 可重复）、默认按端口决定加密方式", () => {
    const route = parseSmtpRouteUrl(
      "smtp://me%40mail:p%40ss@mail.example.com:587?from=me@example.com&to=a@example.com&to=b@example.com",
    );
    assert.equal(route.host, "mail.example.com");
    assert.equal(route.port, 587);
    assert.equal(route.tls, "starttls");
    assert.equal(route.username, "me@mail", "username 必须 percent 解码");
    assert.equal(route.password, "p@ss", "password 必须 percent 解码");
    assert.equal(route.from, "me@example.com");
    assert.deepEqual(route.to, ["a@example.com", "b@example.com"]);
    assert.match(route.url, /^smtp:\/\//, "validateRoute 要把规范化后的 URL 落库");
  });

  it("端口约定：25 明文 / 587 STARTTLS / 465 隐式 TLS，可用 ?tls= 覆盖", () => {
    assert.equal(resolveSmtpTls(25, "smtp"), "plain");
    assert.equal(resolveSmtpTls(587, "smtp"), "starttls");
    assert.equal(resolveSmtpTls(465, "smtp"), "implicit");
    assert.equal(resolveSmtpTls(465, "smtps"), "implicit");
    assert.equal(
      resolveSmtpTls(2525, "smtp"),
      "plain",
      "非标准端口默认明文，避免对明文中继发起握手",
    );
    assert.equal(resolveSmtpTls(2525, "smtp", "starttls"), "starttls");
    assert.equal(resolveSmtpTls(25, "smtp", "plain"), "plain");
    assert.throws(() => resolveSmtpTls(587, "smtp", "ssl"), /tls 参数/);
    assert.equal(
      parseSmtpRouteUrl("smtps://mail.example.com?from=a@example.com&to=b@example.com").tls,
      "implicit",
      "smtps:// 不带端口时默认 465 隐式 TLS",
    );
    assert.equal(
      parseSmtpRouteUrl("smtp://mail.example.com?from=a@example.com&to=b@example.com").port,
      25,
    );
  });

  it("无 user/pass 时不做 AUTH（username/password 为空）", () => {
    const route = parseSmtpRouteUrl(
      "smtp://mail.example.com:25?from=a@example.com&to=b@example.com",
    );
    assert.equal(route.username, undefined);
    assert.equal(route.password, undefined);
  });

  it("坏路由一律拒绝：缺 from/to、非法地址、半截凭据、非 smtp 协议、命令注入", () => {
    const base = "smtp://mail.example.com:587";
    assert.throws(() => parseSmtpRouteUrl(`${base}?to=a@example.com`), /from/);
    assert.throws(() => parseSmtpRouteUrl(`${base}?from=a@example.com`), /收件人/);
    assert.throws(() => parseSmtpRouteUrl(`${base}?from=not-an-email&to=a@example.com`), /from/);
    assert.throws(() => parseSmtpRouteUrl(`${base}?from=a@example.com&to=nope`), /收件人/);
    assert.throws(
      () =>
        parseSmtpRouteUrl(
          `${base}?from=a@example.com&to=${encodeURIComponent("a@b.com\r\nRCPT TO:<evil@x.com>")}`,
        ),
      /收件人/,
      "换行必须挡住（SMTP 命令注入）",
    );
    assert.throws(
      () =>
        parseSmtpRouteUrl(`smtp://user@mail.example.com:587?from=a@example.com&to=b@example.com`),
      /同时提供/,
    );
    assert.throws(
      () => parseSmtpRouteUrl(`ftp://mail.example.com?from=a@example.com&to=b@example.com`),
      /smtp/,
    );
    assert.throws(() => parseSmtpRouteUrl(undefined), /需要 url/);
    assert.throws(() => parseSmtpRouteUrl("  "), /需要 url/);
    assert.throws(() => parseSmtpRouteUrl("不是URL"), /不合法/);
  });
});

describe("SMTP 报文组装", () => {
  it("中文 Subject 走 RFC 2047，ASCII 主题保持原样", () => {
    assert.equal(encodeHeaderValue("Reminder"), "Reminder");
    const encoded = encodeHeaderValue("交房租提醒");
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
    assert.equal(decodeRfc2047(encoded), "交房租提醒");
    // 含换行的主题也必须编码（否则是 header 注入）
    assert.match(encodeHeaderValue("a\r\nBcc: evil@x.com"), /^=\?UTF-8\?B\?/);
  });

  it("报文含 RFC 5322 必填头、UTF-8 base64 正文、CRLF 行结束", () => {
    const message = buildSmtpMessage({
      from: "me@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "日报",
      body: "第一行\n第二行",
      date: new Date("2026-10-20T14:47:57Z"),
      messageId: "<fixed@life-assistant>",
    });
    assert.ok(message.includes("From: <me@example.com>\r\n"));
    assert.ok(message.includes("To: <a@example.com>, <b@example.com>\r\n"));
    assert.ok(message.includes("Date: Tue, 20 Oct 2026 14:47:57 +0000\r\n"));
    assert.ok(message.includes("Message-ID: <fixed@life-assistant>\r\n"));
    assert.ok(message.includes("MIME-Version: 1.0\r\n"));
    assert.ok(message.includes("Content-Type: text/plain; charset=utf-8\r\n"));
    assert.ok(message.includes("Content-Transfer-Encoding: base64\r\n"));
    assert.ok(!/[^\r]\n/.test(message), "不允许裸 LF");
    const { header, body } = parseMessage(message);
    assert.equal(decodeRfc2047(headerValue(header, "Subject")), "日报");
    assert.equal(body, "第一行\n第二行");
  });

  it("点填充：行首的 . 写成 ..（正文是 base64 所以线上不会触发，仍要保证正确）", () => {
    assert.equal(dotStuff(".\r\n..x\r\nhello"), "..\r\n...x\r\nhello");
    assert.equal(dotStuff("no-dots\r\n"), "no-dots\r\n");
  });
});

describe("SMTP 会话（明文 + AUTH LOGIN）", () => {
  it("完整会话：EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT", async () => {
    await withFakeSmtp({}, async (base, convo) => {
      const result = await sendSmtpMail(plainRoute(base), {
        subject: "交房租提醒",
        body: "**今天**记得转账\n第二行",
      });
      assert.deepEqual(result, { ok: true });

      assert.equal(
        convo.lines[0]?.startsWith("EHLO "),
        true,
        `首条命令应是 EHLO，实际 ${convo.lines[0]}`,
      );
      assert.equal(convo.lines[1], "AUTH LOGIN");
      assert.equal(
        Buffer.from(convo.authTokens[0] ?? "", "base64").toString("utf8"),
        "user",
        "第二段应是 base64 用户名",
      );
      assert.equal(
        Buffer.from(convo.authTokens[1] ?? "", "base64").toString("utf8"),
        "secret",
        "第三段应是 base64 密码",
      );
      assert.ok(convo.lines.includes("MAIL FROM:<me@example.com>"));
      assert.ok(convo.lines.includes("RCPT TO:<you@example.com>"));
      assert.ok(convo.lines.includes("DATA"));
      assert.ok(convo.lines.includes("QUIT"));

      const { header, body } = parseMessage(convo.data);
      assert.equal(decodeRfc2047(headerValue(header, "Subject")), "交房租提醒");
      assert.equal(decodeRfc2047(headerValue(header, "From")), "<me@example.com>");
      assert.equal(body, "**今天**记得转账\n第二行");
      assert.ok(headerValue(header, "Date").endsWith("+0000"));
      assert.match(headerValue(header, "Message-ID"), /^<[^@]+@life-assistant>$/);
    });
  });

  it("多个收件人逐个 RCPT TO", async () => {
    await withFakeSmtp({}, async (base, convo) => {
      const route = parseSmtpRouteUrl(
        `smtp://${base.host}:${base.port}?tls=plain&from=me@example.com&to=a@example.com&to=b@example.com`,
      );
      const result = await sendSmtpMail(route, { subject: "hi", body: "x" });
      assert.deepEqual(result, { ok: true });
      assert.ok(convo.lines.includes("RCPT TO:<a@example.com>"));
      assert.ok(convo.lines.includes("RCPT TO:<b@example.com>"));
    });
  });

  it("无凭据时不发 AUTH", async () => {
    await withFakeSmtp({}, async (base, convo) => {
      const route = parseSmtpRouteUrl(
        `smtp://${base.host}:${base.port}?tls=plain&from=me@example.com&to=you@example.com`,
      );
      const result = await sendSmtpMail(route, { subject: "hi", body: "x" });
      assert.deepEqual(result, { ok: true });
      assert.equal(
        convo.lines.some((line) => line.startsWith("AUTH")),
        false,
        "没给凭据就不该发 AUTH",
      );
    });
  });

  it("服务器不提供 AUTH LOGIN/PLAIN → terminal_failure（重试也不会好）", async () => {
    await withFakeSmtp({ ehlo: "250-fake.test\r\n250 8BITMIME" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "terminal_failure");
      assert.match(result.error, /AUTH/);
    });
  });
});

describe("SMTP 失败映射", () => {
  it("RCPT 550 → terminal_failure（服务器明确拒绝收件人）", async () => {
    await withFakeSmtp({ rcpt: "550 5.1.1 no such user" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "terminal_failure");
      assert.match(result.error, /550/);
      assert.match(result.error, /no such user/);
    });
  });

  it("MAIL FROM 451 → confirmed_failure（4xx 稍后再试）", async () => {
    await withFakeSmtp({ mail: "451 4.3.0 try again later" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "confirmed_failure");
      assert.match(result.error, /451/);
    });
  });

  it("连接问候 554 → terminal_failure", async () => {
    await withFakeSmtp({ greeting: "554 5.7.1 rejected" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "terminal_failure");
    });
  });

  it("AUTH 535（密码错）→ terminal_failure，不反复重试同一份错误凭据", async () => {
    await withFakeSmtp({ authPass: "535 5.7.8 authentication failed" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "terminal_failure");
      assert.match(result.error, /535/);
    });
  });

  it("正文提交被拒（552）→ terminal_failure", async () => {
    await withFakeSmtp({ dataEnd: "552 5.3.4 message too big" }, async (base) => {
      const result = await sendSmtpMail(plainRoute(base), { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "terminal_failure");
    });
  });

  it("连接被拒 → transport_failure（可重试）", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        assert.ok(addr !== null && typeof addr === "object");
        const free = addr.port;
        server.close(() => resolve(free));
      });
    });
    const route = parseSmtpRouteUrl(
      `smtp://127.0.0.1:${port}?tls=plain&from=a@example.com&to=b@example.com`,
    );
    const result = await sendSmtpMail(route, { subject: "hi", body: "x" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, "transport_failure");
    assert.match(result.error, /^SMTP /);
  });

  it("总超时：服务器接了连接却不响应 → transport_failure（中文说明）", async () => {
    await withFakeSmtp({ hang: true }, async (base) => {
      const started = Date.now();
      const result = await sendSmtpMail(
        plainRoute(base),
        { subject: "hi", body: "x" },
        {
          timeoutMs: 300,
        },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "transport_failure");
      assert.match(result.error, /超时/);
      assert.ok(Date.now() - started < 5_000, "超时应当由 300ms 的会话超时兜住");
    });
  });

  it("STARTTLS：命令确实发出，握手失败按 transport_failure 处理", async () => {
    await withFakeSmtp({ breakAfterStartTls: true }, async (base, convo) => {
      const route = parseSmtpRouteUrl(
        `smtp://${base.host}:${base.port}?tls=starttls&from=me@example.com&to=you@example.com`,
      );
      const result = await sendSmtpMail(route, { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "transport_failure");
      assert.match(result.error, /STARTTLS|握手/);
      assert.ok(convo.lines.includes("STARTTLS"), "必须先发 STARTTLS 再升级 TLS");
    });
  });

  it("隐式 TLS（?tls=implicit）：对端不是 TLS → transport_failure", async () => {
    await withFakeSmtp({}, async (base) => {
      const route = parseSmtpRouteUrl(
        `smtp://${base.host}:${base.port}?tls=implicit&from=me@example.com&to=you@example.com`,
      );
      const result = await sendSmtpMail(route, { subject: "hi", body: "x" });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "transport_failure");
    });
  });
});

describe("SMTP 通道与通道表", () => {
  it("注册进通道表：需要 URL、不需要 secret，validateRoute 返回规范化 URL", () => {
    const channel = getChannel("smtp");
    assert.equal(channel.name, "smtp");
    assert.equal(channel.requiresUrl, true);
    assert.equal(channel.requiresSecret, false);
    assert.equal(
      smtpChannel.validateRoute({
        url: "smtp://u:p@mail.example.com:587?from=a@example.com&to=b@example.com",
      }),
      "smtp://u:p@mail.example.com:587?from=a@example.com&to=b@example.com",
    );
    assert.throws(() => smtpChannel.validateRoute({ url: "smtp://mail.example.com" }), /from/);
  });

  it("deliver 成功 → sent；服务器拒绝 → 对应的失败状态", async () => {
    await withFakeSmtp({}, async (base, convo) => {
      const route = plainRoute(base);
      const ok = await smtpChannel.deliver({
        profileId: "default",
        notificationId: "n1",
        kind: "test.kind",
        title: "通道层标题",
        bodyMd: "正文",
        createdAt: "2026-10-20T00:00:00.000Z",
        requestId: "req",
        generation: 0,
        route: { name: "life-assistant-default", url: route.url },
      });
      assert.equal(ok.status, "sent");
      const { body } = parseMessage(convo.data);
      assert.equal(body, "正文");
    });
    await withFakeSmtp({ rcpt: "550 5.1.1 nope" }, async (base) => {
      const route = plainRoute(base);
      const outcome: ChannelOutcome = await smtpChannel.deliver({
        profileId: "default",
        notificationId: "n1",
        kind: "test.kind",
        title: "t",
        bodyMd: "b",
        createdAt: "2026-10-20T00:00:00.000Z",
        requestId: "req",
        generation: 0,
        route: { name: "life-assistant-default", url: route.url },
      });
      assert.equal(outcome.status, "terminal_failure");
    });
  });

  it("库里路由被改坏 → terminal_failure，不抛异常打断投递批次", async () => {
    const outcome = await smtpChannel.deliver({
      profileId: "default",
      notificationId: "n1",
      kind: "test.kind",
      title: "t",
      bodyMd: "b",
      createdAt: "2026-10-20T00:00:00.000Z",
      requestId: "req",
      generation: 0,
      route: { name: "r", url: "smtp://mail.example.com" },
    });
    assert.equal(outcome.status, "terminal_failure");
    assert.match(outcome.error, /smtp 路由不合法/);
  });

  it("走 outbox 端到端：channel=smtp 无 secret 也能入队并投递", async () => {
    const env = makeTestEnv();
    try {
      await withFakeSmtp({}, async (base) => {
        const route = setPushRoute(env.db, "default", {
          channel: "smtp",
          url: `smtp://${base.host}:${base.port}?tls=plain&from=me@example.com&to=you@example.com`,
        });
        assert.equal(route.channel, "smtp");
        const pub = publishProfile(env.db, env.config, "default", {
          kind: "test.kind",
          title: "端到端 SMTP",
          blocks: {},
        });
        await drainDue(env.db, env.config);
        const row = env.db
          .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
          .get(pub.id) as { status: string; last_error: string | null } | undefined;
        assert.ok(row !== undefined);
        assert.equal(row.status, "sent", `投递失败: ${row.last_error ?? ""}`);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});
