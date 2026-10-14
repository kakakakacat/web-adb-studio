# web-adb-studio

浏览器里直接跑 ADB —— 不用安装 `adb`，不用装任何客户端。ADB 协议由页面自己实现
（基于 [Tango](https://github.com/yume-chan/ya-webadb)），通过 WebUSB 连上安卓设备。

**在线使用：https://adb.kakacat.net**

需要支持 WebUSB 的浏览器（Chrome / Edge），且页面必须是 HTTPS 或 localhost。
Safari 和 Firefox 不支持 WebUSB。

## 能做什么

- **设备信息** —— 型号、安卓版本、序列号、ABI、构建类型、bootloader 状态、root
- **应用管理** —— 已装应用列表（含真实启动器图标）、拖拽安装 APK、卸载
- **文件传输** —— 拖到页面上就推进设备
- **投屏** —— 基于 scrcpy，H.264/H.265 由 WebCodecs 硬解码，支持鼠标键盘触控、剪贴板
- **实时日志** —— logcat 按进程和级别过滤
- **性能采样** —— CPU / 内存 / 帧率
- **抓包** —— 实时查看应用的 HTTP / gRPC / WebSocket 流量
- **转码** —— 图片序列 → 动图 WebP / MP4，不用装 ffmpeg，也不需要连设备

## 转码（图片序列 → 动图 / 视频）

选一个图片文件夹（png / jpg），按帧率、尺寸、编码参数导出**动图 WebP** 或 **MP4**，
参数在页面上直接调。**全部在浏览器里跑：图片不上传，后端不参与，也不需要装 ffmpeg
或 libwebp。** 这一页不需要连设备，没插手机也能用。

- **WebP** —— 编码器就是 libwebp 本身（wasm 构建），暴露的就是 `img2webp` / `cwebp`
  的那几个参数：`-lossless`、`-q`、`-m`、`-near_lossless`、`-exact`、循环次数。
  容器（VP8X / ANIM / ANMF）由页面自己拼。默认开**跨帧差分**：只编码相对上一帧变化的
  那块矩形，和前一帧完全相同的帧直接并进它的时长 —— 背景静止的动画能小一个数量级，
  实测比 `img2webp -lossless -m 4` 还略小一点。
- **MP4** —— 用 WebCodecs 硬件编码（H.264，机器支持就给 HEVC / VP9 / AV1，
  列表是 `isConfigSupported` 探出来的）。没有 CRF 这个旋钮，质量按目标码率给。
- 缩放对应 `png2mp4.sh` 的 `force_original_aspect_ratio=decrease` + `pad`，
  另有填充裁切和拉伸；帧序按文件名自然序，不必像 shell 那样补零。
- 产物可以直接在页面里预览（棋盘格看透明、1:1 看像素），或点「在浏览器中打开」
  用浏览器自己解一遍。

默认是**有损 q75 + 透明留边**（几百帧的动画无损要大好几倍，而这些东西最后是要进设备的；
留边默认透明是因为烘进去的黑边找不回来 —— MP4 没有 alpha，会退回黑色，面板里会提示）。
其余参数跟着 `scripts/img2webp.sh` / `png2mp4.sh` 走：`-m 4`、20fps。验证：
`npm run test:convert`（拿 `webpinfo` + libwebp 解码器逐像素回读，并和 `img2webp`
比体积）、`npm run verify:convert`（真 Chrome 端到端跑一遍两条编码路径）。

## 抓包

抓的是**应用层**：HTTPS 在加密前 / 解密后的明文，gRPC 的 method、metadata、
流式消息、status，protobuf 显示真实字段名。**不需要 MITM 代理、不需要安装证书、
不受 certificate pinning 影响。**

数据来自应用进程内的采集器，由构建期字节码插桩注入 —— 需要目标应用集成
[netcapture SDK](https://github.com/kakakakacat/android-netcapture)（加一行 Gradle
插件，业务代码零改动）。

设备侧只开一个 abstract LocalSocket，网页通过已有的 adb 连接直接读它 ——
不监听任何 TCP 端口，也不需要 `adb forward`（WebUSB 模式下电脑上根本没有 adb server）。

## 连不上时的诊断日志

页面在本机记录连接过程 —— 试了哪条通路、`claim` 报了什么错、桥接探测的结果、浏览器
有哪些能力、USB 设备处于什么状态。**这些记录不会自动外发**：只有点了「上传诊断日志」
（占用页里，或齿轮面板底部）才会传一份到 Cloudflare，然后页面给出一个短编号，
把编号发给维护者就行 —— 不用导文件、不用截图。

不含文件内容、屏幕内容和任何令牌；含设备序列号（那是把报告和某台手机对上的唯一键）。

维护者侧：

```bash
export DIAG_TOKEN=…            # 或写进 ~/.adbstudio-diag-token
./scripts/diag.sh list         # 最近 30 条：时间 / 编号 / 摘要 / 平台 / 备注
./scripts/diag.sh get <id>     # 某一条的正文
./scripts/diag.sh serial <序列号>
./scripts/diag.sh stats        # 用量与配额
```

存在 D1（`functions/diag/[[path]].ts` + `functions/diag-schema.sql`）。上传端点公开
可写 —— 它必须能在出问题的那台机器上点得下去，而那台机器不一定有本站任何凭据 ——
所以三道闸都在服务端：单条体积上限、按来源（IP 的加盐哈希）限流、总量 200MB 配额，
写满就按时间删最旧的。查看必须带 token。

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
