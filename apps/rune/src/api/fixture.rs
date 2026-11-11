//! A test's stand-in for the API: it answers each route from what the test set, and keeps every
//! request the app made, in order.

use std::cell::RefCell;

use serde_json::Value;

use super::Failure;

thread_local! {
    static ANSWERS: RefCell<Vec<(String, Result<Value, Failure>)>> = const { RefCell::new(Vec::new()) };
    static SENT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Answers `route` ("PUT /queue/active") with `reply` from now on.
pub fn reply(route: &str, reply: Value) {
    ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Ok(reply))));
}

/// Refuses `route` with `why` from now on.
pub fn refuse(route: &str, why: &str) {
    refuse_with(route, 500, why);
}

/// Refuses `route` with `status` and `why` from now on.
pub fn refuse_with(route: &str, status: u16, why: &str) {
    ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Err(Failure::new(Some(status), why)))));
}

/// Every request so far, as `METHOD /path {body}`.
pub fn sent() -> Vec<String> {
    SENT.with_borrow(Clone::clone)
}

/// Every request so far to `route`, as its bodies.
pub fn bodies(route: &str) -> Vec<Value> {
    SENT.with_borrow(|s| s.iter().filter_map(|line| line.strip_prefix(route)?.strip_prefix(' ')).filter_map(|body| serde_json::from_str(body).ok()).collect())
}

pub(super) fn answer(method: &str, path: &str, body: Option<&Value>) -> Result<Value, Failure> {
    let route = format!("{method} {path}");
    SENT.with_borrow_mut(|s| s.push(body.map_or_else(|| route.clone(), |b| format!("{route} {b}"))));
    let found = ANSWERS.with_borrow(|a| a.iter().rev().find(|(r, _)| *r == route).map(|(_, reply)| reply.clone()));
    found.unwrap_or_else(|| Err(Failure::new(None, format!("the fixture has no answer for {route}"))))
}
