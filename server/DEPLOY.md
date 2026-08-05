# 部署

两种形态，同一个二进制：

| 形态 | 谁在跑 | 作用 |
| --- | --- | --- |
| **自托管服务器** | 部署一次 | 托管网页 + `/api/adb` 中继（服务器网络里的设备） |
| **本机桥接** | 用户自己在电脑上跑 | 让 USB 设备走本机 adb server，与终端 / Android Studio 共存，不用 `adb kill-server` |

## 1. 自托管服务器

### 必须用 HTTPS

WebUSB 只在 **secure context** 下存在 —— 用 `http://<ip>` 访问的话，`navigator.usb`
根本不存在，页面会直接提示环境不满足。所以域名必须配证书（自签也行，只要浏览器信任）。唯一的例外是 `http://localhost`，仅对本机桥接场景有用。

推荐在前面挂一层 nginx 终止 TLS：

```nginx
server {
    listen 443 ssl;
    server_name adbstudio.example.com;

    ssl_certificate     /etc/ssl/certs/adbstudio.crt;
    ssl_certificate_key /etc/ssl/private/adbstudio.key;

    location / {
        proxy_pass http://127.0.0.1:7070;
        proxy_http_version 1.1;

        # /api/adb 是 WebSocket（adb 中继），这三行必须有
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;

        # 大文件从 NAS 流式下载，别让代理缓冲整个响应
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

### Docker

镜像不包含私钥，运行时挂载：

```bash
cd /path/to/adb-studio
(cd web && npm run assets)          # 拉 scrcpy-server + icon-helper.apk
docker build -f server/Dockerfile -t adbstudio-web .

docker run -d --name adbstudio \
  -p 7070:7070 \
  -v /etc/adbstudio/id_rsa:/run/secrets/id_rsa:ro \
  adbstudio-web
```

私钥权限：容器内以 root 运行，`:ro` 挂载即可；宿主上保持 `chmod 600`。

**关于无线设备**：容器里的 adb server 看到的是**容器的网络**。想让它发现办公网里的
设备，需要 `--network host`（Linux 宿主）；否则只能用 `adb connect <ip>:5555` 显式连接，
且要求容器网络能路由到设备。mDNS 扫描在 bridge 网络下基本无效。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADBSTUDIO_ADDR` | `0.0.0.0:7070` | 监听地址 |
| `ADBSTUDIO_STATIC` | 未设置 | 前端 `dist` 目录；不设则只提供 API |
| `ADBSTUDIO_ADB_SERVER` | `127.0.0.1:5037` | ws 中继要连的 adb server |
| `ADBSTUDIO_TOKEN` | 未设置 | `/api/*` 的共享密钥；服务暴露到公网时**必须**设置 |
| `ADBSTUDIO_ACCESS_DOMAIN` | 未设置 | 接受 Cloudflare Access 身份的邮箱域名 |
| `ADBSTUDIO_ALLOWED_ORIGINS` | 未设置 | 允许跨源携带凭据调用本 API 的前端 origin（前后端不同源时用） |
| `RUST_LOG` | `info,tower_http=warn` | 日志级别 |

## 2. 本机桥接（推荐给 Windows 用户）

Windows 上 WebUSB 要求设备的 ADB 接口绑定 WinUSB 驱动，而 Google USB Driver 装的
不一定是 —— 桥接模式绕过整个问题，因为占用 USB 的是本机 adb server。

给用户分发一个**无 GUI 的单文件二进制**（不需要签名/公证/安装包）：

```bash
cargo build --release          # server/target/release/adbstudio-web-server
```

用户侧：

```bash
adb start-server
adbstudio-web-server           # 监听 :7070，只提供 API
```

然后在网页里打开「连接方式 / 环境自检」，点「填入本机地址」→「保存并重连」，
即把中继指向 `ws://127.0.0.1:7070/api/adb`。

从 HTTPS 页面连 `ws://127.0.0.1` 是允许的：loopback 属于 potentially-trustworthy
origin，不受混合内容限制。


## 安全说明

- **`/api/adb` 是一个 WebSocket↔TCP 中继，通向本服务所在机器的 adb server。**
  它默认是公开的（页面驱动的是访客自己的设备，要求登录毫无意义），但那台机器上
  一旦有 adb server 且连着设备，任何人都能通过它枚举并控制那些设备。所以：
  要么保证这台机器上没有 adb server，要么给这个路由加上身份认证。
- 服务绑定到非 loopback 地址时（`config.exposed()`），`/api/*` 全部要求
  `ADBSTUDIO_TOKEN`。绑 loopback + 前面挂反代（或 cloudflared tunnel）时才会放开
  公开的那一半。
- 想加只有自己人能用的接口，用 `auth::require_privileged` 包一层，
  `src/main.rs` 里有示例；身份来自 Cloudflare Access 注入的
  `cf-access-authenticated-user-email` 头 —— **仅当本服务只能经由该代理访问时**
  这个头才可信，直连得到端口的人可以伪造它。
