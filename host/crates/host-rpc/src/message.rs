// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! JSON-RPC 2.0 message shapes and error codes.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::fmt;

/// Standard JSON-RPC 2.0 error codes.
pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
}

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(codes::PARSE_ERROR, message)
    }
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_REQUEST, message)
    }
    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            codes::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        )
    }
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_PARAMS, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL_ERROR, message)
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

/// An incoming message, classified.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// Has an `id`; must be answered.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    /// No `id`; never answered.
    Notification { method: String, params: Value },
    /// A response to a request this side sent.
    Response { id: Value },
}

impl Incoming {
    /// Classifies a parsed JSON value. On failure returns the error and the
    /// request id to answer it under (`null` when none could be read).
    pub fn from_value(value: Value) -> Result<Self, (Value, RpcError)> {
        let Value::Object(mut obj) = value else {
            return Err((
                Value::Null,
                RpcError::invalid_request("message must be a JSON object"),
            ));
        };
        let id = obj.remove("id");
        let id_or_null = id.clone().unwrap_or(Value::Null);
        if let Some(id) = &id
            && !matches!(id, Value::Null | Value::Number(_) | Value::String(_))
        {
            return Err((
                Value::Null,
                RpcError::invalid_request("id must be a string, number or null"),
            ));
        }
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err((
                id_or_null,
                RpcError::invalid_request("jsonrpc must be \"2.0\""),
            ));
        }
        match obj.remove("method") {
            Some(Value::String(method)) => {
                let params = obj.remove("params").unwrap_or(Value::Null);
                if !matches!(params, Value::Null | Value::Object(_) | Value::Array(_)) {
                    return Err((
                        id_or_null,
                        RpcError::invalid_request("params must be an object or array"),
                    ));
                }
                Ok(match id {
                    Some(id) => Incoming::Request { id, method, params },
                    None => Incoming::Notification { method, params },
                })
            }
            Some(_) => Err((
                id_or_null,
                RpcError::invalid_request("method must be a string"),
            )),
            None if obj.contains_key("result") || obj.contains_key("error") => {
                Ok(Incoming::Response { id: id_or_null })
            }
            None => Err((
                id_or_null,
                RpcError::invalid_request("message has no method"),
            )),
        }
    }
}

/// Serializes a success response.
pub fn response_ok(id: &Value, result: &Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Serializes an error response.
pub fn response_err(id: &Value, error: &RpcError) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// Serializes a notification.
pub fn notification(method: &str, params: &Value) -> Value {
    if params.is_null() {
        serde_json::json!({ "jsonrpc": "2.0", "method": method })
    } else {
        serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
    }
}

/// Parameter type for methods that take none: accepts absent params, `null`,
/// `{}` and `[]`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct NoParams;

impl<'de> Deserialize<'de> for NoParams {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(NoParams),
            Value::Object(m) if m.is_empty() => Ok(NoParams),
            Value::Array(a) if a.is_empty() => Ok(NoParams),
            _ => Err(serde::de::Error::custom("this method takes no params")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_request() {
        let m =
            Incoming::from_value(json!({"jsonrpc":"2.0","id":1,"method":"a.b","params":{"x":1}}));
        assert_eq!(
            m.unwrap(),
            Incoming::Request {
                id: json!(1),
                method: "a.b".into(),
                params: json!({"x":1})
            }
        );
    }

    #[test]
    fn classify_notification() {
        let m = Incoming::from_value(json!({"jsonrpc":"2.0","method":"n"})).unwrap();
        assert_eq!(
            m,
            Incoming::Notification {
                method: "n".into(),
                params: Value::Null
            }
        );
    }

    #[test]
    fn classify_response() {
        let m = Incoming::from_value(json!({"jsonrpc":"2.0","id":"7","result":null})).unwrap();
        assert_eq!(m, Incoming::Response { id: json!("7") });
    }

    #[test]
    fn reject_bad_shapes() {
        for (v, code) in [
            (json!([1]), codes::INVALID_REQUEST),
            (json!({"id":1,"method":"m"}), codes::INVALID_REQUEST),
            (
                json!({"jsonrpc":"1.0","id":1,"method":"m"}),
                codes::INVALID_REQUEST,
            ),
            (
                json!({"jsonrpc":"2.0","id":1,"method":5}),
                codes::INVALID_REQUEST,
            ),
            (
                json!({"jsonrpc":"2.0","id":{},"method":"m"}),
                codes::INVALID_REQUEST,
            ),
            (
                json!({"jsonrpc":"2.0","id":1,"method":"m","params":3}),
                codes::INVALID_REQUEST,
            ),
        ] {
            assert_eq!(Incoming::from_value(v).unwrap_err().1.code, code);
        }
    }

    #[test]
    fn no_params_accepts_empty_forms() {
        for v in [Value::Null, json!({}), json!([])] {
            assert_eq!(serde_json::from_value::<NoParams>(v).unwrap(), NoParams);
        }
        assert!(serde_json::from_value::<NoParams>(json!({"a":1})).is_err());
    }

    #[test]
    fn error_serializes_without_data() {
        let e = RpcError::method_not_found("x");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({"code": -32601, "message": "method not found: x"})
        );
    }
}
