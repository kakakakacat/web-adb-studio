//! WebSocket ↔ TCP relay to a real adb server.
//!
//! This is what gives the web build back wireless devices. A browser can't open
//! a TCP socket, but Tango's `AdbServerClient` only needs a byte-duplex to talk
//! the adb *server* protocol — so we hand it a WebSocket and splice it onto
//! 127.0.0.1:5037 here. The adb server then does everything a browser can't:
//! `adb connect`, TLS pairing for Android 11+, and mDNS discovery.
//!
//! Scope note: the adb server runs next to *this process*, so it sees devices on
//! the server's network, not the user's home network. USB devices always go
//! through WebUSB in the page instead and never touch this relay.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<crate::AppState>,
) -> Response {
    let target = state.config.adb_server;
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = splice(socket, target).await {
            tracing::debug!("adb relay closed: {e}");
        }
    })
}

async fn splice(
    socket: WebSocket,
    target: std::net::SocketAddr,
) -> std::io::Result<()> {
    let tcp = TcpStream::connect(target).await?;
    // Nagle would add latency to the many small adb protocol exchanges.
    tcp.set_nodelay(true)?;
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_write, mut ws_read) = socket.split();

    // browser -> adb server
    let up = tokio::spawn(async move {
        while let Some(message) = ws_read.next().await {
            match message {
                Ok(Message::Binary(data)) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                // adb is a binary protocol; text/ping frames are not ours.
                Ok(_) => {}
            }
        }
        let _ = tcp_write.shutdown().await;
    });

    // adb server -> browser
    let down = tokio::spawn(async move {
        let mut buf = vec![0u8; 32 * 1024];
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

    let _ = tokio::try_join!(up, down);
    Ok(())
}
