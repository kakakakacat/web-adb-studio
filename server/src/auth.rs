//! Shared-secret gate for `/api/*`.
//!
//! Defence in depth behind Cloudflare Access, not a replacement for it: if a
//! hostname ever gets published without an Access policy attached, this is what
//! stands between the internet and an API that can drive an attached Android
//! device and read/write the NAS.
//!
//! Two ways to present the token, because browsers can't set headers on
//! everything:
//!   * `Authorization: Bearer <token>` — normal fetch() calls
//!   * `?token=<token>` — the WebSocket relay (the WebSocket API has no header
//!     option) and `<a download>` links (the browser navigates, we can't hook it)

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::AppState;

/// Constant-time comparison, so a wrong token can't be discovered byte by byte
/// from response timing.
fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn bearer(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn query_token(req: &Request) -> Option<String> {
    let query = req.uri().query()?;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("token=") {
            return Some(urldecode(value));
        }
    }
    None
}

/// Minimal percent-decoding — tokens are generated as hex/base64url, but decode
/// anyway so a token containing `+` or `%` still works.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The address Cloudflare Access verified, if the request came through it.
pub fn access_email(req: &Request) -> Option<String> {
    Some(
        req.headers()
            .get("cf-access-authenticated-user-email")?
            .to_str()
            .ok()?
            .trim()
            .to_lowercase(),
    )
}

/// Does this identity match the configured domain or the exact allow-list?
pub fn email_allowed(email: &str, domain: Option<&str>, extra: &[String]) -> bool {
    let email = email.trim().to_lowercase();
    if extra.iter().any(|e| e == &email) {
        return true;
    }
    // Match the domain part after the last '@', so "x@evil.com?@corp.com" or a
    // lookalike like "corp.com.evil.com" can't slip through a naive suffix test.
    match (domain, email.rsplit_once('@')) {
        (Some(d), Some((_, host))) => host == d,
        _ => false,
    }
}

/// Does this request carry the shared token?
fn token_ok(cfg: &crate::config::Config, req: &Request) -> bool {
    let Some(expected) = cfg.token.as_deref() else {
        return false;
    };
    bearer(req)
        .map(str::to_string)
        .or_else(|| query_token(req))
        .is_some_and(|presented| secret_eq(&presented, expected))
}

/// May this request use the internal features — Server Files and Dino Admin?
///
/// Signing in and being trusted with company internals are different questions.
/// Anyone with a Google account can be let through the front door to drive their
/// own phone over ADB; reading the NAS share and calling the Dino admin gRPC is
/// for company addresses and the explicit allow-list only.
///
/// The token still implies privilege: it is the split-deployment and local-run
/// credential, held by whoever runs the server.
pub fn is_privileged(cfg: &crate::config::Config, req: &Request) -> bool {
    if token_ok(cfg, req) {
        return true;
    }
    if !cfg.access_configured() {
        // No identity configured at all: loopback-only setups have no way to
        // express a privileged user, and everything is already open to them.
        return true;
    }
    access_email(req)
        .is_some_and(|email| email_allowed(&email, cfg.access_domain.as_deref(), &cfg.access_emails))
}

/// Front door: is this *someone*? Being someone is enough for ADB itself.
pub async fn require_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let cfg = &state.config;

    // Identity first: with Access in front, nobody should have to hold a secret.
    // Any address Access has verified gets in — the allow-list is applied later,
    // per feature, by require_privileged.
    if cfg.access_configured() && access_email(&req).is_some() {
        return next.run(req).await;
    }

    if cfg.token.is_some() {
        if token_ok(cfg, &req) {
            return next.run(req).await;
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "未授权：缺少或错误的访问令牌" })),
        )
            .into_response();
    }

    // No token configured. If identity was required and absent, refuse;
    // otherwise auth is disabled entirely (loopback-only setups).
    if cfg.access_configured() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "未授权：请求未经过 Cloudflare Access" })),
        )
            .into_response();
    }
    next.run(req).await
}

