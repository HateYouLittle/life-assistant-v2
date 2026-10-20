# HTTP Shortcuts 导出（安卓一键记账/设提醒）

> 目标：在安卓桌面放两个磁贴——**记一笔**（只输金额）与**设提醒**（只输事项），直连
> daemon 的 `/api/quick/*`。文件：[http-shortcuts.json](http-shortcuts.json)。
> 相关背景见 [quick-entry.md](quick-entry.md) 与 [remote-access.md](remote-access.md)。

## 这个 JSON 是怎么来的（格式可信度）

不是猜的：字段结构逐项对照了 [Waboodoo/HTTP-Shortcuts](https://github.com/Waboodoo/HTTP-Shortcuts)
的源码与官方测试夹具（`ImportExportShortcut` / `ImportExportBase` / `ImportRepository` /
`app/src/test/resources/shortcuts-v90.json`），并按它的导入校验规则逐条自查：

- 根节点必须有 `categories`（否则 `ImportMigrator` 直接 `InvalidFileException`）；
- `version > 1`；`version`（92）高于旧版 App 的 `VERSION` 时要靠 `compatibilityVersion`（90）
  兜底 —— 因此本文件要求 **HTTP Shortcuts ≥ 3.28**（compatibilityVersion 90），更老的版本会
  提示版本不匹配，请先升级 App；
- `id` 用 UUID 字符串（App 校验 `isUUID() || isInt()`）；`name` 不可为空；
- 变量 `key` 必须是 `[A-Za-z0-9_]{1,30}`；正文里的占位符写作 `{{key}}`；
- `method` / `executionType` / `requestBodyType` / `responseHandling.*` 全是 App 的枚举字面量
  （`POST` / `app` / `custom_text` / `toast`·`response`·`detailed`）；
- **header 值必须是 ASCII 可见字符**（App 的 `Validation.isValidInHeaderValue` 只允许
  `0x20..0x7E`）——所以 token 占位符写成 `PASTE_YOUR_PROFILE_TOKEN_HERE`，**不能**写中文。

## 导入步骤

1. 手机浏览器打开 `https://<你的域名>/`（或 `/quick`），用 `?token=<你的 Profile token>` 引导一次，
   让页面把凭据记进 localStorage —— 这一步顺便验证域名与 token 是通的。
2. 把 [http-shortcuts.json](http-shortcuts.json) 传到手机（聊天工具发给自己 / 存到下载目录）。
3. 打开 HTTP Shortcuts → 右上角菜单 → **Import / Export** → **Import from File** → 选该 JSON。
4. 导入后逐个编辑两个快捷方式，把两处占位符换掉：
   - URL 里的 `life.example.com` → 你的实际域名（须与 `WEB_ALLOWED_HOSTS` 一致）；
   - Header `Authorization` 的 `Bearer PASTE_YOUR_PROFILE_TOKEN_HERE` → `Bearer <你的 Profile
     token>`（就是 `PROFILE_TOKENS_JSON` 里给该 Profile 配的 token）。
5. 长按快捷方式 → 添加到主屏幕（`launcherShortcut: true` 已默认开启）。

## 快捷方式做了什么

| 名称 | 请求 | 需要输入 |
|---|---|---|
| 记一笔 | `POST https://<域名>/api/quick/expenses`，body `{"amount":"{{amount}}","request_id":"{{request_id}}"}` | 金额（数字键盘） |
| 设提醒 | `POST https://<域名>/api/quick/schedules`，body `{"title":"{{title}}","request_id":"{{request_id}}"}` | 事项标题 |

- `request_id` 是 **uuid 类型变量**：每次执行生成一个新的 UUID，作为服务端写路径的幂等键
  （`client_token`）。同一次点击若因网络抖动被重试，服务端返回原记录并标「已存在」，不会重复记账/建提醒。
- 想加分类/备注/日期：在 app 里再建一个 `text` 变量（如 `category`、`note`、`time`），
  把 body 改成 `{"amount":"{{amount}}","category":"{{category}}","request_id":"{{request_id}}"}`
  即可 —— 字段名以 `/api/quick/*` 的入参为准：`amount` / `ledger_id` / `category` / `note` /
  `spent_on`（记账），`title` / `date` / `time` / `note` / `all_day` / `remind_offsets`（提醒）。
- 响应处理设成 `toast` + 显示响应正文：成功时弹出的就是服务端回执 JSON（`{"ok":true,...}`），
  失败时显示 HTTP 状态与错误说明（中文）。

## 不用 App 时：先用 cURL 验证接口（已按 `src/server/quick.ts` 核对）

```bash
# 记账：201 + {"ok":true,...}
curl -sS -X POST "https://<你的域名>/api/quick/expenses" \
  -H "Authorization: Bearer <你的 Profile token>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"20","request_id":"11111111-1111-4111-8111-111111111111"}'

# 设提醒：201 + {"ok":true,...}
curl -sS -X POST "https://<你的域名>/api/quick/schedules" \
  -H "Authorization: Bearer <你的 Profile token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"交房租","request_id":"22222222-2222-4222-8222-222222222222"}'
```

同一 `request_id` 再发一次应返回 `"已存在": true` 且不产生第二条记录 —— 这就是 Shortcuts 里
uuid 变量存在的意义。App 也支持 **Import from cURL**：把上面任一条 curl 粘进去就能生成等价的
快捷方式（不带变量），适合先跑通再手动加变量。

## 注意事项

- **明文 HTTP 可以，但不建议**：`/api/quick/*` 用 `Authorization: Bearer` 鉴权，走公网请务必
  经 NAS 的 Lucky 反代走 HTTPS（见 [remote-access.md](remote-access.md)），否则 token 与账目都在
  明文里。
- **标题里别用英文双引号**：body 是手写 JSON 模板（`"title":"{{title}}"`），变量是原样替换的；
  输入 `"` 会让 body 变成非法 JSON（服务端回 400）。要支持引号，可在 app 里给该变量打开
  「JSON encode」选项。
- token 是**凭据**：导出的 JSON 与手机上的快捷方式里都明文存着它；换 token 后记得同步改两处，
  丢了手机请在 `.env` 里换掉 `PROFILE_TOKENS_JSON`。
- 本文件只覆盖「记一笔 / 设提醒」两个动作；复杂操作（改账、完成日程、查汇总）仍走 MCP 工具
  或 `/quick` 页面。
