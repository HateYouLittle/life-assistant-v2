import { randomUUID } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";

/**
 * 最小 SMTP 客户端（只用 node:net / node:tls / node:crypto，不引第三方依赖）。
 *
 * 为什么手写：项目约定不引入新依赖，而这里需要的只是「把一条通知当纯文本邮件发出去」——
 * EHLO / STARTTLS / AUTH LOGIN·PLAIN / MAIL FROM / RCPT TO / DATA 就是全部。nodemailer
 * 这类库的体积与供应链面远大于这点功能。代价：只实现 RFC 5321 的必要子集，
 * 不支持附件、HTML、多条消息、DSN、8BITMIME 正文（正文一律 base64，天然 7bit 安全）。
 *
 * 三种加密形态按端口约定（可用 `?tls=` 显式覆盖）：
 * - 25 明文（局域网中继）；
 * - 587 提交口：EHLO → STARTTLS → EHLO（TLS 后重新 EHLO，否则拿不到 AUTH 能力）；
 * - 465 隐式 TLS（smtps，连上即 TLS）。
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 500;
/** 收件人上限：一条通知不是群发，超过这个数量几乎一定是路由配错 */
const MAX_RECIPIENTS = 10;

/**
 * 邮箱地址白名单：只接受 ASCII 的「本地部分@域名.顶级域」。
 * 这里不是完整 RFC 5322 解析器 —— 关键目的是**挡住 CR/LF/尖括号**（SMTP 命令注入），
 * 以及挡住中文/空格这类一定会在 MAIL FROM 命令里出问题的地址。
 */
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** SMTP 命令行不允许含 CR/LF（防命令注入），额外挡住空白 */
const CRLF_RE = /[\r\n]/;

export type SmtpTlsMode = "plain" | "starttls" | "implicit";

/** 解析后的 SMTP 路由（也是投递时需要的全部参数） */
export interface SmtpRoute {
  /** 规范化后的原始 URL（落库值，投递时重新解析） */
  url: string;
  host: string;
  port: number;
  tls: SmtpTlsMode;
  username?: string;
  password?: string;
  from: string;
  to: string[];
}

/** 与 core/channels.ts 的 ChannelOutcome 同名的失败三态，便于直接映射（这里不 import 它，避免耦合） */
export type SmtpFailureStatus = "confirmed_failure" | "terminal_failure" | "transport_failure";

export type SmtpResult = { ok: true } | { ok: false; status: SmtpFailureStatus; error: string };

/** 服务器明确回了状态码（4xx/5xx） */
class SmtpReplyError extends Error {
  constructor(
    readonly code: number,
    readonly stage: string,
    readonly reply: SmtpReply,
  ) {
    super(`${stage} 失败（${code}）：${replyText(reply)}`);
    this.name = "SmtpReplyError";
  }
}

/** 连接/TLS/超时/半路断开：没有服务器状态码，结果不确定 */
class SmtpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpTransportError";
  }
}

/** 路由与服务器能力对不上（如要求认证但服务器不提供 AUTH）：重试也不会好 */
class SmtpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpConfigError";
  }
}

