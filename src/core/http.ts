/** 错误响应体最多读这么多字节，避免上游返回巨大 HTML 时占用内存 */
const MAX_ERROR_BODY = 2000;

/**
 * 取 JSON。非 2xx 时不直接丢弃响应体：QWeather 的错误契约是真实 HTTP 状态 +
 * `application/problem+json` 的 `{error:{title,detail}}`，只抛 `HTTP 404` 会让
 * UNAUTHORIZED / NO CREDIT / OVERDUE / TOO MANY REQUESTS 等全部不可区分。
 * 注意：错误信息里绝不放 URL —— URL 携带 API key。
 */
export async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "life-assistant-v2", Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  return response.json();
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
    const parsed = JSON.parse(text) as { error?: { title?: unknown; detail?: unknown; status?: unknown } };
    const title = parsed.error?.title;
    const detail = parsed.error?.detail;
    const parts = [title, detail].filter((v) => typeof v === "string" && v !== "");
    if (parts.length > 0) return parts.join(" - ");
  } catch {
    // 非 JSON：退化为截断后的纯文本
  }
  return text.replace(/\s+/g, " ").trim();
}
