//! Runtime configuration, all from the environment so a container needs no
//! config file.

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Where to listen. `ADBSTUDIO_ADDR`, default `0.0.0.0:7070`.
    pub addr: SocketAddr,
    /// Directory holding the built frontend (`web/dist`). `ADBSTUDIO_STATIC`.
    /// When unset the server is API-only (useful in `npm run dev`).
    pub static_dir: Option<PathBuf>,
    /// The adb server to relay WebSocket traffic to. `ADBSTUDIO_ADB_SERVER`,
    /// default `127.0.0.1:5037`.
    pub adb_server: SocketAddr,
    /// PEM cert + key to serve HTTPS directly. `ADBSTUDIO_TLS_CERT` /
    /// `ADBSTUDIO_TLS_KEY`. Both must be set, or neither.
    ///
    /// Required when the page is hosted on another origin over HTTPS: browsers
    /// block an https:// page from calling an http:// backend (mixed content), and
    /// the page can't drop to http:// either because WebUSB needs a secure
    /// context. Unset when a tunnel or reverse proxy terminates TLS instead.
    pub tls: Option<(PathBuf, PathBuf)>,
    /// Accept requests that Cloudflare Access has authenticated, when the identity
    /// matches. `ADBSTUDIO_ACCESS_DOMAIN` (e.g. `deepmirror.com`) and
    /// `ADBSTUDIO_ACCESS_EMAILS` (comma-separated exact addresses).
    ///
    /// Access puts the verified address in `Cf-Access-Authenticated-User-Email`.
    /// Trusting that header is only sound because this server listens on loopback
    /// and cloudflared is the sole path in — anything able to reach the port
    /// directly could forge it, so never bind this to a public interface while
    /// relying on identity alone.
    ///
    /// Checking identity here as well as in the Access policy is deliberate: a
    /// policy attached to the wrong hostname, or widened by accident, would
    /// otherwise let any logged-in Cloudflare user through.
    pub access_domain: Option<String>,
    pub access_emails: Vec<String>,
    /// Directory of prebuilt bridge binaries to offer at `/download`.
    /// `ADBSTUDIO_BRIDGE_DIR`. Unset means the download links are hidden.
    pub bridge_dir: Option<PathBuf>,
    /// 允许跨源调用本 API 的前端 origin，逗号分隔。`ADBSTUDIO_ALLOWED_ORIGINS`
    /// （例如 `https://adb.kakacat.icu`）。
    ///
    /// 只有把前端和 API 拆到不同 hostname 时才需要（前端放 Cloudflare Pages、
    /// 本服务经 tunnel 出）。空表示同源部署：这时 CORS 保持宽松（历史行为，且
    /// 同源请求压根不触发 CORS）。
    ///
    /// 一旦设置，CORS 就变成「精确 origin + 允许携带凭据」—— 规范不允许
    /// `Allow-Origin: *` 和 `credentials: include` 并存，而跨源要带上
    /// Cloudflare Access 的 CF_Authorization cookie 就必须用后者。
    ///
    /// 这个列表同时用于校验 `/api/auth/login` 的返回地址：拆分之后登录发生在 API
    /// 这个 hostname 上，登录完要跳回前端那个 origin，而不受限的 `redirect_url`
    /// 就是一个挂着我们域名的开放重定向。
    pub allowed_origins: Vec<String>,
    /// Shared secret required on every `/api/*` request. `ADBSTUDIO_TOKEN`.
    ///
    /// Unset means no authentication, which is only safe when the server is
    /// bound to loopback. Set it whenever the server is reachable from anywhere
    /// else — this API can control an attached Android device, read and write the
    /// NAS over SFTP, and call the Dino admin gRPC.
    pub token: Option<String>,
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let addr = std::env::var("ADBSTUDIO_ADDR")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 7070)));

        let adb_server = std::env::var("ADBSTUDIO_ADB_SERVER")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 5037)));

        let access_domain = std::env::var("ADBSTUDIO_ACCESS_DOMAIN")
            .ok()
            .map(|s| s.trim().trim_start_matches('@').to_lowercase())
            .filter(|s| !s.is_empty());
        let access_emails = std::env::var("ADBSTUDIO_ACCESS_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();

        let allowed_origins = std::env::var("ADBSTUDIO_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
            .collect::<Vec<_>>();

        let token = std::env::var("ADBSTUDIO_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let tls = match (env_path("ADBSTUDIO_TLS_CERT"), env_path("ADBSTUDIO_TLS_KEY")) {
            (Some(cert), Some(key)) => Some((cert, key)),
            (None, None) => None,
            _ => {
                tracing::warn!(
                    "only one of ADBSTUDIO_TLS_CERT / ADBSTUDIO_TLS_KEY is set; serving plain HTTP"
                );
                None
            }
        };

        Config {
            addr,
            static_dir: env_path("ADBSTUDIO_STATIC").filter(|p| p.is_dir()),
            bridge_dir: env_path("ADBSTUDIO_BRIDGE_DIR"),
            adb_server,
            tls,
            access_domain,
            access_emails,
            allowed_origins,
            token,
        }
    }

    /// True when we're listening somewhere other than loopback, i.e. reachable
    /// from the network (or from a tunnel pointed at us).
    pub fn exposed(&self) -> bool {
        !self.addr.ip().is_loopback()
    }

    /// Whether Cloudflare Access identity is accepted as authentication.
    pub fn access_configured(&self) -> bool {
        self.access_domain.is_some() || !self.access_emails.is_empty()
    }

    /// Is some form of authentication in place?
    pub fn authenticated(&self) -> bool {
        self.token.is_some() || self.access_configured()
    }
}