function truncateError(text: string): string {
  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function replyText(reply: SmtpReply): string {
  const last = reply.lines[reply.lines.length - 1] ?? "";
  return last.replace(/^\d{3}[- ]?/, "").trim();
}

/**
 * 解析并校验路由 URL：`smtp://user:pass@host:587?from=me@example.com&to=you@example.com`
 * （无 user/pass 时不做 AUTH；`to` 可以重复多次）。
 * 校验失败一律抛中文错误 —— 由 notify.ts 的 setPushRoute 在**写入时**拦住坏路由，
 * 而不是等到投递轮次才发现（那时只剩 fallback，用户看不出是配置错了）。
 */
export function parseSmtpRouteUrl(raw: string | undefined): SmtpRoute {
  const hint = "如 smtp://user:pass@host:587?from=me@example.com&to=you@example.com";
  if (raw === undefined || raw.trim() === "") throw new Error(`smtp 通道需要 url（${hint}）`);
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`smtp URL 不合法: ${raw}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "smtp" && scheme !== "smtps") {
    throw new Error(`smtp URL 必须以 smtp:// 或 smtps:// 开头: ${raw}`);
  }
  // IPv6 的 hostname 带方括号（URL 规范如此），但 connect/tls 只认裸地址
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "") throw new Error(`smtp URL 缺少 host: ${raw}`);
  const port = parsed.port === "" ? (scheme === "smtps" ? 465 : 25) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`smtp 端口不合法: ${parsed.port}`);
  }
  const tls = resolveSmtpTls(port, scheme, parsed.searchParams.get("tls") ?? undefined);

  // URL 的 username/password 保留百分号编码，要自己解码；user 与 pass 必须成对出现
  // （只给 user: 的写法通常意味着用户漏了密码，静默不认证会让人以为发出去了）
  const username = decodeUserInfo(parsed.username, "用户名");
  const password = decodeUserInfo(parsed.password, "密码");
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("smtp URL 的 user 与 pass 必须同时提供（形如 smtp://user:pass@host:587）");
  }

  const from = (parsed.searchParams.get("from") ?? "").trim();
  if (!EMAIL_RE.test(from)) {
    throw new Error(`smtp 路由缺少合法的 from 邮箱（?from=me@example.com），收到: ${from}`);
  }
  const to = parsed.searchParams
    .getAll("to")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (to.length === 0) throw new Error("smtp 路由缺少收件人（?to=you@example.com，可重复多次）");
  if (to.length > MAX_RECIPIENTS) {
    throw new Error(`smtp 收件人过多（${to.length} 个，上限 ${MAX_RECIPIENTS}）`);
  }
  for (const address of to) {
    if (!EMAIL_RE.test(address)) throw new Error(`smtp 收件人邮箱不合法: ${address}`);
  }

  return { url: parsed.toString(), host, port, tls, username, password, from, to };
}

function decodeUserInfo(value: string, label: string): string | undefined {
  if (value === "") return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`smtp URL 里的${label}百分号编码不合法`);
  }
}

/**
 * 端口 → 加密方式。显式 `?tls=` 优先：自建服务器常用非标准端口（2525 STARTTLS 等），
 * 只按端口猜会把凭据发在明文连接上或对明文中继发起握手。
 */
export function resolveSmtpTls(
  port: number,
  scheme: "smtp" | "smtps",
  override?: string,
): SmtpTlsMode {
  if (override !== undefined && override.trim() !== "") {
    const value = override.trim().toLowerCase();
    if (value !== "plain" && value !== "starttls" && value !== "implicit") {
      throw new Error(`smtp 的 tls 参数只能是 plain / starttls / implicit，收到: ${override}`);
    }
    return value;
  }
  if (scheme === "smtps" || port === 465) return "implicit";
  if (port === 587) return "starttls";
  return "plain";
}

interface SmtpReply {
  code: number;
  /** 完整行（含 `250-` / `250 ` 前缀），错误信息里用最后一行 */
  lines: string[];
}

/** EHLO 应答里声明的 AUTH 机制（`250-AUTH LOGIN PLAIN` 或老式 `250-AUTH=LOGIN`） */
function authMechanisms(reply: SmtpReply): string[] {
  const mechanisms: string[] = [];
  for (const line of reply.lines) {
    const match = /^250[-= ]AUTH[ =](.+)$/i.exec(line);
    if (match === null) continue;
    for (const item of (match[1] ?? "").toUpperCase().split(/\s+/)) {
      if (item !== "") mechanisms.push(item);
    }
  }
  return mechanisms;
}

/** EHLO 参数要像域名：主机名含奇怪字符时退回 localhost，否则服务器可能 501 拒收 */
export function smtpHeloName(): string {
  try {
    const name = hostname();
    // 有些机器（含本项目的开发机）hostname 直接是 IP：按 RFC 5321 地址字面量加方括号，
    // 裸 IP 在部分严格服务器上会被判成非法域名
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return `[${name}]`;
    if (/^[A-Za-z0-9.-]{1,255}$/.test(name)) return name;
  } catch {
    // 取主机名失败不影响投递，退回 localhost
  }
  return "localhost";
}

/**
 * SNI 参数：TLS 的 servername 不允许是 IP 地址（Node 会直接抛
 * "Setting the TLS ServerName to an IP address is not permitted"），
 * 而局域网自建 SMTP 常常就用 IP —— 这种主机不传 servername（不发送 SNI）。
 */
