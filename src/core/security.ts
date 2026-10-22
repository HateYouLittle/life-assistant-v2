import { chmodSync, readdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { logger } from "./logger.js";

/**
 * 部署安全基线：文件权限 + HTTP Host/Origin 守卫。
 *
 * 为什么需要：
 * - 数据目录里是个人日程/账目/通知，默认 umask 022 会让 DB/WAL/备份变成 0644、目录 0755，
 *   同机其他用户可读。`applySecureUmask` 在进程启动最早处把默认权限收紧，之后新建的
 *   文件（含 SQLite 自己建的 -wal/-shm）都会是 0600。
 * - daemon 只绑回环并不等于安全：恶意网页可以把域名解析到 127.0.0.1（DNS rebinding），
 *   浏览器会把发往 `http://evil.com:3080/api/status` 的请求当作同源，没有 Host 校验时
 *   真实数据直接返回。`createRequestGuard` 只放行已知 Host，并拒绝来自其他站点的 Origin。
 */

/** 默认端口：浏览器/客户端在 URL 里会省略它们，比较 Host 时需要容忍 */
const DEFAULT_PORTS = new Set([80, 443]);

interface HostKey {
  /** 小写主机名；IPv6 字面量保留方括号（`[::1]`） */
  host: string;
  port?: number;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 解析 `host[:port]`。Host 头里 IPv6 必须带方括号（RFC 7230），因此 `[::1]:3080`
 * 走方括号分支；裸 `::1` 只可能出现在 WEB_ALLOWED_HOSTS（用户手写的配置），
 * 也按 IPv6 处理，避免被当成「主机:端口」。
 */
function parseHostPort(value: string): HostKey | undefined {
  if (value === "") return undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (match === null) return undefined;
    const inner = match[1] ?? "";
    const rawPort = match[2];
    if (rawPort === undefined) return { host: `[${inner}]` };
    const port = Number(rawPort);
    return isValidPort(port) ? { host: `[${inner}]`, port } : undefined;
  }
  // 多个冒号 = 裸 IPv6 字面量（配置里允许写 `::1`）
  if ((value.match(/:/g)?.length ?? 0) > 1) return { host: `[${value}]` };
  const colon = value.lastIndexOf(":");
  if (colon >= 0) {
    const portText = value.slice(colon + 1);
    if (/^\d+$/.test(portText)) {
      const host = value.slice(0, colon);
      const port = Number(portText);
      if (host === "" || !isValidPort(port)) return undefined;
      return { host, port };
    }
  }
  return { host: value };
}

/**
 * 配置里的主机可能写成 URL 形态（`http://127.0.0.1`）或带尾斜杠；剥掉 scheme/path
 * 再解析，与其他配置项对 HOST 的归一化口径一致。
 */
function normalizeConfiguredHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const slash = value.indexOf("/");
  if (slash >= 0) value = value.slice(0, slash);
  return value;
}

/** 规范化比较键：默认端口（80/443）视为「没写端口」，与省略端口的 Host 头等价 */
function canonicalHostKey(key: HostKey): string {
  const port = key.port === undefined || DEFAULT_PORTS.has(key.port) ? "" : `:${key.port}`;
  return `${key.host}${port}`;
}

/** 通配绑定地址（0.0.0.0 / ::）不是真实的 Host 值，不能靠它放行 */
function isWildcardBindHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  return h === "0.0.0.0" || h === "::" || h === "::0" || /^0(:0){7}$/.test(h);
}

export interface HostAllowList {
  /** 裸主机放行（不限端口） */
  hostOnly: Set<string>;
  /** 主机 + 端口精确放行（端口已按默认端口归一） */
  hostWithPort: Set<string>;
}

export interface HostAllowListOptions {
  /**
   * 回环主机名是否不限端口。默认 true（Host 头用）：Host 里的端口不参与路由
   * （请求已经到达本服务），DNS rebinding 的边界是主机名；测试以端口 0 监听
   * （config.port 与实际端口不同）也必须能访问。
   * Origin 校验传 false：跨站防护需要端口精确，「同机另一个端口的网页」不应被当成同源。
   */
  loopbackAnyPort?: boolean;
}

