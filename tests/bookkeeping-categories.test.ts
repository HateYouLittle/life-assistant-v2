import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import {
  CATEGORY_DICT_SETTING,
  categorySummary,
  changeCategoryAlias,
  getCategoryDictionary,
  normalizeCategory,
  setCategoryDictionary,
} from "../src/modules/bookkeeping/service.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 分类字典/别名（按 Profile 保存）：expense add/update 时把「吃饭/外卖」这类口语
 * 归一成标准名「餐饮」，未知分类仍按自由文本保存（字典是可选的「路由表」，不强制）。
 * 统计与冲突校验都以「当前 Profile 可见的活跃账本」和「大小写折叠后的文本」为准。
 */

function tools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 1 }),
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function createLedgerId(t: ReturnType<typeof tools>, name: string, personal = false): string {
  const args: Record<string, unknown> = { action: "create", name };
  if (personal) args.personal = true;
  const created = JSON.parse(text(t.ledger(args))) as { 已创建: { id: string } };
  return created.已创建.id;
}

interface AddReceipt {
  已记账: { id: string; 分类: string };
}

function addExpense(
  t: ReturnType<typeof tools>,
  ledgerId: string,
  extra: Record<string, unknown> = {},
): AddReceipt {
  const result = t.expense({ action: "add", ledger_id: ledgerId, amount: 1, ...extra });
  assert.notEqual(result.isError, true, `记账应成功：${text(result)}`);
  return JSON.parse(text(result)) as AddReceipt;
}

/** 直接落库造历史数据（绕过工具，模拟「字典建立之前」已经记下的口语分类） */
function seedExpense(
  env: TestEnv,
  input: {
    id: string;
    ledgerId: string;
    cents: number;
    category: string;
    date: string;
    profile?: string;
  },
): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      input.id,
      input.ledgerId,
      input.cents,
      input.category,
      input.date,
      input.profile ?? "default",
    );
}

function localDay(offset: number): string {
  return DateTime.fromISO(todayIso(), { zone: TZ }).plus({ days: offset }).toISODate() as string;
}