function sniOptions(host: string): { servername?: string } {
  return isIP(host) === 0 ? { servername: host } : {};
}

/** 一个挂着 TCP/TLS 连接的 SMTP 会话：按行写命令、按 `NNN ` 收应答 */
class SmtpConnection {
  private socket: Socket;
  private buffer = "";
  private waiting: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | null =
    null;
  private pendingConnect: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /** STARTTLS 握手等待者：连接层任何失败都要能叫醒它，否则会一直挂到总超时 */
  private handshakeFail: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private finished = false;
  private readonly timer: NodeJS.Timeout;

  private constructor(socket: Socket, deadline: number, timeoutMs: number) {
    this.socket = socket;
    // 总超时：整个会话（连接+认证+投递）共用一个 deadline，而不是每个命令各算一次
    // —— 否则「每步都刚好不超时」可以把一次投递拖到几分钟，卡住整轮 drain。
    this.timer = setTimeout(
      () => this.fail(new SmtpTransportError(`SMTP 会话超时（${Math.round(timeoutMs / 1000)}s）`)),
      Math.max(1, deadline - Date.now()),
    );
    this.timer.unref();
    this.attach(socket);
  }

  static async open(route: SmtpRoute, timeoutMs: number): Promise<SmtpConnection> {
    const deadline = Date.now() + timeoutMs;
    const socket =
      route.tls === "implicit"
        ? tlsConnect({ host: route.host, port: route.port, ...sniOptions(route.host) })
        : netConnect({ host: route.host, port: route.port });
    const connection = new SmtpConnection(socket, deadline, timeoutMs);
    // 隐式 TLS 要等 secureConnect（"connect" 只代表 TCP 通了，证书还没验）
    await connection.waitForConnect(route.tls === "implicit");
    return connection;
  }

  private waitForConnect(secure: boolean): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      const socket = this.socket;
      socket.once(secure ? "secureConnect" : "connect", () => {
        this.pendingConnect = null;
        resolve();
      });
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    // 新连接（含 STARTTLS 升级后）从干净的缓冲开始：升级前残留的字节不属于 TLS 流
    this.buffer = "";
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.drain();
    });
    socket.on("error", (error: Error) => {
      this.fail(new SmtpTransportError(`SMTP 连接错误：${error.message}`));
    });
    socket.on("close", () => {
      this.fail(new SmtpTransportError("SMTP 连接被对方关闭"));
    });
  }

  private drain(): void {
    while (this.waiting !== null) {
      const reply = this.takeReply();
      if (reply === null) return;
      const waiter = this.waiting;
      this.waiting = null;
      waiter.resolve(reply);
    }
  }

  /**
   * 取出一个完整应答：多行应答以「代码+空格」结尾（`250-…` 是续行），
   * 只有收到结束行才算完整，否则把半个应答留在缓冲里等后续数据。
   */
  private takeReply(): SmtpReply | null {
    let index = 0;
    while (true) {
      const eol = this.buffer.indexOf("\r\n", index);
      if (eol < 0) return null;
      const line = this.buffer.slice(index, eol);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        const lines = this.buffer.slice(0, eol).split("\r\n");
        this.buffer = this.buffer.slice(eol + 2);
        return { code, lines };
      }
      index = eol + 2;
    }
  }

  readReply(): Promise<SmtpReply> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const ready = this.takeReply();
    if (ready !== null) return Promise.resolve(ready);
    return new Promise<SmtpReply>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  async expect(codes: number[], stage: string): Promise<SmtpReply> {
    const reply = await this.readReply();
    if (!codes.includes(reply.code)) throw new SmtpReplyError(reply.code, stage, reply);
    return reply;
  }

  async command(line: string, codes: number[], stage: string): Promise<SmtpReply> {
    if (CRLF_RE.test(line))
      throw new SmtpConfigError(`SMTP 命令包含换行符，已拒绝发送（${stage}）`);
    this.write(`${line}\r\n`);
    return this.expect(codes, stage);
  }

  /** 发正文：点填充 + 结尾 `\r\n.\r\n`（RFC 5321 4.5.2） */
  writeData(message: string): void {
    const stuffed = dotStuff(message);
    const body = stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
    this.write(`${body}.\r\n`);
  }

  /** STARTTLS：在同一条 TCP 连接上升级成 TLS，并重新挂监听器 */
  async upgrade(host: string): Promise<void> {
    const raw = this.socket;
    // 摘掉旧监听器：升级后数据归 TLSSocket 管，旧监听器会把加密字节当明文塞进 buffer。
    // 但保留 error/close 转发器 —— 裸 socket 上没有 error 监听会让 Node 抛出未捕获异常，
    // 而「对端在握手中途掐断」往往只有 close 事件。
    raw.removeAllListeners("data");
    raw.removeAllListeners("close");
    raw.removeAllListeners("error");
    raw.on("error", (error: Error) => {
      this.fail(new SmtpTransportError(`SMTP STARTTLS 失败：${error.message}`));
    });
    raw.on("close", () => {
      this.fail(new SmtpTransportError("SMTP STARTTLS 握手失败：连接被关闭"));
    });
    const secure = tlsConnect({ socket: raw, ...sniOptions(host) });
    await new Promise<void>((resolve, reject) => {
      // fail() 也会 reject 这个握手 promise（见该字段），保证任何一条失败路径都能收口
      this.handshakeFail = (error: Error): void => reject(error);
      const onError = (error: Error): void => {
        reject(new SmtpTransportError(`SMTP STARTTLS 握手失败：${error.message}`));
      };
      const onClose = (): void => {
        reject(new SmtpTransportError("SMTP STARTTLS 握手失败：连接被关闭"));
      };
      secure.once("secureConnect", () => {
        this.handshakeFail = null;
        secure.off("error", onError);
        secure.off("close", onClose);
        resolve();
      });
      secure.once("error", onError);
      secure.once("close", onClose);
    });
    this.attach(secure);
  }

  private write(text: string): void {
    if (this.failure !== null) throw this.failure;
    this.socket.write(text);
  }

  /** 幂等失败收口：第一次失败时销毁连接并叫醒等待者，后续调用直接忽略 */
  private fail(error: Error): void {
    if (this.finished || this.failure !== null) return;
    this.failure = error;
    clearTimeout(this.timer);
    try {
      this.socket.destroy();
    } catch {
      // destroy 失败不影响错误本身
    }
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    pending?.reject(error);
    const handshake = this.handshakeFail;
    this.handshakeFail = null;
    handshake?.(error);
  }

  close(): void {
    this.finished = true;
    clearTimeout(this.timer);
    this.socket.removeAllListeners();
    try {
      this.socket.destroy();
    } catch {
      // 关闭阶段的异常没有意义（投递结果已经定了）
    }
  }
}

