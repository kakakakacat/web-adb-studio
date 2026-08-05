//! ADB Studio 本机桥接 — a WebSocket↔TCP relay to the local adb server.
//!
//! Why this exists: a phone's USB debugging interface can only be claimed by one
//! process. An adb server claims it, and Android Studio always starts one, so the
//! browser's WebUSB gets "device busy". There is no sharing to be had at the USB
//! layer.
//!
//! The adb server, though, was built to serve many clients at once. So instead of
//! competing with it, the page talks to it: a browser can't open a TCP socket, but
//! Tango's `AdbServerClient` only needs a byte duplex, and a WebSocket relayed
//! onto 127.0.0.1:5037 is exactly that. The browser becomes one more adb client
//! and nothing has to be killed.
//!
//! Run it, leave it running, and use the web app normally.

use std::net::SocketAddr;
use std::process::Command;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower_http::cors::CorsLayer;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 7070;
const DEFAULT_ADB: &str = "127.0.0.1:5037";

#[derive(Clone)]
struct Config {
    adb_server: SocketAddr,
}

/// Splice one WebSocket onto one TCP connection to the adb server.
///
/// One connection per socket, not a pool: the adb server protocol opens a fresh
/// connection per request and some of them (`host:track-devices`, `shell:`) then
/// stay open for the lifetime of the operation.
async fn splice(socket: WebSocket, target: SocketAddr) -> std::io::Result<()> {
    let tcp = TcpStream::connect(target).await?;
    // Nagle would add latency to the many small adb protocol exchanges.
    tcp.set_nodelay(true)?;
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_write, mut ws_read) = socket.split();

    let up = tokio::spawn(async move {
        while let Some(message) = ws_read.next().await {
            match message {
                Ok(Message::Binary(data)) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                // adb is a binary protocol; text and ping frames are not ours.
                Ok(_) => {}
            }
        }
        let _ = tcp_write.shutdown().await;
    });

    let down = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_write
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = ws_write.close().await;
    });

    let _ = tokio::join!(up, down);
    Ok(())
}

async fn adb_handler(ws: WebSocketUpgrade, State(cfg): State<Config>) -> Response {
    ws.on_upgrade(move |socket| async move {
        let _ = splice(socket, cfg.adb_server).await;
    })
}

/// Minimal health, in the same shape the full backend uses, so the web app can
/// probe this the same way. `privileged` is false on purpose: a relay running on
/// someone's laptop has no business unlocking the company-internal features.
async fn health(State(cfg): State<Config>) -> impl IntoResponse {
    let up = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        TcpStream::connect(cfg.adb_server),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    axum::Json(serde_json::json!({
        "ok": true,
        "version": VERSION,
        "bridge": true,
        "adbServer": cfg.adb_server.to_string(),
        "features": {
            "remoteFiles": false,
            "dino": false,
            "adbServer": up,
            "accessIdentity": false,
        },
        "privileged": false,
        "user": null,
    }))
}

