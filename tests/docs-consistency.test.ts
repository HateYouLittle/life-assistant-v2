import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * 文档一致性回归：package.json 里带 --env-file 的脚本清单必须与 README / .env.example
 * 的说明同步（曾漏列 db:cleanup:preview）；GeoAPI「不得落盘」条款必须带 locate 例外说明
 * （locate 显式选定的位置是用户配置，不是缓存/批量索引——文档漏了例外会让实现看起来违约）。
 */

const read = (path: string): string => readFileSync(path, "utf8");

describe("文档一致性", () => {
  it("package.json 带 --env-file 的脚本都写进 README 与 .env.example 的清单", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const withEnvFile = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes("--env-file-if-exists"))
      .map(([name]) => name)
      // dev:* 变体在文档中统一以「及其 dev:* 变体」表述，不逐个列名
      .filter((name) => !name.startsWith("dev:"));
    assert.ok(
      withEnvFile.length >= 4,
      `应至少有 start/dev/db:backup/db:cleanup:preview/import:v1，实际 ${withEnvFile.join(", ")}`,
    );

    const readmePara = read("README.md")
      .split(/\n\n/)
      .find((p) => p.includes("--env-file-if-exists"));
    assert.ok(readmePara !== undefined, "README 应有 --env-file 说明段");
    const envExamplePara = read(".env.example")
      .split(/\n\n/)
      .find((p) => p.includes("--env-file-if-exists"));
    assert.ok(envExamplePara !== undefined, ".env.example 应有 --env-file 说明段");

    for (const name of withEnvFile) {
      assert.ok(
        (readmePara ?? "").includes(name),
        `README 的 --env-file 清单缺 ${name}（清单必须与 package.json 同步）`,
      );
      assert.ok(
        (envExamplePara ?? "").includes(name),
        `.env.example 的 --env-file 清单缺 ${name}（清单必须与 package.json 同步）`,
      );
    }
  });

  it("GeoAPI「不得落盘」条款带 locate 显式选定位置的例外说明", () => {
    const locateException = "显式选定的位置会作为该 Profile 的配置长期保存";
    assert.ok(
      read("README.md").includes(locateException),
      "README 的 GeoAPI 条款应说明 locate 选定位置属用户配置例外",
    );
    assert.ok(
      read("AGENTS.md").includes(locateException),
      "AGENTS.md 的 GeoAPI 条款应说明 locate 选定位置属用户配置例外",
    );
  });
});