/**
 * RFC 2047 编码头：纯 ASCII 且不含控制字符时原样返回，否则 base64 编码。
 * 中文主题必须编码 —— 直接在 header 里放 UTF-8 字节在部分服务器/客户端会变成乱码，
 * 而 CR/LF 也会走到编码分支，顺带挡住 header 注入。
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Tue, 20 Oct 2026 14:47:57 +0000`：toUTCString 给的是 GMT，部分老客户端只认数字时区 */
function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += 76) {
    lines.push(value.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

/**
 * RFC 5321 4.5.2 的点填充：DATA 里以 `.` 开头的行要写成 `..`，否则单独的 `.` 会被当成
 * 正文结束。当前正文是 base64（字典里没有 `.`），所以线上实际上不会触发；
 * 仍然实现是为了将来换成 8bit/原样编码时不会静默把正文截断。
 */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, "$1..");
}

/**
 * 组装 RFC 5322 纯文本邮件。
 *
 * 统一 base64 传输编码的理由：正文是用户数据（中文、Markdown、超长行），
 * base64 天然只含 7bit 字符、不受行长 998 字节限制、也不会让点填充/换行处理出岔子。
 * 代价是不便人工阅读线上报文（排障时解码一下即可）。
 * 行结束一律 CRLF —— SMTP 明文协议里裸 LF 会被当成命令的一部分。
 */