/// Inner door, for Server Files and Dino Admin only.
// 本仓库没有调用方 —— 需要身份的功能在私有的下游仓库里。这是给「自己加一个受保护
// 接口」用的现成中间件，见 main.rs 里那段示例注释。
#[allow(dead_code)]
pub async fn require_privileged(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if is_privileged(&state.config, &req) {
        return next.run(req).await;
    }
    let who = access_email(&req).unwrap_or_else(|| "当前账号".into());
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": format!("{who} 无权使用内部功能（Server Files / Dino Admin）")
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(domain: Option<&str>, emails: &[&str], token: Option<&str>) -> crate::config::Config {
        crate::config::Config {
            addr: "127.0.0.1:7070".parse().unwrap(),
            static_dir: None,
            bridge_dir: None,
            adb_server: "127.0.0.1:5037".parse().unwrap(),
            tls: None,
            allowed_origins: Vec::new(),
            access_domain: domain.map(str::to_string),
            access_emails: emails.iter().map(|e| e.to_string()).collect(),
            token: token.map(str::to_string),
        }
    }

    fn req_as(email: Option<&str>, bearer: Option<&str>) -> Request {
        let mut b = axum::http::Request::builder().uri("/api/health");
        if let Some(e) = email {
            b = b.header("cf-access-authenticated-user-email", e);
        }
        if let Some(t) = bearer {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        b.body(axum::body::Body::empty()).unwrap()
    }

    // Signing in and being trusted with company internals are separate questions:
    // an outside Google account is a legitimate user of the ADB features and must
    // still be refused Server Files and Dino Admin.
    #[test]
    fn outside_google_account_is_signed_in_but_not_privileged() {
        let c = cfg(Some("example.com"), &["friend@gmail.com"], None);
        assert!(!is_privileged(&c, &req_as(Some("stranger@gmail.com"), None)));
        assert!(is_privileged(&c, &req_as(Some("someone@example.com"), None)));
        assert!(is_privileged(&c, &req_as(Some("friend@gmail.com"), None)));
    }

    #[test]
    fn privilege_is_case_insensitive_and_rejects_lookalikes() {
        let c = cfg(Some("example.com"), &[], None);
        assert!(is_privileged(&c, &req_as(Some("Someone@Example.com"), None)));
        assert!(!is_privileged(&c, &req_as(Some("x@example.com.evil.com"), None)));
        assert!(!is_privileged(&c, &req_as(Some("x@notexample.com"), None)));
    }

    // The token is the run-the-server credential; it keeps full access so split
    // and local deployments are not locked out of their own features.
    #[test]
    fn token_grants_privilege_without_an_identity() {
        let c = cfg(Some("example.com"), &[], Some("s3cret"));
        assert!(is_privileged(&c, &req_as(None, Some("s3cret"))));
        assert!(!is_privileged(&c, &req_as(None, Some("wrong"))));
        assert!(!is_privileged(&c, &req_as(Some("stranger@gmail.com"), Some("wrong"))));
    }

    // A loopback run configures no identity at all; there is no allow-list to
    // check against, and the API is already open to whoever can reach the port.
    #[test]
    fn unconfigured_deployment_is_privileged() {
        assert!(is_privileged(&cfg(None, &[], None), &req_as(None, None)));
    }

    #[test]
    fn constant_time_compare_matches_only_identical() {
        assert!(secret_eq("abc123", "abc123"));
        assert!(!secret_eq("abc123", "abc124"));
        assert!(!secret_eq("abc", "abc123"));
        assert!(!secret_eq("", "x"));
        assert!(secret_eq("", ""));
    }

    #[test]
    fn domain_match_is_exact_not_a_suffix() {
        let extra: Vec<String> = vec!["contractor@gmail.com".into()];
        let d = Some("example.com");

        assert!(email_allowed("someone@example.com", d, &extra));
        assert!(email_allowed("SOMEONE@Example.COM", d, &extra), "case-insensitive");
        assert!(email_allowed("contractor@gmail.com", d, &extra), "explicit allow-list");

        // A lookalike domain must not pass a suffix-style check.
        assert!(!email_allowed("evil@notexample.com", d, &extra));
        assert!(!email_allowed("evil@example.com.attacker.net", d, &extra));
        assert!(!email_allowed("someone@gmail.com", d, &extra));
        assert!(!email_allowed("nobody", d, &extra), "no @ at all");
        // With nothing configured, nothing is allowed by identity.
        assert!(!email_allowed("someone@example.com", None, &[]));
    }

    #[test]
    fn decodes_percent_and_plus() {
        assert_eq!(urldecode("abc"), "abc");
        assert_eq!(urldecode("a%2Bb"), "a+b");
        assert_eq!(urldecode("a+b"), "a b");
        // A trailing stray % must not panic or truncate.
        assert_eq!(urldecode("ab%"), "ab%");
    }
}
