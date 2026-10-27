/**
 * 极简进程内计数器：给 `/metrics`（Prometheus 文本）与日志提供最小可观测性。
 * 不做直方图/标签维度 —— 个人规模下「鉴权失败数、限流数、投递状态、任务新鲜度」
 * 已经能回答「服务是否健康」。指标在进程重启后归零（持久状态看数据库）。
 */

const counters = new Map<string, number>();

/**
 * 瞬时值（gauge）：与计数器不同，它会被覆盖而不是累加。目前只用于「超时僵尸任务数」
 * 这类从别处状态派生、但 `/metrics` 抓取时需要直接读的值。
 */
const gauges = new Map<string, number>();

export function incCounter(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function counterValue(name: string): number {
  return counters.get(name) ?? 0;
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function gaugeValue(name: string): number {
  return gauges.get(name) ?? 0;
}

export function resetCountersForTests(): void {
  counters.clear();
  gauges.clear();
}
