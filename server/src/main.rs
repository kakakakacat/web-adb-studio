//! ADB Studio web backend. See Cargo.toml for what this process is and isn't
//! responsible for.

mod auth;
mod config;
mod error;
mod relay;

use std::sync::Arc;

use axum::extract::State;
use axum::response::{Html, IntoResponse};
use axum::routing::{any, get};
use axum::{Json, Router};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

/// index.html, with the access token injected only when that is safe.
///
/// The token implies privilege — it is the credential held by whoever runs the
/// server — so handing it to every visitor would hand them Server Files and Dino
/// Admin. That was fine while Cloudflare Access gated the whole hostname and
/// every visitor was already an allow-listed colleague. It is not fine now that
/// the page is meant to be openable by anyone, with only the internal features
/// behind a sign-in, so injection is switched off whenever identity is
/// configured. Callers that legitimately hold the token still send it as a
/// bearer header.
///
/// Injected at serve time rather than baked into the build: `web/dist` is copied
/// to public static hosts, and a token compiled into those files would leak with
/// them.
fn index_with_token(dir: &std::path::Path, token: Option<&str>) -> Option<String> {
    let html = std::fs::read_to_string(dir.join("index.html")).ok()?;
    let Some(token) = token else { return Some(html) };
    // JSON-encode so a token containing quotes or backslashes can't break out of
    // the string literal.
    let literal = serde_json::to_string(token).ok()?;
    Some(html.replacen(
        "<head>",
        &format!("<head><script>window.__ADBSTUDIO_TOKEN__={literal};</script>"),
        1,
    ))
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
}

async fn health(
    State(state): State<AppState>,
    req: axum::extract::Request,
) -> Json<serde_json::Value> {
    let headers = req.headers().clone();
    // Probe the adb server rather than claiming it works. This deployment serves
    // the page from a NAS that has no adb installed and no devices plugged into
    // it, so the relay can never succeed — and reporting it as available made the
    // UI show "cannot reach adb server" as a red failure on every machine that
    // wasn't running its own bridge. That reads as "the site is broken" when the
    // honest message is "this deployment is WebUSB-only".
    //
    // A connect to loopback either succeeds or is refused immediately; the timeout
    // only matters for a remote ADBSTUDIO_ADB_SERVER.
    let adb_server_up = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        tokio::net::TcpStream::connect(state.config.adb_server),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    Json(serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "features": {
            // 内网功能在私有的下游仓库里，本仓库始终报 false。前端据此隐藏对应入口。
            "remoteFiles": false,
            "dino": false,
            "adbServer": adb_server_up,
            // Whether an Access policy is expected at all. Without this the UI
            // cannot tell "not signed in" from "this deployment has no sign-in",
            // and showed a missing identity as a fault on every local run.
            "accessIdentity": state.config.access_configured(),
        },
        // Whether this caller may use Server Files and Dino Admin. The UI hides
        // those entry points otherwise — the server still refuses them, so this
        // is tidiness, not the enforcement.
        "privileged": auth::is_privileged(&state.config, &req),
        "adbServer": state.config.adb_server.to_string(),
        // Who Cloudflare Access says this is, when it's in front of us. Lets the UI
        // show the signed-in identity instead of leaving people guessing.
        "user": headers
            .get("cf-access-authenticated-user-email")
            .and_then(|v| v.to_str().ok()),
    }))
}

/// Who Access says this is — asked on a path Access actually covers.
///
/// `/api/health` is public now, and Cloudflare only injects the identity header
/// on requests it authenticates, so health can never report a signed-in user on
/// this deployment. The UI would keep offering "登录解锁" to someone already
/// logged in. This route lives under `/api/auth`, which is inside the Access
/// application, so a request that arrives here at all carries an identity.
///
/// Anonymous visitors get a 302 to the login portal instead of this handler;
/// the page treats a failed fetch as "not signed in".
async fn whoami(State(state): State<AppState>, req: axum::extract::Request) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "user": auth::access_email(&req),
        "privileged": auth::is_privileged(&state.config, &req),
    }))
}

/// Sign-in landing spot: authenticate, then send the browser back where it came
/// from.
///
/// The sign-in button used to navigate to a protected path directly —
/// so it did trigger the login, but anyone already signed in just got a face full
/// of JSON with no way back. A route whose entire job is to redirect keeps the
/// "already signed in" click harmless and gives the post-login hop somewhere
/// sensible to land.
///
/// Only relative paths are honoured. Redirecting to an arbitrary `?redirect_url=`
/// would make this an open redirect wearing our hostname — worth nothing to us
/// and quite a lot to a phisher.
async fn login(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let requested = q.get("redirect_url").map(String::as_str).unwrap_or("/");
    let target = if requested.starts_with('/') && !requested.starts_with("//") {
        // 同源部署：相对路径，原样使用。
        requested.to_string()
    } else if state
        .config
        .allowed_origins
        .iter()
        .any(|o| requested == o || requested.starts_with(&format!("{o}/")))
    {
        // 拆分部署：登录发生在这个 hostname 上，登录完要跳回前端那个 origin。
        // 只接受配置里明确列出的 origin —— 不受限的绝对 URL 就是一个挂着我们
        // 域名的开放重定向，对我们毫无用处，对钓鱼的人很有用。
        requested.to_string()
    } else {
        "/".to_string()
    };
    axum::response::Redirect::to(&target).into_response()
}