/**
 * 构造允许的 Host 集合：
 * - 固定放行回环三形态（localhost / 127.0.0.1 / [::1]）：Host 头按主机名放行（不限端口），
 *   Origin 按 `<loopback>:<port>` 精确放行（见 HostAllowListOptions）；
 * - 配置的 `HOST` 本身（字面量时）按 `<host>:<port>` 精确放行；
 * - `WEB_ALLOWED_HOSTS` 的条目：带端口按精确端口放行，裸主机则不限制端口。
 *
 * 绑定非回环地址（如 0.0.0.0）时，客户端实际用的局域网 IP / 域名必须写进
 * WEB_ALLOWED_HOSTS —— 这是有意的：没有显式放行名单就无法区分「用户自己的域名」
 * 和「攻击者解析到本机的域名」。
 */
export function buildHostAllowList(
  config: ResolvedConfig,
  opts: HostAllowListOptions = {},
): HostAllowList {
  const hostOnly = new Set<string>();
  const hostWithPort = new Set<string>();
  const loopbackAnyPort = opts.loopbackAnyPort ?? true;

  for (const loopback of ["localhost", "127.0.0.1", "[::1]"]) {
    if (loopbackAnyPort) hostOnly.add(loopback);
    else hostWithPort.add(canonicalHostKey({ host: loopback, port: config.port }));
  }

  const configuredHost = normalizeConfiguredHost(config.host);
  const configuredKey = parseHostPort(configuredHost);
  if (configuredKey !== undefined && !isWildcardBindHost(configuredHost)) {
    hostWithPort.add(canonicalHostKey({ host: configuredKey.host, port: config.port }));
  }

  for (const entry of config.allowedHosts) {
    const key = parseHostPort(normalizeConfiguredHost(entry));
    if (key === undefined) {
      // 配置项写坏时告警而不是静默忽略：否则「配了却仍 403」会被当成守卫 bug。
      logger.warn(`WEB_ALLOWED_HOSTS 条目无法解析，已忽略: ${entry}`);
      continue;
    }
    if (key.port === undefined) hostOnly.add(key.host);
    else hostWithPort.add(canonicalHostKey(key));
  }
  return { hostOnly, hostWithPort };
}

function hostAllowed(list: HostAllowList, rawValue: string): boolean {
  const key = parseHostPort(rawValue.trim().toLowerCase());
  if (key === undefined) return false;
  return list.hostOnly.has(key.host) || list.hostWithPort.has(canonicalHostKey(key));
}

export type RequestGuardResult = { ok: true } | { ok: false; status: 403; body: string };

/**
 * 生成 HTTP 入口守卫（Lead 在 daemon 统一调用，所有路径都过一遍）。
 * 返回 `{ok:true}` 放行；否则给 403 + 中文 body。
 *
 * Origin 只在**存在时**校验：CLI / agent / curl 通常不带 Origin，浏览器跨站请求一定带。
 * 没有 Origin 一律放行（否则 MCP stdio 壳、systemd 探针都会被误杀）。
 */
export function createRequestGuard(
  config: ResolvedConfig,
): (req: IncomingMessage) => RequestGuardResult {
  // Host 头：回环不限端口（见 buildHostAllowList 注释）；Origin：回环也要求端口精确，
  // 否则「同机另一个端口上的恶意页面」会被当成同源而绕开跨站防护。
  const hostAllowList = buildHostAllowList(config);
  const originAllowList = buildHostAllowList(config, { loopbackAnyPort: false });

  return (req: IncomingMessage): RequestGuardResult => {
    const rawHost = req.headers.host;
    if (typeof rawHost !== "string" || rawHost.trim() === "") {
      return {
        ok: false,
        status: 403,
        body: "Host 不被允许：请求缺少 Host 头（可能是 DNS rebinding 或非标准客户端）",
      };
    }
    if (!hostAllowed(hostAllowList, rawHost)) {
      return {
        ok: false,
        status: 403,
        body:
          `Host 不被允许：${rawHost}（DNS rebinding 防护）。` +
          "如确需通过该域名/IP 访问，请把它加进 WEB_ALLOWED_HOSTS",
      };
    }

    const rawOrigin = req.headers.origin;
    if (rawOrigin === undefined) return { ok: true };
    if (typeof rawOrigin !== "string" || rawOrigin === "") {
      return { ok: false, status: 403, body: `Origin 不被允许：${String(rawOrigin)}` };
    }
    let origin: URL;
    try {
      origin = new URL(rawOrigin);
    } catch {
      return { ok: false, status: 403, body: `Origin 不被允许：${rawOrigin}` };
    }
    // 只接受 http/https 来源：`file://`、`null`、chrome-extension:// 等一律拒绝
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return { ok: false, status: 403, body: `Origin 不被允许：${rawOrigin}` };
    }
    if (!hostAllowed(originAllowList, origin.host)) {
      return {
        ok: false,
        status: 403,
        body: `Origin 不被允许：${rawOrigin}（跨站请求被拒绝）。如确需该来源，请把其主机加进 WEB_ALLOWED_HOSTS`,
      };
    }
    return { ok: true };
  };
}