/// Something to look at if someone opens the port in a browser, since they will.
async fn index(State(cfg): State<Config>) -> Html<String> {
    Html(format!(
        r#"<!doctype html><meta charset="utf-8">
<title>ADB Studio 桥接</title>
<style>body{{font:15px/1.7 -apple-system,Segoe UI,system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}}
code{{background:#f1f1f1;padding:.15em .4em;border-radius:4px}}h1{{font-size:1.3rem}}</style>
<h1>ADB Studio 桥接正在运行</h1>
<p>这个窗口不用管，保持开着就行。关掉它桥接就停了。</p>
<p>中转目标：<code>{}</code> · 版本 {}</p>
<p>回到 ADB Studio 网页，点右上角齿轮 → <b>用本机桥接</b>。</p>"#,
        cfg.adb_server, VERSION
    ))
}

/// Start the adb server if we can, because a bridge to nothing is useless and
/// `adb start-server` is exactly what the user would type next. Missing adb is
/// not fatal: someone may be running their own on another port.
fn nudge_adb_server() -> Option<String> {
    let out = Command::new("adb").arg("start-server").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let devices = Command::new("adb").arg("devices").output().ok()?;
    Some(String::from_utf8_lossy(&devices.stdout).into_owned())
}

fn parse_args() -> (u16, SocketAddr) {
    let mut port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut adb = std::env::var("ADB_SERVER").unwrap_or_else(|_| DEFAULT_ADB.into());

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" if i + 1 < args.len() => {
                if let Ok(p) = args[i + 1].parse() {
                    port = p;
                }
                i += 2;
            }
            "--adb" if i + 1 < args.len() => {
                adb = args[i + 1].clone();
                i += 2;
            }
            "--help" | "-h" => {
                println!(
                    "ADB Studio 桥接 {VERSION}\n\n\
                     用法: adbstudio-bridge [--port {DEFAULT_PORT}] [--adb {DEFAULT_ADB}]\n\n\
                     让浏览器通过本机的 adb server 使用设备，\n\
                     这样网页、终端 adb、Android Studio 可以同时用同一台手机。"
                );
                std::process::exit(0);
            }
            _ => i += 1,
        }
    }

    let adb_server = adb
        .parse()
        .unwrap_or_else(|_| DEFAULT_ADB.parse().expect("default is valid"));
    (port, adb_server)
}

/// Keep the window open after a fatal error.
///
/// This is launched by double-clicking. On Windows that means the console window
/// closes the instant the process exits, so an error message would flash past
/// unread and the whole thing would look like "nothing happened".
fn die(message: &str) -> ! {
    eprintln!("\n错误：{message}\n");
    eprintln!("按回车键关闭…");
    let mut discard = String::new();
    let _ = std::io::stdin().read_line(&mut discard);
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let (port, adb_server) = parse_args();

    println!("ADB Studio 桥接 {VERSION}");
    println!();

    // Bind before touching adb. `adb start-server` can take seconds — it may have
    // to launch the daemon and scan USB — and doing it first means the port isn't
    // listening yet while the user is already clicking "用本机桥接". If adb ever
    // hangs, this ordering is the difference between a working relay that reports
    // no devices and a bridge that never starts at all.
    //
    // Loopback only. This relay has no authentication — it does not need any
    // while only this machine can reach it — so it must never be given an address
    // the network can route to.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => die(&format!(
            "端口 {port} 已被占用。\n\
             可能桥接已经在跑了（那就不用再开一个），\n\
             或者换个端口：adbstudio-bridge --port {}",
            port + 1
        )),
        Err(e) => die(&format!("无法监听 127.0.0.1:{port}：{e}")),
    };

    // Now that the port is open, get adb going and report what it sees.
    tokio::task::spawn_blocking(move || match nudge_adb_server() {
        Some(devices) => {
            let lines: Vec<&str> = devices
                .lines()
                .skip(1)
                .filter(|l| !l.trim().is_empty())
                .collect();
            if lines.is_empty() {
                println!("adb server 已启动，但没有检测到设备。");
                println!("插上手机、打开 USB 调试，然后在手机上允许本机调试。");
            } else {
                println!("adb server 已启动，检测到设备：");
                for l in lines {
                    println!("    {l}");
                }
            }
        }
        None => {
            println!("找不到 adb 命令（没装 Android SDK？）。");
            println!("桥接照样在跑，但需要有一个 adb server 在 {adb_server} 上运行。");
        }
    });

    let cfg = Config { adb_server };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route("/api/adb", any(adb_handler))
        // The page lives on another origin (https://adb.kakacat.icu), so its
        // preflight has to be answered. WebSocket upgrades aren't subject to CORS
        // themselves, but the health probe next to them is.
        .layer(CorsLayer::permissive())
        .with_state(cfg);

    println!("桥接已启动：ws://127.0.0.1:{port}/api/adb");
    println!();
    println!("现在回到 ADB Studio 网页，点右上角齿轮 → “用本机桥接”。");
    println!("浏览器第一次会询问“访问本地网络”，点允许。");
    println!();
    println!("这个窗口保持开着。要停止按 Ctrl-C。");

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        println!("\n桥接已停止。");
    };

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        die(&format!("桥接异常退出：{e}"));
    }
}
