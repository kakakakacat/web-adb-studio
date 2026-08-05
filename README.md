# web-adb-studio

浏览器里直接跑 ADB —— 不用安装 `adb`，不用装任何客户端。ADB 协议由页面自己实现
（基于 [Tango](https://github.com/yume-chan/ya-webadb)），通过 WebUSB 连上安卓设备。

**在线使用：https://adb.kakacat.icu**

需要支持 WebUSB 的浏览器（Chrome / Edge），且页面必须是 HTTPS 或 localhost。
Safari 和 Firefox 不支持 WebUSB。

> 项目起源于 [Zaphkiel-Ivanovna/adb-studio](https://github.com/Zaphkiel-Ivanovna/adb-studio)
> 的 fork（一个原生 macOS 应用）。浏览器版是重写的：ADB 协议改由页面实现，原生壳、
> 打包脚本和捆绑的二进制全部去掉。上游的版权声明保留在 [LICENSE](LICENSE) 中。

## 能做什么

- **设备信息** —— 型号、安卓版本、序列号、ABI、构建类型、bootloader 状态、root
- **应用管理** —— 已装应用列表（含真实启动器图标）、拖拽安装 APK、卸载
- **文件传输** —— 拖到页面上就推进设备
- **投屏** —— 基于 scrcpy，H.264/H.265 由 WebCodecs 硬解码，支持鼠标键盘触控、剪贴板
- **实时日志** —— logcat 按进程和级别过滤
- **性能采样** —— CPU / 内存 / 帧率
- **抓包** —— 实时查看应用的 HTTP / gRPC / WebSocket 流量

## 抓包

抓的是**应用层**：HTTPS 在加密前 / 解密后的明文，gRPC 的 method、metadata、
流式消息、status，protobuf 显示真实字段名。**不需要 MITM 代理、不需要安装证书、
不受 certificate pinning 影响。**

数据来自应用进程内的采集器，由构建期字节码插桩注入 —— 需要目标应用集成
[netcapture SDK](https://github.com/kakakakacat/android-netcapture)（加一行 Gradle
插件，业务代码零改动）。

设备侧只开一个 abstract LocalSocket，网页通过已有的 adb 连接直接读它 ——
不监听任何 TCP 端口，也不需要 `adb forward`（WebUSB 模式下电脑上根本没有 adb server）。

## 两条 ADB 通路

连上之后都是同一个 Tango `Adb` 对象，所以上层功能只写一份。

| 通路 | 走法 | 代价 |
| --- | --- | --- |
| **WebUSB** | 页面自己 claim USB 接口 | 零依赖，但和本机 `adb` 抢接口 —— 需要先 `adb kill-server` |
| **桥接** | 经 WebSocket 中继连到真的 adb server | 可与终端 / Android Studio **同时**用同一台设备 |

桥接是一个几百 KB 的纯 Rust 小程序（`bridge/`），把浏览器的 WebSocket 转发到
`127.0.0.1:5037`。浏览器打不开 TCP 连接，这就是它必须存在的原因。详见 [BRIDGE.md](BRIDGE.md)。

## 本地跑

```bash
cd web
npm install
npm run assets     # 拉 scrcpy-server（版本锁定，见 scripts/fetch-assets.sh）
npm run dev        # http://localhost:1421
```

只用 WebUSB 的话到这里就够了，不需要后端。想用桥接通路：

```bash
cd server && cargo run     # :7070，提供 /api/adb 中继与静态托管
```

## 部署

**Cloudflare Pages** —— 纯静态，全球边缘分发：

```bash
cd web
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ./scripts/deploy-pages.sh
```

**自托管** —— `server/` 那个 Rust 服务同时提供静态托管和 `/api/adb` 中继，
见 [server/DEPLOY.md](server/DEPLOY.md)（含 HTTPS / nginx / Docker）。

## 登录

`server/` 里保留了完整的身份认证：Cloudflare Access 身份
（`cf-access-authenticated-user-email` 头）或共享 token，以及 `require_privileged`
中间件。

本仓库自身**没有**需要身份的功能 —— ADB 那些操作驱动的是访客自己的设备，要求登录
毫无意义。留着这套机制是给下游用的：想加只有自己人能用的接口时，套一层
`require_privileged` 就行，`server/src/main.rs` 里有现成示例。

## 结构

```
web/          前端（React + Tango）。ADB 协议、抓包面板、投屏解码都在这里
server/       Rust（axum）：WebSocket↔TCP 中继、静态托管、身份认证
bridge/       独立的小中继，发给用户在自己机器上跑
icon-helper/  安卓辅助应用，用于读取完全解析后的启动器图标（含自适应图标）
```

## 验证脚本

`web/scripts/` 下有一批真机验证脚本（无头 Chrome + 真实设备），改完对应功能建议跑一下：

```bash
npm run verify:ui          # 主要 UI 流程
npm run verify:net         # 抓包面板（需要设备上跑着集成了 SDK 的 debug 包）
npm run verify:static      # 线上部署自检
npm run verify:bridge      # adb 协议层
```

## License

MIT，见 [LICENSE](LICENSE)。