/**
 * 收紧进程默认 umask：之后创建的 DB/WAL/SHM/备份/锁文件都默认 0600，目录 0700。
 * win32 上 Node 仍接受该调用（只是不产生 POSIX 权限语义），因此无需平台分支。
 */
export function applySecureUmask(): void {
  process.umask(0o077);
}

function chmodBestEffort(path: string, mode: number, label: string): void {
  try {
    chmodSync(path, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn(`${label}权限收紧失败: ${path}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/**
 * 把已有数据目录/库/备份的权限收紧到 0700/0600。
 * best-effort：ENOENT 与权限不足只警告不抛 —— 加固失败不该让 daemon 起不来，
 * 但必须在日志里留下线索（用户可能正拿着 0644 的库跑）。
 */
export function hardenDataDir(dataDir: string, dbPath: string, backupDir: string): void {
  chmodBestEffort(dataDir, 0o700, "数据目录");
  chmodBestEffort(dbPath, 0o600, "数据库");
  // WAL/SHM 里同样有真实数据（未合并的写入），必须与主库同权限
  chmodBestEffort(`${dbPath}-wal`, 0o600, "数据库 WAL");
  chmodBestEffort(`${dbPath}-shm`, 0o600, "数据库 SHM");
  chmodBestEffort(backupDir, 0o700, "备份目录");

  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`读取备份目录失败: ${backupDir} ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".db")) continue;
    chmodBestEffort(join(backupDir, name), 0o600, "备份文件");
  }
}

/**
 * CLI 入口的安全基线：与 daemon 启动同口径。
 *
 * 为什么 CLI 也要做：`umask(0o077)` 之前只在 `startDaemon` 里设置，`db:backup` /
 * `db:restore` / `import:v1` / `db:cleanup:preview` / `db:fingerprint` 由用户手工执行
 * （尤其 `import:v1` 常在任何 daemon 启动之前首次建库），按默认 umask 022 会把库、
 * 备份、迁移前快照落成 0644、目录 0755 —— 同机其它用户可读个人账目/日程/通知。
 *
 * 必须在任何 mkdir/open 之前调用（umask 只影响之后创建的 inode）；`hardenDataDir`
 * 是 best-effort，不会抛错。daemon 路径仍由 `startDaemon` 自己调用同一组函数
 * （它还要在取锁之后、开库之前做，顺序敏感）。
 *
 * 时机很重要（Round2 R2-2）：`harden` 会 chmod 已存在的目录/库/备份 —— 在校验完成前
 * 或「不写盘」的路径上调用会产生用户可见的意外副作用。调用方应在确认「这次确实会写
 * 数据目录」之后再让它 harden：
 * - dry-run / 只读预览：只 `applySecureUmask()`（进程内 umask，不碰任何现有文件）；
 * - 库还不存在（首次创建，或 DATA_DIR 写错）：传 `{ harden: false }`，避免 chmod 用户
 *   写错指向的无关目录；创建出来的新文件仍受 umask 保护。
 */
export interface CliSecurityBaselineOptions {
  /**
   * 是否把已有数据目录/库/WAL/SHM/备份收紧到 0700/0600。默认 true；
   * 库不存在或本次不写盘时传 false（umask 仍会生效）。
   */
  harden?: boolean;
}

export function applyCliSecurityBaseline(
  config: {
    dataDir: string;
    dbPath: string;
    backupDir: string;
  },
  opts: CliSecurityBaselineOptions = {},
): void {
  applySecureUmask();
  if (opts.harden === false) return;
  hardenDataDir(config.dataDir, config.dbPath, config.backupDir);
}