/// CORS 策略。
///
/// 没配 allowed origins 时保持宽松（同源部署根本不触发 CORS，这条只对"自己另起一个
/// 前端指到这个服务"的调试场景有意义）。配了就收紧成精确 origin + 允许凭据 ——
/// 跨源要带 Access 的 cookie，就必须是精确 origin，`*` 在规范上和凭据互斥。
fn cors_layer(origins: &[String]) -> CorsLayer {
    if origins.is_empty() {
        return CorsLayer::permissive();
    }
    let parsed: Vec<axum::http::HeaderValue> = origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    // 方法和头都必须显式列出：tower-http 在 `allow_credentials(true)` 配上
    // `Any` 时会直接 panic（"Cannot combine Access-Control-Allow-Credentials: true
    // with Access-Control-Allow-Methods: *"），而且是在**第一个请求到来时**才炸 ——
    // 进程能正常启动、日志一切正常，然后第一个访客把它打死。实测踩过。
    use axum::http::{header, Method};
    CorsLayer::new()
        .allow_origin(parsed)
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let config = config::Config::from_env();
    // 借出来给最外层的 CorsLayer 用（config 之后会被 move 进 AppState）。
    let cors_origins = config.allowed_origins.clone();
    if !cors_origins.is_empty() {
        tracing::info!("CORS: 仅允许 {} 跨源携带凭据访问", cors_origins.join(", "));
    }
    tracing::info!("listening on {}", config.addr);
    tracing::info!("adb server relay target: {}", config.adb_server);

    // This API can drive an attached device and read/write the NAS. Bound to
    // anything but loopback with no authentication at all, that is open to whoever
    // can reach the port — refuse rather than quietly expose it.
    if config.access_configured() {
        tracing::info!(
            "Cloudflare Access identity required: domain={} extra={:?}",
            config.access_domain.as_deref().unwrap_or("(none)"),
            config.access_emails
        );
    }
    if config.token.is_some() {
        tracing::info!("access token accepted for /api/*");
    }
    match (config.authenticated(), config.exposed()) {
        (true, _) => {}
        (false, false) => tracing::info!(
            "no authentication configured; loopback-only bind, so /api/* is open"
        ),
        (false, true) => {
            tracing::error!(
                "refusing to start: listening on {} (not loopback) with no authentication.\n\
                 This API controls an attached Android device and can read/write the NAS.\n\
                 Set ADBSTUDIO_ACCESS_DOMAIN (behind Cloudflare Access) or ADBSTUDIO_TOKEN,\n\
                 or bind to 127.0.0.1 and put a tunnel in front.",
                config.addr
            );
            std::process::exit(2);
        }
    }

    let state = AppState {
        config: Arc::new(config.clone()),
    };

    // Two tiers of route, not two tiers of user.
    //
    // The ADB features need nobody's permission: the page drives a phone plugged
    // into the visitor's own machine, over their own USB port, and asking them to
    // sign in to do that buys nothing. Anything that reaches into a private network
    // is a different matter, and those routes carry the identity check.
    //
    // 这个仓库里没有第二类路由 —— 依赖内网的功能在私有的下游仓库里。身份认证本身
    // （auth.rs、/api/auth/*、require_privileged）保留着，是给自托管者的现成把门方式：
    //
    //     let internal = Router::new()
    //         .nest("/your-feature", your_feature::routes())
    //         .layer(axum::middleware::from_fn_with_state(
    //             state.clone(), auth::require_privileged));
    //
    // 然后 .merge(internal) 进下面的 api。这样公开的那半是真的未认证，而不是
    // 「认证了但开了例外」。

    let mut api = Router::new()
        .route("/health", get(health))
        // Unauthenticated here, authenticated in practice: `/api/auth` is one of
        // the paths the Cloudflare Access application covers, so these two only
        // ever run for a request Access has already vouched for. Nothing here
        // reveals anything a caller doesn't already own.
        .route("/auth/whoami", get(whoami))
        .route("/auth/login", get(login))
        // `any` because the upgrade arrives as GET but we don't want method
        // rejection to shadow the websocket handshake error.
        .route("/adb", any(relay::handler));

    // The public half is open when something else stands in front — on the NAS
    // that is a loopback bind plus a tunnel, which is the whole point: a visitor
    // gets the ADB features without signing in.
    //
    // A backend bound to a routable address has nothing in front of it, so there
    // the token is still required for everything. Without this, moving to
    // per-feature auth would have quietly opened the relay on split deployments.
    if config.exposed() {
        tracing::info!("bound to a routable address — token required for all of /api");
        api = api.layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));
    } else {
        tracing::info!("/api/health and /api/adb are open; internal features need identity");
    }

    let mut app: Router<AppState> = Router::new().nest("/api", api);

    if let Some(dir) = &config.static_dir {
        // Serve index.html ourselves so the token can be injected; everything else
        // is plain static hosting. No SPA fallback on purpose — the app keeps all
        // its state in memory and has no client-side routes, so an unknown path is
        // a genuine 404 and should say so.
        // Read on every request rather than caching at startup. Caching meant a
        // rebuilt frontend served an index.html pointing at hashed asset names that
        // no longer existed (vite clears the output dir), i.e. a blank page until
        // someone remembered to restart the backend. A few-KB read per page load is
        // nothing next to the request itself.
        // See index_with_token: injecting is only safe when nobody but the
        // operator can load the page.
        let inject = if config.access_configured() {
            tracing::info!(
                "identity configured — NOT injecting the token into index.html \
                 (it would grant every visitor the internal features)"
            );
            None
        } else {
            config.token.clone()
        };
        if index_with_token(dir, inject.as_deref()).is_none() {
            tracing::warn!("cannot read index.html in {}", dir.display());
        } else if inject.is_some() {
            tracing::info!("token injected into index.html (page load = authenticated)");
        }
        let index_page = {
            let dir = dir.clone();
            let token = inject.clone();
            move || {
                let dir = dir.clone();
                let token = token.clone();
                async move {
                    match index_with_token(&dir, token.as_deref()) {
                        // Never cache the page itself. It names hashed asset files
                        // that a rebuild deletes, so a browser holding an old copy
                        // asks for scripts that no longer exist and renders blank.
                        // The assets it points at are content-hashed, so they stay
                        // cacheable — this costs one small request per page load.
                        Some(html) => (
                            [(axum::http::header::CACHE_CONTROL, "no-store")],
                            Html(html),
                        )
                            .into_response(),
                        None => (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            "index.html not readable",
                        )
                            .into_response(),
                    }
                }
            }
        };
        app = app
            .route("/", get(index_page.clone()))
            .route("/index.html", get(index_page));
        app = app.fallback_service(ServeDir::new(dir));
        tracing::info!("serving frontend from {}", dir.display());
    }

    // The standalone bridge binaries, offered in-page so nobody has to find a
    // release on a private repo they may not have access to. Outside /api on
    // purpose: the browser navigates to these itself, and a navigation can't
    // carry an Authorization header. Cloudflare Access still gates the hostname,
    // so this is not an open download.
    if let Some(dir) = &config.bridge_dir {
        if dir.is_dir() {
            app = app.nest_service("/download", ServeDir::new(dir));
            tracing::info!("serving bridge downloads from {}", dir.display());
        } else {
            tracing::warn!(
                "ADBSTUDIO_BRIDGE_DIR set to {} but that is not a directory — downloads disabled",
                dir.display()
            );
        }
    } else {
        tracing::info!("ADBSTUDIO_STATIC unset — API only (use `npm run dev` for the UI)");
    }

    let app = app
        // Dev runs the Vite server on another port and proxies /api here; that
        // proxy makes the request same-origin, so CORS is only a convenience for
        // anyone pointing a separately-hosted frontend at this server.
        //
        // 配了 ADBSTUDIO_ALLOWED_ORIGINS 时换成精确 origin + 允许凭据：前端在
        // Cloudflare Pages、API 经 tunnel 出的拆分部署下，跨源请求必须带上
        // Access 的 CF_Authorization cookie，而规范禁止 `Allow-Origin: *` 与
        // credentials 并存。permissive 发的正是 `*`。
        .layer(cors_layer(&cors_origins))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    match &config.tls {
        Some((cert, key)) => {
            tracing::info!("TLS enabled (cert {})", cert.display());
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
                .await
                .unwrap_or_else(|e| {
                    panic!("cannot load TLS cert/key ({}, {}): {e}", cert.display(), key.display())
                });
            axum_server::bind_rustls(config.addr, tls)
                .serve(app.into_make_service())
                .await
                .expect("server error");
        }
        None => {
            let listener = tokio::net::TcpListener::bind(config.addr)
                .await
                .unwrap_or_else(|e| panic!("cannot bind {}: {e}", config.addr));
            axum::serve(listener, app).await.expect("server error");
        }
    }
}
