# 本机 adb 桥接

让网页版和 Android Studio **同时**使用一台设备。

## 给用户：下载运行就行

在网页里点右上角齿轮，「方式二」下面有对应系统的下载按钮。或者直接：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple 芯片） | `https://adb.kakacat.icu/download/adbstudio-bridge-macos-arm64` |
| Windows 10+ | `https://adb.kakacat.icu/download/adbstudio-bridge-windows-x64.exe` |
| Linux x64（Ubuntu 18.04+） | `https://adb.kakacat.icu/download/adbstudio-bridge-linux-x64` |

运行后保持窗口开着，回网页点齿轮 →「用本机桥接」。浏览器会问一次「访问本地网络」，点允许。

- **macOS / Linux**：下载后要 `chmod +x`。macOS 还会因为未签名拦截，右键点「打开」，
  或 `xattr -d com.apple.quarantine <文件>`。
- **Windows**：双击即可，SmartScreen 可能提示「更多信息 → 仍要运行」。

## 为什么需要它

USB 调试接口是**独占**的。adb server 拿着它，浏览器的 WebUSB 就拿不到 —— 而 Android
Studio 一启动就拉起一个 adb server。这一层没有共享可言。

但 adb server 本身是为多客户端设计的。所以桥接不去和它抢，而是转发给它：浏览器开
WebSocket 到桥接，桥接把字节转发到 `127.0.0.1:5037`，浏览器就成了又一个 adb 客户端。
谁都不用被杀掉。

浏览器打不开 TCP 连接，这就是为什么必须有这么个小程序，没法「打开网页就能用」。

## 三种情况怎么选

| 那台机器的状态 | 怎么办 | 要装东西吗 |
| --- | --- | --- |
| 没有 adb / 没装 Android Studio | 直接 WebUSB，网页里点「连接 USB 设备」 | 不用 |
| 有 Android Studio，但不用它调这台设备 | `adb kill-server` 后在网页里连上，之后 adb 再起来也抢不走 | 不用 |
| 要和 Android Studio 同时用 | 跑这个桥接 | 一个 674KB 的文件 |

## 给维护者：怎么出包

三个平台在 GitHub Actions 的原生 runner 上编译（这台开发机没有 mingw / musl / Docker）：

```bash
gh workflow run bridge.yml --repo kakakakacat/web-adb-studio
gh run download <run-id> --repo kakakakacat/web-adb-studio --dir /tmp/art
mkdir -p server/bridge-dist && find /tmp/art -type f -exec cp {} server/bridge-dist/ \;
./scripts/deploy-nas.sh          # 会一并上传，并逐个校验 /download/<file> 返回 200
```

打 `bridge-v*` 的 tag 会额外发一个 GitHub Release。

**Linux 用 musl 静态链接**，不是 glibc。因为要支持 Ubuntu 18.04（glibc 2.27），比任何
现役 runner 都老，动态链接的产物在那上面会因为 glibc 版本不够直接拒绝启动。能这么做的
前提是桥接是纯 Rust —— 主服务带着 gRPC 和 SSH，做不到。

**桥接故意独立成一个 crate**，不是主服务加个开关：这个二进制是要发给用户的，而主服务
带着 SSH 客户端、gRPC 和 TLS，没一样是中转需要的，也没一样该出现在别人的笔记本上。
而且它们每一个都拖着 C 依赖（构建期 protoc、链接期 ring），三平台编译会变成噩梦。
