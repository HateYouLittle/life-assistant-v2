# 远程访问与手机快捷入口（局域网 + NAS Lucky 反代）

> 状态：**设计已定，待施工**（2026-10-20，按「服务只跑局域网、由 NAS 上的 Lucky 反代出去」更新）。
> 目标：daemon 只在局域网监听；公网入口由 NAS 上的 Lucky 终结 TLS 并反代；手机在任意网络
> 通过 HTTPS 使用 `/quick` 记账/提醒与 HTTP Shortcuts 一键直达。

## 拓扑

```
OPPO 手机（蜂窝 / 任意 Wi-Fi）──HTTPS──► 公网域名（Lucky 申请/续期证书）
                                              │
                                     NAS: Lucky 反向代理（TLS 终止、DDNS、路径控制）
                                              │  http://<Mac 局域网 IP>:3080
                                              ▼
                                 Mac: life-assistant daemon（绑 0.0.0.0，不直接暴露公网）
```

要点：Mac 不需要公网 IPv6、不需要 DDNS 或证书；这些全部由 NAS 上的 Lucky 负责。
daemon 只做「局域网内可信入口 + token 鉴权」；外网的攻击面收敛在 Lucky 一个站点上。

## 前置条件

1. **Mac 固定局域网 IP**（路由器 DHCP 绑定，如 `192.168.31.20`），否则 Lucky 后端地址会漂。
2. **daemon 改绑局域网**：`.env` 的 `HOST` 从 `127.0.0.1` 改为 `0.0.0.0`（或直接写 LAN IP）。
   注意：非回环绑定会强制要求 `WEB_API_TOKEN`（≥32 字符），这是安全底线，不要关。
3. **NAS 能访问 Mac**：同一局域网；macOS 防火墙允许 Node 接受入站（系统设置 → 网络 → 防火墙）。
4. **Lucky**：已部署在 NAS，负责公网域名、证书、反代与（可选）访问控制。
5. **手机端**：`/quick` PWA + HTTP Shortcuts（见下）。

## daemon 配置（`.env`）

```dotenv
DATA_DIR=/Users/cracked/workspace/life-assistant/data
HOST=0.0.0.0                 # 允许 NAS 反代进来；不要写 127.0.0.1
PORT=3080
REQUIRE_AUTH=1               # 即使只绑局域网也强制鉴权
WEB_API_TOKEN=<master token，openssl rand -hex 32>
# 每人一个 token（阶段二实现后启用；服务端由 token 反查 Profile，不再信 X-Hermes-Profile）
PROFILE_TOKENS_JSON='{"default":"<token-default>","bestie":"<token-bestie>"}'
# Host/Origin 守卫放行名单：Lucky 前端域名 + Mac 的 LAN 地址都要有。
# 端口按 Lucky 实际使用写：443 可省略端口；非标准端口要写 <域名>:<端口>。
WEB_ALLOWED_HOSTS=life.example.com,life.example.com:8443,192.168.31.20:3080,192.168.31.20
```

改完重启 daemon（launchd）：

```bash
launchctl kickstart -k gui/$(id -u)/ai.life-assistant.daemon
curl -s http://192.168.31.20:3080/healthz          # 局域网内应通
```

> 绑定 `0.0.0.0` 后，**没有 token 的旧配置会拒绝启动**——这正是我们要的。
> 若只想让 NAS 访问、Mac 所在网络还有其他设备，也可把 `HOST` 写成 Mac 的 LAN IP。

## Lucky 反代配置要点

1. **前端地址**：`https://life.example.com`（Lucky 里配好域名 + 证书自动续期）。
2. **后端地址**：`http://192.168.31.20:3080`（HTTP 明文仅走局域网，TLS 在 Lucky 终止）。
3. **Host 头**（关键，二选一，取决于 Lucky 的设置项）：
   - **保留原 Host**（推荐）：Lucky 把 `Host: life.example.com` 原样转给后端 → 上面
     `WEB_ALLOWED_HOSTS` 已包含它；
   - **改写为后端地址**：Lucky 把 Host 改成 `192.168.31.20:3080` → 白名单里的 LAN 项生效。
   - 两者都在白名单里，任选其一都不会 403。
