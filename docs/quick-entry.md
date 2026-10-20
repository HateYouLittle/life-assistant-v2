# 手机快捷入口（OPPO / ColorOS / Android）

> 状态：随第二阶段「写 API + 手机快捷入口」一起落地。服务地址形如
> `https://<你的 Lucky 域名>`（公网）或 `http://192.168.31.20:3080`（家里局域网）。
> 每个家庭成员使用**自己的 Profile token**（`PROFILE_TOKENS_JSON`），不要共用。

## 0. 准备

1. 服务端已配置（见 [remote-access.md](remote-access.md)）：
   - `PROFILE_TOKENS_JSON='{"default":"<tokenA>","bestie":"<tokenB>"}'`
   - `WEB_ALLOWED_HOSTS` 含 Lucky 前端域名与局域网地址
   - `REQUIRE_AUTH=1`
2. 拿到**属于你的那个 token**（例如 `bestie` 用 tokenB）。token 等同密码：不要发群里、不要截图。
3. 在手机浏览器打开一次 `https://<域名>/quick?token=<你的 token>`，页面会把 token 存进
   本地存储并抹掉地址栏。

## 1. PWA：添加到主屏幕（主路径）

1. 手机 Chrome/Edge 打开 `https://<域名>/quick`；
2. 菜单 →「添加到主屏幕」（OPPO 浏览器为「添加到桌面」）；
3. 桌面出现图标后，点开即可：
   - **记一笔**：输入金额 → 选账本（默认已选默认账本）→ 点常用分类 chip 或手输 → 保存；
   - **设提醒**：输入标题 → 点「今晚 20:00 / 明早 09:00 / 自定义」→ 保存；
   - 成功后弹回执，可「再记一笔」。
4. 预填链接（可被小布指令、NFC 贴纸、桌面快捷方式调用）：
   - 记账：`/quick?type=expense&amount=20&category=餐饮`
   - 提醒：`/quick?type=schedule&title=取快递`

## 2. HTTP Shortcuts：一键直达（推荐给固定动作）

安装 [HTTP Shortcuts](https://github.com/Waboodoo/HTTP-Shortcuts)（Play / F-Droid 均可，**需 ≥ 3.28**）。

**最快路径：直接导入 [http-shortcuts.json](http-shortcuts.json)**（含「记一笔」「设提醒」两个快捷方式，导入后把
`https://life.example.com` 和 `Bearer PASTE_YOUR_PROFILE_TOKEN_HERE` 替换成你的真实地址与 token；
详见 [http-shortcuts.md](http-shortcuts.md)）。

**方式 A：粘贴 cURL 导入**（App 内「导入 / Import from cURL」）：

```bash
curl -X POST 'https://<域名>/api/quick/expenses' \
  -H 'Authorization: Bearer <你的 token>' \
  -H 'Content-Type: application/json' \
  -d '{"amount":20,"category":"餐饮","note":"咖啡","request_id":"manual-1"}'
```

**方式 B：手动新建**：

| 字段 | 值 |
|---|---|
| Method | `POST` |
| URL | `https://<域名>/api/quick/expenses` |
| Header | `Authorization: Bearer <你的 token>` |
| Header | `Content-Type: application/json` |
| Body | `{"amount":{{amount}},"category":"{{category}}","request_id":"{{uuid}}"}` |

- `{{...}}` 是 HTTP Shortcuts 的变量：可以设成「每次询问」（弹输入框）或固定值；
- `request_id` 建议用变量里的 UUID/时间戳，**重试不会重复记账**（服务端幂等）；
- 保存后长按图标 → 添加到桌面，或加到「快捷设置」磁贴；
- 常用固定动作（如「咖啡 ¥20」）把 amount/category 写成固定值即可，点一下完成。

**提醒**：把 URL 换成 `/api/quick/schedules`，Body 用
`{"title":"{{title}}","time":"{{time}}","request_id":"{{uuid}}"}`。

## 3. 小布指令 / NFC（可选触发器）

- 小布指令（ColorOS）：新建一键指令 → 动作选「打开网页」→ 填 `/quick?type=expense`；
  语音「记一笔」即可打开预填页。
- NFC 贴纸：写入同一个 URL（玄关/冰箱贴一张），手机碰一下直接进记账页。

## 4. 自查（服务端视角）

```bash
# 用你的 token 取快捷页所需的账本/常用分类
curl -s -H 'Authorization: Bearer <你的 token>' https://<域名>/api/quick/bootstrap
# 记一笔（重试同 request_id 只落一行）
curl -s -X POST https://<域名>/api/quick/expenses \
  -H 'Authorization: Bearer <你的 token>' -H 'Content-Type: application/json' \
  -d '{"amount":12.5,"category":"餐饮","request_id":"selftest-1"}'
```

## 5. 安全与轮换

- Profile token 只能访问 `/api/quick/*` 与该 Profile 的 MCP 工具；看板/运维接口（`/api/*`）
  仍只认 master token。
- 泄露或换手机：改 `.env` 里 `PROFILE_TOKENS_JSON` 的对应值 → 重启 daemon
  （`launchctl kickstart -k gui/$(id -u)/ai.life-assistant.daemon`）→ 手机上重新用 `?token=` 引导。
- 公网只暴露 `/`、`/quick`、`/api/quick/*`、`/calendar.ics`；**不要**暴露 `/mcp`
  （SSE 会被反代缓冲卡住，且没有必要）。

## 6. 日历订阅（ICS）

`/calendar.ics` 使用签名 URL（不是上面的 token）：

```
https://<域名>/calendar.ics?p=<profile>&exp=<unix秒>&sig=<hex>
```

- 生成命令（在 Mac 上、仓库目录执行）：
  `npm run calendar:url -- --profile bestie --days 30 --base https://<域名>`；
  输出可直接粘贴进日历 App；`--days` 控制有效期（1..365）；
- iOS/Android 日历 App →「订阅日历」→ 粘贴该 URL；
- 链接过期或被轮换后重新生成即可；`X-PUBLISHED-TTL` 为 30 分钟。