describe("分类字典：normalizeCategory 归一规则", () => {
  it("标准名原样、别名→标准名、未知分类保留、空白 trim、大小写折叠", () => {
    const env = makeTestEnv();
    try {
      setCategoryDictionary(env.db, "default", {
        餐饮: ["吃饭", "外卖"],
        Food: ["Eat", "DINNER"],
      });
      assert.equal(normalizeCategory(env.db, "default", "餐饮"), "餐饮", "标准名原样");
      assert.equal(normalizeCategory(env.db, "default", " 餐饮 "), "餐饮", "前后空白被 trim");
      assert.equal(normalizeCategory(env.db, "default", "吃饭"), "餐饮", "别名归一");
      assert.equal(normalizeCategory(env.db, "default", "外卖"), "餐饮");
      assert.equal(normalizeCategory(env.db, "default", "  外卖  "), "餐饮", "别名也先 trim");
      assert.equal(normalizeCategory(env.db, "default", "food"), "Food", "标准名大小写折叠");
      assert.equal(normalizeCategory(env.db, "default", "FOOD"), "Food");
      assert.equal(normalizeCategory(env.db, "default", "dinner"), "Food", "别名大小写折叠");
      assert.equal(normalizeCategory(env.db, "default", "娱乐"), "娱乐", "未知分类保留自由文本");
      assert.equal(normalizeCategory(env.db, "default", "\t娱乐 "), "娱乐");
      assert.equal(normalizeCategory(env.db, "default", "   "), "", "空白交给「其他」兜底");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨 Profile 隔离：A 的字典不影响 B", () => {
    const env = makeTestEnv();
    try {
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭"] });
      assert.equal(normalizeCategory(env.db, "default", "吃饭"), "餐饮");
      assert.equal(
        normalizeCategory(env.db, "partner", "吃饭"),
        "吃饭",
        "B 没有字典时不应被 A 的别名改写",
      );
      setCategoryDictionary(env.db, "partner", { 饮食: ["吃饭"] });
      assert.equal(normalizeCategory(env.db, "partner", "吃饭"), "饮食");
      assert.equal(normalizeCategory(env.db, "default", "吃饭"), "餐饮");
      assert.deepEqual(getCategoryDictionary(env.db, "default"), { 餐饮: ["吃饭"] });
      assert.deepEqual(getCategoryDictionary(env.db, "partner"), { 饮食: ["吃饭"] });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("坏形状/坏 JSON 的设置按空字典处理，不让记账写路径整体失败", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES ('default', ?, ?, ?)",
        )
        .run(CATEGORY_DICT_SETTING, '{"餐饮":"吃饭"}', new Date().toISOString());
      assert.deepEqual(getCategoryDictionary(env.db, "default"), {}, "别名不是数组 → 忽略该条");
      assert.equal(normalizeCategory(env.db, "default", "吃饭"), "吃饭");

      env.db
        .prepare("UPDATE settings SET value_json = '{bad' WHERE profile_id = 'default' AND key = ?")
        .run(CATEGORY_DICT_SETTING);
      assert.deepEqual(getCategoryDictionary(env.db, "default"), {}, "坏 JSON 按空字典处理");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("setCategoryDictionary 拒绝重复标准名与跨分类的别名冲突", () => {
    const env = makeTestEnv();
    try {
      assert.throws(
        () => setCategoryDictionary(env.db, "default", { 餐饮: [], " 餐饮 ": [] }),
        /分类名重复/,
      );
      assert.throws(
        () => setCategoryDictionary(env.db, "default", { 餐饮: ["Food"], Food: ["x"] }),
        /别名与标准名冲突/,
      );
      assert.throws(
        () => setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭"], 交通: ["吃饭"] }),
        /别名重复/,
      );
      assert.throws(
        () => setCategoryDictionary(env.db, "default", { 餐饮: ["点".repeat(21)] }),
        /别名需为 1-20 字符/,
      );
      assert.throws(() => setCategoryDictionary(env.db, "default", { "   ": [] }), /分类名需为/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("分类字典：add / update 落库归一", () => {
  it("add 命中别名/标准名时落标准名；未知分类保持自由文本；缺省仍是「其他」", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "日常");
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭", "外卖"] });

      assert.equal(addExpense(t, ledgerId, { category: "吃饭" }).已记账.分类, "餐饮");
      assert.equal(addExpense(t, ledgerId, { category: "外卖" }).已记账.分类, "餐饮");
      assert.equal(addExpense(t, ledgerId, { category: " 餐饮 " }).已记账.分类, "餐饮");
      assert.equal(addExpense(t, ledgerId, { category: "娱乐" }).已记账.分类, "娱乐");
      const fallback = addExpense(t, ledgerId);
      assert.equal(fallback.已记账.分类, "其他", "未传分类仍是「其他」");

      const stored = env.db
        .prepare("SELECT category FROM expenses ORDER BY created_at, id")
        .all() as { category: string }[];
      assert.deepEqual(
        stored.map((row) => row.category).sort(),
        ["其他", "娱乐", "餐饮", "餐饮", "餐饮"].sort(),
        "落库的必须是归一后的标准名",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 显式传 category 时归一；不传 category 时不动已存在数据", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "编辑归一");
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭"] });
      const added = addExpense(t, ledgerId, { category: "娱乐" });

      const updated = JSON.parse(
        text(t.expense({ action: "update", id: added.已记账.id, category: "吃饭" })),
      ) as { 已更新: { 分类: string } };
      assert.equal(updated.已更新.分类, "餐饮", "update 也要走别名归一");
      assert.equal(
        (
          env.db.prepare("SELECT category FROM expenses WHERE id = ?").get(added.已记账.id) as {
            category: string;
          }
        ).category,
        "餐饮",
      );

      // 只改备注：分类（尤其是字典建立前写入的自由文本）不能被顺手改写
      const legacy = addExpense(t, ledgerId, { category: "旧分类" });
      assert.equal(legacy.已记账.分类, "旧分类");
      t.expense({ action: "update", id: legacy.已记账.id, note: "补备注" });
      const row = env.db
        .prepare("SELECT category, note FROM expenses WHERE id = ?")
        .get(legacy.已记账.id) as { category: string; note: string };
      assert.equal(row.category, "旧分类", "不传 category 不应改动原分类");
      assert.equal(row.note, "补备注");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("字典只在写入时生效：建立字典不会改写已存在的分类", () => {
    const env = makeTestEnv();
    try {
      const ledger = env.db
        .prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '历史账本', ?)")
        .run(new Date().toISOString());
      assert.ok(ledger.changes === 1);
      seedExpense(env, {
        id: "old",
        ledgerId: "l1",
        cents: 100,
        category: "吃饭",
        date: "2026-01-10",
      });
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭"] });
      const row = env.db.prepare("SELECT category FROM expenses WHERE id = 'old'").get() as {
        category: string;
      };
      assert.equal(row.category, "吃饭", "已存在数据不得被迁移改写");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨 Profile：A 的别名不影响 B 写入", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const ledgerId = createLedgerId(owner, "家庭账本");
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭"] });
      const mine = addExpense(owner, ledgerId, { category: "吃饭" });
      const theirs = addExpense(partner, ledgerId, { category: "吃饭" });
      assert.equal(mine.已记账.分类, "餐饮");
      assert.equal(theirs.已记账.分类, "吃饭", "B 没有字典，保持自由文本");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("分类字典：category_alias 工具", () => {
  it("添加别名并返回更新后的分类；重复添加幂等；标准名大小写折叠不新建分类", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const first = JSON.parse(
        text(t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" })),
      ) as { 分类: { 名称: string; 别名: string[] }; 说明: string };
      assert.equal(first.分类.名称, "餐饮");
      assert.deepEqual(first.分类.别名, ["吃饭"]);
      assert.match(first.说明, /别名/);

      const second = JSON.parse(
        text(t.expense({ action: "category_alias", category: "餐饮", alias: "外卖" })),
      ) as { 分类: { 名称: string; 别名: string[] } };
      assert.deepEqual(second.分类.别名, ["吃饭", "外卖"]);

      // 同一别名重复添加：幂等，不产生重复项
      const again = JSON.parse(
        text(t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" })),
      ) as { 分类: { 别名: string[] } };
      assert.deepEqual(again.分类.别名, ["吃饭", "外卖"]);

      // 大小写/形态不同的标准名不会建出第二个分类
      const folded = JSON.parse(
        text(t.expense({ action: "category_alias", category: " FOOD ", alias: "eat" })),
      ) as { 分类: { 名称: string; 别名: string[] } };
      assert.equal(folded.分类.名称, "FOOD", "保留首次建立时的写法");
      assert.deepEqual(folded.分类.别名, ["eat"]);
      const refolded = JSON.parse(
        text(t.expense({ action: "category_alias", category: "food", alias: "dinner" })),
      ) as { 分类: { 名称: string; 别名: string[] } };
      assert.equal(refolded.分类.名称, "FOOD", "折叠后同名 → 复用已有标准名");
      assert.deepEqual(refolded.分类.别名, ["eat", "dinner"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("冲突/非法输入全部拒绝，且不落库", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" });
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["别名与其它标准名冲突", { category: "餐饮", alias: "餐饮" }, /别名不能与分类名相同|冲突/],
        ["别名与其它分类的别名冲突", { category: "交通", alias: "吃饭" }, /冲突/],
        ["新分类名与已有别名冲突", { category: "吃饭", alias: "外卖" }, /冲突/],
        ["分类名空白", { category: "  ", alias: "外卖" }, /分类名需为/],
        ["别名空白", { category: "餐饮", alias: "  " }, /别名需为/],
        ["别名超长", { category: "餐饮", alias: "点".repeat(21) }, /别名需为/],
      ];
      for (const [why, args, expected] of cases) {
        const result = t.expense({ action: "category_alias", ...args });
        assert.equal(result.isError, true, `${why}应被拒绝`);
        assert.match(text(result), expected, why);
      }
      // 缺参数
      assert.equal(t.expense({ action: "category_alias", category: "餐饮" }).isError, true);
      // 失败不得污染字典
      assert.deepEqual(getCategoryDictionary(env.db, "default"), { 餐饮: ["吃饭"] });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("remove=true 删除别名；之后该文本不再归一（删除不存在的别名幂等）", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "删除别名");
      t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" });
      t.expense({ action: "category_alias", category: "餐饮", alias: "外卖" });
      assert.equal(addExpense(t, ledgerId, { category: "吃饭" }).已记账.分类, "餐饮");

      const removed = JSON.parse(
        text(
          t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭", remove: true }),
        ),
      ) as { 分类: { 名称: string; 别名: string[] }; 说明: string };
      assert.deepEqual(removed.分类.别名, ["外卖"]);
      assert.match(removed.说明, /不再归一/);
      assert.equal(
        addExpense(t, ledgerId, { category: "吃饭" }).已记账.分类,
        "吃饭",
        "删除别名后恢复自由文本",
      );
      // 其它别名仍生效
      assert.equal(addExpense(t, ledgerId, { category: "外卖" }).已记账.分类, "餐饮");

      // 删除不存在的别名：幂等成功，不报错、不凭空建分类
      const ghost = t.expense({
        action: "category_alias",
        category: "交通",
        alias: "打车",
        remove: true,
      });
      assert.notEqual(ghost.isError, true);
      assert.deepEqual(getCategoryDictionary(env.db, "default"), { 餐饮: ["外卖"] });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("分类字典：expense {action:'categories'} 视图", () => {
  it("字典为空时列出近 90 天实际用过的分类（当前 Profile 可见账本）", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "统计");
      addExpense(t, ledgerId, { category: "餐饮", amount: 30 });
      addExpense(t, ledgerId, { category: "餐饮", amount: 20 });
      addExpense(t, ledgerId, { category: "交通", amount: 5 });
      // 90 天以外的不计入
      seedExpense(env, {
        id: "old",
        ledgerId,
        cents: 99900,
        category: "旧分类",
        date: localDay(-100),
      });

      const view = JSON.parse(text(t.expense({ action: "categories" }))) as {
        分类: { 名称: string; 别名: string[]; 近90天笔数: number; 近90天金额: string }[];
        说明: string;
      };
      assert.deepEqual(
        view.分类.map((row) => [row.名称, row.近90天笔数, row.近90天金额]),
        [
          ["餐饮", 2, "¥50.00"],
          ["交通", 1, "¥5.00"],
        ],
        "按金额降序；只统计近 90 天",
      );
      assert.ok(view.分类.every((row) => row.别名.length === 0));
      assert.match(view.说明, /尚未建立分类别名/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("有字典时列出标准名+别名，并把以别名记下的历史支出统计到标准名下", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "字典统计");
      setCategoryDictionary(env.db, "default", { 餐饮: ["吃饭", "外卖"], 交通: [] });
      // 历史数据（字典建立前）以别名形式落库，也要计入标准名
      seedExpense(env, {
        id: "h1",
        ledgerId,
        cents: 2000,
        category: "吃饭",
        date: localDay(-1),
      });
      seedExpense(env, {
        id: "h2",
        ledgerId,
        cents: 1000,
        category: "外卖",
        date: localDay(-2),
      });
      seedExpense(env, {
        id: "h3",
        ledgerId,
        cents: 500,
        category: "打车",
        date: localDay(-3),
      });

      const view = JSON.parse(text(t.expense({ action: "categories" }))) as {
        分类: { 名称: string; 别名: string[]; 近90天笔数: number; 近90天金额: string }[];
      };
      const byName = new Map(view.分类.map((row) => [row.名称, row]));
      assert.deepEqual(byName.get("餐饮")?.别名, ["吃饭", "外卖"]);
      assert.equal(byName.get("餐饮")?.近90天笔数, 2, "别名历史支出计入标准名");
      assert.equal(byName.get("餐饮")?.近90天金额, "¥30.00");
      assert.ok(byName.has("交通"), "字典里的标准名即使 0 笔也要列出");
      assert.equal(byName.get("交通")?.近90天笔数, 0);
      assert.equal(byName.get("交通")?.近90天金额, "¥0.00");
      assert.deepEqual(byName.get("打车")?.别名, [], "不在字典里的自由文本也列出，方便建别名");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("统计只覆盖当前 Profile 可见账本：别人的个人账本不出现", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const family = createLedgerId(owner, "家庭");
      const mine = createLedgerId(owner, "我的私房钱", true);
      const theirs = createLedgerId(partner, "对方的私房钱", true);
      seedExpense(env, {
        id: "f",
        ledgerId: family,
        cents: 100,
        category: "家庭分类",
        date: localDay(0),
      });
      seedExpense(env, {
        id: "m",
        ledgerId: mine,
        cents: 200,
        category: "我的分类",
        date: localDay(0),
      });
      seedExpense(env, {
        id: "t",
        ledgerId: theirs,
        cents: 300,
        category: "对方的分类",
        date: localDay(0),
      });

      const mineView = JSON.parse(text(owner.expense({ action: "categories" }))) as {
        分类: { 名称: string }[];
      };
      const names = mineView.分类.map((row) => row.名称);
      assert.deepEqual(names.sort(), ["家庭分类", "我的分类"].sort());

      const partnerView = JSON.parse(text(partner.expense({ action: "categories" }))) as {
        分类: { 名称: string }[];
      };
      const partnerNames = partnerView.分类.map((row) => row.名称);
      assert.ok(partnerNames.includes("家庭分类"), "家庭账本对所有人可见");
      assert.ok(!partnerNames.includes("我的分类"), "别人的个人账本不得出现");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("service 层 categorySummary 与工具输出同口径（便于直接复用）", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '家庭', ?)")
        .run(new Date().toISOString());
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 1234,
        category: "餐饮",
        date: todayIso(),
      });
      const rows = categorySummary(env.db, "default");
      assert.deepEqual(
        rows.map((row) => ({ name: row.name, count: row.count, cents: row.cents })),
        [{ name: "餐饮", count: 1, cents: 1234 }],
      );
      const state = changeCategoryAlias(env.db, "default", { category: "餐饮", alias: "吃饭" });
      assert.deepEqual(state, { name: "餐饮", aliases: ["吃饭"] });
    } finally {
      cleanupTestEnv(env);
    }
  });
});
