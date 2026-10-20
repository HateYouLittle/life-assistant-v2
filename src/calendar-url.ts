import { loadConfig, PROFILE_ID_RE } from "./config.js";
import { signCalendarUrl } from "./core/ics.js";

/**
 * `npm run calendar:url -- --profile bestie [--days 30] [--base https://life.example.com]`
 *
 * 生成日历订阅用的签名 URL（只读、不打开数据库、不产生副作用）。
 * 为什么不放在 daemon 里自动生成：订阅链接是「设备凭据」，应该由人显式签发、
 * 显式设置有效期，而不是让服务端随手在日志/页面里暴露。
 */
function valueOf(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function main(): void {
  const args = process.argv.slice(2);
  const profile = valueOf(args, "--profile") ?? "default";
  if (!PROFILE_ID_RE.test(profile)) {
    console.error(`Profile 名不合法: ${profile}（小写字母数字、- 与 _，最长 32）`);
    process.exitCode = 1;
    return;
  }
  const daysRaw = valueOf(args, "--days") ?? "30";
  const days = Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error(`--days 必须是 1..365 的整数: ${daysRaw}`);
    process.exitCode = 1;
    return;
  }
  const base = (valueOf(args, "--base") ?? "").replace(/\/+$/, "");

  try {
    const config = loadConfig(process.env);
    const path = signCalendarUrl(config, profile, Date.now() + days * 86_400_000);
    console.log(base === "" ? path : `${base}${path}`);
    if (base === "") {
      console.log(
        "（未传 --base：上面是相对路径；加 --base https://<你的域名> 得到可直接粘贴的订阅地址）",
      );
    }
    console.log(`有效期：${days} 天；Profile：${profile}`);
  } catch (e) {
    console.error(`生成订阅链接失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = /calendar-url\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) main();
