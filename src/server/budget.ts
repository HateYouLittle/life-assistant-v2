import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { budgetStatus, getBudgets } from "../modules/bookkeeping/service.js";
import { TZ } from "../time.js";
import { normalizeMonth } from "./details.js";

/**
 * 预算看板：把「只有 MCP 工具能看」的预算对照搬到状态页，并给出可执行建议。
 *
 * 数据全部来自 bookkeeping 模块已有的 `budgetStatus`（总额/分类对照）与 `getBudgets`
 * （有没有预算），本文件只做**展示口径**的加工：
 * - 补上 remaining_cents / pace / suggestion（budgetStatus 只有 budget/spent/ratio）；
 * - 只统计家庭账本（个人账本仅归属人可见，不能出现在共享 token 的看板上）；
 * - 月份口径与看板其余部分一致：自然月全月、Asia/Shanghai。
 *
 * 「时间进度」的取法（pace 的分母）：
 * - 当月：今天的日号 / 本月天数；
 * - 已过去的月份：整月（day = 天数），因此 pace = ratio（全部支出都算已发生）；
 * - 未来的月份：day = 0，pace 记 0 —— 不能除以 0，也不能把「还没到的月份」说成超速。
 *   （提前录入的支出仍会计入 spent，但 advice 只提示「进度正常，剩余…（整月天数）」）
 */

/** 没设预算时的提示（页面卡片与 /api/budget 共用同一份文案，避免两处漂移） */
export const UNSET_BUDGET_SUGGESTION = '未设预算，可用 expense {action:"budget"} 设置';

/** 分 → `¥12.34`（固定两位小数、不带千分位：建议文案要稳定可断言） */
function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export interface BudgetSuggestionInput {
  /** 预算金额（分）；<=0 视为未设预算 */
  budget: number;
  /** 已用金额（分） */
  spent: number;
  /** 当月已过去的日号（0=月份还没开始，30/31=整月已过） */
  day: number;
  /** 该月天数 */
  daysInMonth: number;
}

export interface BudgetSuggestionResult {
  remaining_cents: number;
  ratio: number;
  /**
   * 花速：`ratio / 时间进度`。1 = 与时间同步，>1 表示花得比时间快。
   * 本月首日/未来月份等时间进度为 0 的情形记 0（不产生「无限超速」）。
   */
  pace: number;
  suggestion: string;
}

/**
 * 单行预算建议（纯函数：不确定「今天」、不读库，便于把边界口径钉死在单测里）。
 *
 * 判定顺序固定：未设预算 → 已超支（spent >= budget）→ 花速过快（pace > 1.1）→ 正常。
 * 阈值 1.1 是「容忍 10% 的提前量」：只看 pace 会把每天正常的消费波动都报成超支预警。
 */
export function budgetSuggestion(input: BudgetSuggestionInput): BudgetSuggestionResult {
  const budget = Math.round(input.budget);
  const spent = Math.max(0, Math.round(input.spent));
  const daysInMonth = Math.max(1, Math.round(input.daysInMonth));
  const day = Math.min(Math.max(Math.round(input.day), 0), daysInMonth);

  if (!Number.isFinite(budget) || budget <= 0) {
    return { remaining_cents: 0, ratio: 0, pace: 0, suggestion: UNSET_BUDGET_SUGGESTION };
  }

  const remaining = budget - spent;
  const ratio = spent / budget;
  const timeProgress = day / daysInMonth;
  const pace = day > 0 ? ratio / timeProgress : 0;

  // 已用完或超支：给出确切超支金额（正好用完时是 ¥0.00，仍比「进度正常」更准确）
  if (spent >= budget) {
    return {
      remaining_cents: remaining,
      ratio,
      pace,
      suggestion: `已超支 ${yuan(spent - budget)}`,
    };
  }

  const daysLeft = daysInMonth - day;
  // 按当前花速外推整月支出：spent / 时间进度。day=0 时 pace=0 不会进入这里。
  if (pace > 1.1 && daysLeft > 0) {
    const projected = spent / timeProgress;
    const overspend = Math.max(0, Math.round(projected - budget));
    // 日均上限向下取整：说「日均 ≤ ¥9.99」时必须真的花不到 ¥10
    const dailyCap = Math.floor(remaining / daysLeft);
    return {
      remaining_cents: remaining,
      ratio,
      pace,
      suggestion: `按当前速度会超支约 ${yuan(overspend)}；剩余 ${daysLeft} 天，建议日均 ≤ ${yuan(dailyCap)}`,
    };
  }

  return {
    remaining_cents: remaining,
    ratio,
    pace,
    suggestion: `进度正常，剩余 ${yuan(remaining)}（${daysLeft} 天）`,
  };
}