export function buildSmtpMessage(mail: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  date?: Date;
  messageId?: string;
}): string {
  const messageId = mail.messageId ?? `<${randomUUID()}@life-assistant>`;
  const headers = [
    `From: <${mail.from}>`,
    `To: ${mail.to.map((address) => `<${address}>`).join(", ")}`,
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${rfc5322Date(mail.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = wrapBase64(Buffer.from(mail.body, "utf8").toString("base64"));
  const head = `${headers.join("\r\n")}\r\n\r\n`;
  return encodedBody === "" ? head : `${head}${encodedBody}\r\n`;
}

async function authenticate(
  connection: SmtpConnection,
  route: SmtpRoute,
  ehlo: SmtpReply,
): Promise<void> {
  const username = route.username ?? "";
  const password = route.password ?? "";
  const mechanisms = authMechanisms(ehlo);
  // 首选 LOGIN：实现最老、几乎所有服务器都支持；PLAIN 作为回退。
  // 服务器一个机制都没声明时不同客户端行为各异，这里明确报错而不是盲试
  // —— 盲试会把密码发到一个可能并不支持 AUTH 的服务器上。
  if (mechanisms.includes("LOGIN")) {
    await connection.command("AUTH LOGIN", [334], "AUTH LOGIN");
    await connection.command(
      Buffer.from(username, "utf8").toString("base64"),
      [334],
      "AUTH LOGIN 用户名",
    );
    await connection.command(
      Buffer.from(password, "utf8").toString("base64"),
      [235, 503],
      "AUTH LOGIN 密码",
    );
    return;
  }
  if (mechanisms.includes("PLAIN")) {
    const token = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
    await connection.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
    return;
  }
  throw new SmtpConfigError(
    `SMTP 服务器未提供 AUTH LOGIN/PLAIN（声明的机制: ${mechanisms.join(" ") || "无"}），无法认证`,
  );
}

function classifyFailure(error: unknown): { status: SmtpFailureStatus; error: string } {
  if (error instanceof SmtpReplyError) {
    // 服务器明确回了状态码：4xx 是「稍后再试」（退避重试有意义），5xx 是确定性拒绝。
    // 注意 4xx/5xx 的判定对 AUTH 阶段同样适用（535 密码错 → terminal，不反复重试）。
    const status: SmtpFailureStatus =
      error.code >= 500 && error.code <= 599
        ? "terminal_failure"
        : error.code >= 400 && error.code <= 499
          ? "confirmed_failure"
          : "transport_failure";
    return { status, error: truncateError(`SMTP ${error.message}`) };
  }
  if (error instanceof SmtpConfigError) {
    return { status: "terminal_failure", error: truncateError(`SMTP 配置错误：${error.message}`) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: "transport_failure", error: truncateError(`SMTP 投递失败：${message}`) };
}

/**
 * 投递一封纯文本邮件。返回四态映射后的结果，**不抛异常**：
 * 通道层（core/channels.ts）被 outbox 逐行调用，抛错会打断整批投递。
 */
export async function sendSmtpMail(
  route: SmtpRoute,
  mail: { subject: string; body: string },
  options: { timeoutMs?: number } = {},
): Promise<SmtpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let connection: SmtpConnection | undefined;
  try {
    connection = await SmtpConnection.open(route, timeoutMs);
    await connection.expect([220], "连接问候");
    let ehlo = await connection.command(`EHLO ${smtpHeloName()}`, [250], "EHLO");
    if (route.tls === "starttls") {
      await connection.command("STARTTLS", [220], "STARTTLS");
      await connection.upgrade(route.host);
      // TLS 之后必须重新 EHLO：AUTH 能力通常只在加密连接上才宣告
      ehlo = await connection.command(`EHLO ${smtpHeloName()}`, [250], "EHLO（TLS 后）");
    }
    if (route.username !== undefined && route.password !== undefined) {
      await authenticate(connection, route, ehlo);
    }
    await connection.command(`MAIL FROM:<${route.from}>`, [250], "MAIL FROM");
    for (const recipient of route.to) {
      // 251 = 用户不在本地但会转发，同样算接受
      await connection.command(`RCPT TO:<${recipient}>`, [250, 251], "RCPT TO");
    }
    await connection.command("DATA", [354], "DATA");
    connection.writeData(buildSmtpMessage({ ...mail, from: route.from, to: route.to }));
    await connection.expect([250], "邮件正文");
    // QUIT 只是礼貌收尾：250 已经代表服务器收下了，QUIT 失败不能把 sent 改成失败
    await connection.command("QUIT", [221], "QUIT").catch(() => undefined);
    return { ok: true };
  } catch (error) {
    return { ok: false, ...classifyFailure(error) };
  } finally {
    connection?.close();
  }
}
