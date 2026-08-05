//! 本仓库里这个模块暂时没有调用方：它服务的是需要身份的接口，而那些在私有的下游仓库
//! 中。保留它是因为下游要用 —— 删掉会让下游每次同步共享代码都产生冲突。
#![allow(dead_code)]

//! One error type for all handlers, rendered as `{"error": "..."}` JSON so the
//! frontend can show it verbatim.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
    }

    /// 503: the feature exists but isn't configured (no SSH key, for instance).
    pub fn unavailable(message: impl Into<String>) -> Self {
        ApiError { status: StatusCode::SERVICE_UNAVAILABLE, message: message.into() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