/** 一行预算的展示数据（总额与分类共用同一形状） */
export interface BudgetLineView extends BudgetSuggestionResult {
  budget_cents: number;
  spent_cents: number;
}

export interface CategoryBudgetView extends BudgetLineView {
  category: string;
}

export interface LedgerBudgetView {
  ledger_id: string;
  ledger_name: string;
  /** 该账本是否设过任何预算（总额或分类） */
  has_budget: boolean;
  /** 总额预算；没设总额（或完全没设预算）时为 null */
  total: BudgetLineView | null;
  categories: CategoryBudgetView[];
}

export interface BudgetPayload {
  month: string;
  ledgers: LedgerBudgetView[];
}

function toLine(budget: number, spent: number, day: number, daysInMonth: number): BudgetLineView {
  return {
    budget_cents: budget,
    spent_cents: spent,
    ...budgetSuggestion({ budget, spent, day, daysInMonth }),
  };
}

/**
 * 月份的时间进度（day/daysInMonth）。当月的 day 取本地日历日；过去月份视为整月已过，
 * 未来月份视为尚未开始。用 `YYYY-MM` 字符串比较即可（无 DST、固定 Asia/Shanghai）。
 */
function monthProgress(month: string, now: DateTime): { day: number; daysInMonth: number } {
  const first = DateTime.fromISO(`${month}-01`, { zone: TZ });
  const daysInMonth = first.isValid ? (first.daysInMonth ?? 30) : 30;
  const currentMonth = now.setZone(TZ).toFormat("yyyy-LL");
  if (month > currentMonth) return { day: 0, daysInMonth };
  if (month < currentMonth) return { day: daysInMonth, daysInMonth };
  return { day: now.setZone(TZ).day, daysInMonth };
}

/**
 * 预算看板数据：只含**活跃的家庭账本**（个人账本不在共享看板出现）。
 *
 * 每次 `budgetStatus` 会做一次当月支出汇总；因此先看 `getBudgets`，没设预算的账本
 * 直接返回 has_budget=false —— 不给「从来没设过预算」的账本白跑三条聚合查询。
 *
 * @param rawMonth YYYY-MM；缺省/非法回退当月（复用看板统一的 normalizeMonth）
 * @param now      时间进度基准（测试注入用；默认本地当前时刻）
 */
export function budgetPayload(
  db: DatabaseSync,
  rawMonth?: string,
  now: DateTime = DateTime.now().setZone(TZ),
): BudgetPayload {
  const month = normalizeMonth(rawMonth);
  const { day, daysInMonth } = monthProgress(month, now);
  const ledgers = db
    .prepare(
      `SELECT id, name FROM ledgers
       WHERE owner_profile_id IS NULL AND archived_at IS NULL
       ORDER BY name, id`,
    )
    .all() as { id: string; name: string }[];

  return {
    month,
    ledgers: ledgers.map((ledger) => {
      const budgets = getBudgets(db, ledger.id);
      if (budgets.length === 0) {
        return {
          ledger_id: ledger.id,
          ledger_name: ledger.name,
          has_budget: false,
          total: null,
          categories: [],
        };
      }
      const status = budgetStatus(db, ledger.id, month);
      return {
        ledger_id: ledger.id,
        ledger_name: ledger.name,
        has_budget: true,
        total:
          status.total === null
            ? null
            : toLine(status.total.budget_cents, status.total.spent_cents, day, daysInMonth),
        categories: status.categories.map((category) => ({
          category: category.category,
          ...toLine(category.budget_cents, category.spent_cents, day, daysInMonth),
        })),
      };
    }),
  };
}
