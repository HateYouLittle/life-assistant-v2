/** 错误响应体最多读这么多字节，避免上游返回巨大 HTML 时占用内存 */
const MAX_ERROR_BODY = 2000;

/**
 * 非 2xx 的错误。带 `status` 是为了让调用方（如 QWeather 客户端）能区分
 * 可重试的 429/5xx 与绝不可重试的 4xx —— 只靠字符串解析状态码太脆弱。
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail === "" ? `HTTP ${status}` : `HTTP ${status}: ${detail}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * 取 JSON。非 2xx 时不直接丢弃响应体：QWeather 的错误契约是真实 HTTP 状态 +
 * `application/problem+json` 的 `{error:{title,detail}}`，只抛 `HTTP 404` 会让
 * UNAUTHORIZED / NO CREDIT / OVERDUE / TOO MANY REQUESTS 等全部不可区分。
 * 注意：错误信息里绝不放 URL —— URL 携带 API key。
 */
export async function fetchJson(
  url: string,
  timeoutMs = 10_000,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "life-assistant-v2", Accept: "application/json", ...headers },
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new HttpError(response.status, detail);
  }
  return response.json();
}

/**
 * fetch 层的失败统一是 `TypeError("fetch failed")`，真实原因在 `cause` 里；
 * 超时被中止时是 `DOMException(AbortError/TimeoutError)`。
 *
 * 用于区分「瞬时网络故障」（值得退避重试）与「确定性失败」（重试只是白耗配额）：
 * `redirect: "error"` 把 3xx 也变成 TypeError，但重定向重试多少次都是同一个结果 ——
 * QWeather 的账号冻结红线正来自「反复重试错误的请求」。返回 true 表示值得重试。
 */
export function isTransientNetworkError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === "AbortError" || e.name === "TimeoutError";
  if (!(e instanceof TypeError)) return false;
  const cause = (e as { cause?: unknown }).cause;
  const message = cause instanceof Error ? cause.message : "";
  // 重定向、非法 URL 等确定性失败不重试
  return !/redirect|invalid url/i.test(message);
}

async function readErrorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    if (response.body === null) return "";
    text = (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
  if (text.trim() === "") return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: { title?: unknown; detail?: unknown; status?: unknown };
    };
    const title = parsed.error?.title;
    const detail = parsed.error?.detail;
    const parts = [title, detail].filter((v) => typeof v === "string" && v !== "");
    if (parts.length > 0) return parts.join(" - ");
  } catch {
    // 非 JSON：退化为截断后的纯文本
  }
  return text.replace(/\s+/g, " ").trim();
}
