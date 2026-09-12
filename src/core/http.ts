export async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "life-assistant-v2" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.body !== null) response.body.cancel().catch(() => {});
  return response.json();
}