4. **响应缓冲**：`/quick`、`/api/quick/*`、`/calendar.ics`、`/readyz` 都是普通请求，无需特殊处理；
   **`/mcp` 是 Streamable HTTP + SSE，需要关闭 Lucky 的响应缓冲/超时改写**，否则 MCP 会卡住。
   建议公网**不要暴露 `/mcp`**（Hermes 走内网或 stdio 壳即可），只放 `/`、`/quick`、`/api/quick/*`、`/calendar.ics`、`/readyz`。
5. **可选加固**（Lucky 侧）：Basic Auth/访问控制作为第二道门；只反代必要路径；
   如果有多个家庭站点，给这个服务单独的子域名。
6. **HTTPS 强制**：Lucky 前端只开 HTTPS，HTTP 跳转或直接拒绝。

## 验证

```bash
# 局域网（Mac 上执行）
curl -s http://192.168.31.20:3080/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.31.20:3080/api/status          # 401（无 token）
curl -s -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}\n' \
     http://192.168.31.20:3080/api/status                                              # 200

# 手机蜂窝网络（关掉 Wi-Fi）
curl -sS https://life.example.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://life.example.com/api/status          # 401
# 浏览器打开 https://life.example.com/quick?token=<profile token> → 添加到主屏幕

# 守卫：伪造 Host / 跨站 Origin 必须 403（走 Lucky 时 Host 由 Lucky 决定）
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example.com' https://life.example.com/api/status
```

## 手机端（ColorOS / OPPO）

1. **`/quick` PWA（主路径）**：手机浏览器打开 `/quick?token=<profile token>` 一次（token 存
   localStorage、地址栏抹掉），「添加到主屏幕」。记账 = 金额 + 常用分类 chips；提醒 = 标题 +
   时间 chips。纯前台页面，不受 ColorOS 后台查杀影响。
2. **HTTP Shortcuts（一键直达）**：安装 [Waboodoo/HTTP-Shortcuts](https://github.com/Waboodoo/HTTP-Shortcuts)，
   按 [quick-entry.md](quick-entry.md) 配置（`POST https://life.example.com/api/quick/expenses`，Header
   `Authorization: Bearer <每人 token>`，body 带 `request_id`）。可做桌面小组件/快捷设置磁贴。
   固定动作（如「咖啡 ¥20」）一键完成；变量动作弹输入框要金额。
3. **小布指令 / NFC（触发器，可选）**：小布指令「打开网页」指向 `/quick?type=expense`；
   NFC 贴纸写入同一个 URL（碰一下进入预填页）。

## 安全清单（Lucky 反代出去之前必须完成）

- [ ] `HOST=0.0.0.0` + `WEB_API_TOKEN`（≥32 字符）+ `REQUIRE_AUTH=1`，先验证无 token 时 401
- [ ] per-profile token：token → Profile，拒绝 `X-Hermes-Profile` 自报身份（公网入口下尤其重要）
- [ ] 写 API 限流：按 token + 来源 IP 的固定窗口，超限 429；Lucky 后面的真实来源 IP 走
      `X-Forwarded-For`，只在 `TRUST_PROXY=1` 时采信（且只信任 NAS 的 LAN 地址）
- [ ] `WEB_ALLOWED_HOSTS` 精确覆盖 Lucky 前端域名（含端口）与 LAN 地址
- [ ] 公网只放必要路径：`/`、`/quick`、`/api/quick/*`、`/calendar.ics`、`/readyz`；`/mcp` 不暴露（或单独子域 + 关缓冲）
- [ ] 失败鉴权写 warn 日志并计入 `/metrics`（公网暴露后会立刻有扫描）
- [ ] 审计日志（阶段二 #8）与写 API 同批上线，至少记录账本/预算/删除类操作
- [ ] 回滚：停用 Lucky 的这条反代规则即断开公网；daemon 与数据不受影响

## 附录：不走 Lucky 时（可选，不采用）

若以后没有 Lucky，可在 Mac 上直接做公网 IPv6 + Caddy/acme.sh（TLS 终止在 Mac）。
届时需要：公网 IPv6、DDNS 更新 AAAA、路由器只放行反代端口、固定 macOS IPv6 地址、
证书（80/443 可用走 Caddy 自动，否则 acme.sh DNS-01）。当前方案不涉及这些。

## 未决问题

1. Lucky 前端**域名与端口**（证书是否已签发、是否用 443）。
2. Lucky 反代时 **Host 头是保留还是改写**（决定白名单最终保留哪几项；两者都写也无害）。
3. 是否同意**公网不暴露 `/mcp`**（只放 `/`、`/quick`、`/api/quick/*`、`/calendar.ics`、`/readyz`）。
