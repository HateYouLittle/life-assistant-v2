# AGENTS.md

个人生活助理 MCP 服务，面向 Hermes Agent。单守护进程承载 MCP（Streamable HTTP）+ 定时调度 +
outbox 主动推送 + 状态页，共用一个 SQLite 文件。
`README.md` 是权威设计文档（中文），改行为前先读；`skill/SKILL.md` 是面向用户的工具语义。

## 命令

需要 Node.js **>= 22.13**（使用内置 `node:sqlite`，无外部数据库驱动）。

```bash
npm install
cp .env.example .env               # DATA_DIR 必须是绝对路径
npm run typecheck                  # 对 src 和 tests 分别跑 tsc（两个配置）
npm run lint                       # Biome，error 级诊断会让命令失败
npm run format:check
npm test                           # node:test + tsx 跑 tests/**/*.test.ts
npm run build                      # tsc -> dist/
```

CI（`.github/workflows/ci.yml`）在 Node 22 和 24 上按此顺序运行：
`typecheck -> lint -> format:check -> test -> build`。自称完成前先跑完整链路。

- 只跑单个测试文件：`node --import tsx/esm --test tests/schedule.test.ts`
- `npm run dev` 用 tsx 跑 `src/daemon.ts`；`npm start` 跑构建产物 `dist/daemon.js`
  （需先 `npm run build`）。`db:backup` / `db:cleanup:preview` / `import:v1` 同理：
  无前缀脚本依赖 `dist/`，`dev:*` 变体直接跑 TS 源码。
- `.env` 只会被 `start` / `dev` / `db:backup` / `db:cleanup:preview` / `import:v1`
  及其 `dev:*` 变体通过 `--env-file-if-exists` 自动读取。其他命令需手动
  `set -a; source .env; set +a`。
- 首次运行会创建 `$DATA_DIR/life-assistant.db`；测试使用一次性临时目录。

## 架构

- `src/core/` 是框架层：database/registry/auth/http/logger/settings/notify/render/
  qweather/qweather-jwt/holiday/recurrence。`src/modules/`（weather/holiday/schedule/bookkeeping/notify）
  通过 `src/modules/index.ts` 的副作用 import 接入，遵循 `tools / jobs / tick / onStart`
  四个契约扩展点。
- **核心层不得 import 模块内部。** 这一点由 `tests/registry.test.ts` 的静态 import 扫描强制，
  而不仅是运行时查重。新模块在 `modules/index.ts` 注册。
- 例外是 `src/server/details.ts`，它直接 import 了 bookkeeping/schedule 的纯函数（已知技术债）。
  改模块内部签名可能静默破坏状态页——记得同步检查 `details.ts`。
- Runtime 是进程级单例（`src/core/registry.ts` 的 `initRuntime`/`runtime`），只能初始化一次。
  测试必须用 `makeTestEnv()` + `cleanupTestEnv()`（`tests/helpers.ts`），后者会重置 runtime
  并调用 `cancelPendingDrain()`。
- SQLite：STRICT 表、WAL、开启外键。schema 版本存在 `meta.schema_version`，启动时逐级
  附加式升级；库版本高于程序 `SCHEMA_VERSION` 时拒绝启动（`src/core/database.ts`）。
  `schedules.escalation_json` 走幂等补列且**不**提升版本号（重建 `schedules` 会破坏
  `occurrences` 外键与 `kind` 的 CHECK），因此 `schema_version` 并非表结构的完整指纹。
- 时区固定 `Asia/Shanghai`（`src/time.ts`），无 DST。数据库存 UTC ISO 瞬间；本地日历日是
  `YYYY-MM-DD` 字符串。

## 测试

- 测试运行器是 `node:test`（无 jest/vitest）。测试通过 tsx 直接跑 `src/**`，无需构建。
- **测试里不要启动真实 daemon**——它的 cron/定时器会让进程不退出。测 HTTP 请调用
  `createHttpHandler(config, db)` 并监听端口 `0`（见 `tests/daemon-mcp.test.ts`）。
- 用 `makeTestEnv(extraEnv)` 搭测试环境；它会建临时 `DATA_DIR`、打开库、种入 profile
  `default`，并把 `publishProfile`/`publishGlobal` 的调用记录到 `env.published`。
  务必在 `finally` 里 `cleanupTestEnv(env)`。
- 状态页内联 JS 在 `node:vm` + DOM 桩里做端到端测试（`tests/status-page-script.test.ts`），
  因为纯字符串断言看不出整页渲染故障。

## 约定

- ESM（`"type": "module"`、NodeNext）：相对 import **必须**带 `.js` 后缀，即使在 `.ts`
  源码里；纯类型 import 用 `import type`（开启了 `verbatimModuleSyntax`）。
- Biome 2.x：2 空格缩进、100 列。`noExplicitAny`、`noNonNullAssertion` 为 error；
  命令只对 error 级诊断失败（未启用 `--error-on-warnings`，warn 级不会让命令失败）。
- 工具输出与 `SKILL.md` 用中文（输出键如 `标题`/`类型`/`状态`）。新增工具输出保持中文，
  并与既有形状一致。
- 提交信息：conventional 前缀（`feat:`、`fix:`、`docs:`、`chore:`）+ 中文描述。
- `data*/` 被 gitignore（别提交真实数据库）；除 `.env.example` 外的 `.env*` 也被忽略。

## 注意

- QWeather 的 GeoAPI 结果不得缓存/落盘/批量建索引（版权限制）——只允许进程内 memo。
  例外：用户经 `weather locate` 显式选定的位置会作为该 Profile 的配置长期保存，属用户
  主动设置而非缓存/批量索引。
  HTTP 错误只对 429/5xx/网络故障重试；**4xx 必须立即抛出**（反复重试错误请求会导致
  账号被冻结）。API KEY 是回退；优先 Ed25519 JWT，且四个 `QWEATHER_JWT_*` 变量必须
  同时配置，否则启动失败。
- `notify.pull` 只能取消 `queued`/`failed` 的投递，无法拦住已处于 `sending` 的那一次。
- `npm run db:cleanup:preview` 是 occurrence 清理 job（每日 04:30）的只读预演——
  改清理规则前先用它。
