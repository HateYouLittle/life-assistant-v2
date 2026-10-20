# 远程访问与手机快捷入口（阶段二设计稿）

> 状态：**设计已定，待施工**（2026-10-20）。
> 目标：手机在任意网络下通过 HTTPS 使用记账/提醒快捷入口；daemon 本体仍只绑回环，
> 公网暴露面收敛为反向代理的一个 HTTPS 站点。本文是施工清单，不是已完成的能力。

## 拓扑

```
OPPO 手机（蜂窝/家里 Wi-Fi）
   │  HTTPS (IPv6)
   ▼
DDNS 域名 AAAA ──► 路由器 IPv6 防火墙（只放行 TCP 8443）
   │
   ▼
Mac: Caddy 反向代理（TLS 终止, 监听 [::]:8443）
   │  http://127.0.0.1:3080
   ▼
life-assistant daemon（HOST=127.0.0.1，不直接暴露）
```

这样做的好处：证书/限流/访问日志都在反代层；daemon 继续零公网监听；回滚只需删一条防火墙规则。

## 前置条件（网络侧）

1. **公网 IPv6 可达**：运营商已下发；路由器拿到 /64 前缀并给 Mac 分配地址。
2. **DDNS 更新 AAAA**：推荐 [ddns-go](https://github.com/jeessy2/ddns-go)（支持阿里云 / 腾讯云 /
   Cloudflare / 华为云 / DNSPod 等），或用路由器自带 DDNS。只更新 AAAA 记录。
3. **稳定 IPv6 地址**：macOS 的 IPv6 隐私临时地址会变，需关闭临时地址（见下），
   否则防火墙规则与 DDNS 会漂移。
4. **路由器 IPv6 防火墙放行**：入站 TCP 8443 → Mac 的 IPv6 地址（不是 IPv4 端口映射）。
   只放这一个端口，不要整机 IPv6 放行。
5. **证书**（二选一）：
   - 运营商未封 80/443：Caddy 自动 HTTPS（HTTP-01 / TLS-ALPN），最省事；
   - 80/443 被封（国内家宽常见）：用 **DNS-01** 签发，推荐 `acme.sh`（支持上面这些 DNS 服务商），
     证书装到 Caddy 的 `tls` 指令即可，端口用 8443。
6. **DNS 服务商的 API Token**（DNS-01 需要）：待定，见「未决问题」。

## 配置示例

### daemon（`.env`，保持回环 + 强制鉴权）

```dotenv
HOST=127.0.0.1
PORT=3080
REQUIRE_AUTH=1
WEB_API_TOKEN=<master token，≥32 字符>
# 每人一个 token（阶段二实现后启用；服务端由 token 反查 Profile，不再信 X-Hermes-Profile）
PROFILE_TOKENS_JSON='{"default":"<token-default>","bestie":"<token-bestie>"}'
# Host/Origin 守卫的放行名单：DDNS 域名 + 精确端口（Origin 校验要求端口精确）
WEB_ALLOWED_HOSTS=life.example.com:8443,life.example.com
```

### Caddy（`/opt/homebrew/etc/Caddyfile`，`brew install caddy`）

```caddyfile
life.example.com:8443 {
	# 证书由 acme.sh（DNS-01）签发后放这里；能走 80/443 时删掉 tls 两行即可自动签发
	tls /Users/cracked/.config/caddy/certs/life.example.com/fullchain.pem \
	    /Users/cracked/.config/caddy/certs/life.example.com/key.pem

	encode zstd gzip
	reverse_proxy 127.0.0.1:3080 {
		header_up X-Forwarded-Proto {scheme}
	}
	# 访问日志（排障 + 观察扫描/暴力尝试）
	log {
		output file /Users/cracked/Library/Logs/life-assistant/caddy.log
	}
}
```

### 证书（acme.sh + DNS-01，示例为阿里云）

```bash
brew install acme.sh
export Ali_Key="<AccessKey>"; export Ali_Secret="<Secret>"
acme.sh --issue --dns dns_ali -d life.example.com --server letsencrypt
acme.sh --install-cert -d life.example.com \
  --fullchain-file ~/.config/caddy/certs/life.example.com/fullchain.pem \
  --key-file       ~/.config/caddy/certs/life.example.com/key.pem \
  --reloadcmd      "caddy reload --config /opt/homebrew/etc/Caddyfile"
```

### macOS：固定 IPv6 地址 + 放行入站

```bash
# 关闭临时 IPv6 地址（重启后仍生效需写进 /etc/sysctl.conf）
sudo sysctl -w net.inet6.ip6.use_tempaddr=0
sudo sysctl -w net.inet6.ip6.temppltime=0
# 查看稳定地址，填进路由器防火墙规则
ifconfig en0 | grep inet6
```

## 验证（必须从手机蜂窝网络，关掉 Wi-Fi）

```bash
# 1. 基础可达 + 证书
curl -6 -sS https://life.example.com:8443/healthz
# 2. 鉴权与守卫
curl -sS -o /dev/null -w '%{http_code}\n' https://life.example.com:8443/api/status          # 401
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com' https://life.example.com:8443/api/status  # 403
# 3. 手机浏览器打开 /quick → 添加到主屏幕 → 记一笔
```

## 手机端（ColorOS / OPPO）

1. **`/quick` PWA（主路径）**：手机浏览器打开 `/quick?token=<profile token>` 一次（token 存
   localStorage、地址栏抹掉），「添加到主屏幕」。记账 = 金额 + 常用分类 chips；提醒 = 标题 +
   时间 chips。零安装、无后台被杀问题。
2. **HTTP Shortcuts（一键直达）**：安装 [Waboodoo/HTTP-Shortcuts](https://github.com/Waboodoo/HTTP-Shortcuts)，
   导入我们导出的 JSON（POST `/api/expenses`，Header `Authorization: Bearer <token>`，body 带
   `request_id`）。可做桌面小组件/快捷设置磁贴；固定动作（如「咖啡 ¥20」）一键完成。
3. **ColorOS 小布指令 / NFC（触发器，可选）**：小布指令动作适合「打开网页」，可指向
   `/quick?type=expense` 预填页；NFC 贴纸写同一个 URL，碰一下进入记账。

## 安全清单（暴露前必须全部完成）

- [ ] per-profile token：token → Profile，拒绝 `X-Hermes-Profile` 自报身份
- [ ] 写 API 限流：按 IP + token 的固定窗口，超限 429 + `Retry-After`；失败鉴权计数
- [ ] 仅 HTTPS：daemon 不监听公网；反代只放 8443（或 443）
- [ ] `WEB_ALLOWED_HOSTS` 精确到 `域名:端口`
- [ ] `REQUIRE_AUTH=1`，所有 token ≥32 字符；HTTP Shortcuts 用每人的 token
- [ ] 失败鉴权写 warn 日志；建议把「公网失败鉴权次数」纳入 `/metrics`
- [ ] 审计日志（阶段二 #8）建议与写 API 同批上线，至少记录账本/预算/删除类操作
- [ ] 回滚预案：删掉路由器 8443 放行规则即断开公网；daemon 不受影响

## 未决问题

1. **DNS 服务商**（决定 acme.sh 的 DNS-01 参数）：Cloudflare / 阿里云 / DNSPod / 华为云 / 其他？
2. **80/443 入站是否可用**（决定 Caddy 自动 HTTPS 还是必须 DNS-01 + 8443）。
3. 手机运营商是否真的下发 IPv6（部分 4G 套餐/物联网卡只有 IPv4）：出门实测
   `curl -6 https://ifconfig.co` 能返回地址即可。若某台手机只有 IPv4，需要备用通道
   （Cloudflare Tunnel / ZeroTier / 家里 Wi-Fi），届时再定。
