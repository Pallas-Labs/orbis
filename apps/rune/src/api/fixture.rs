//! A test's stand-in for the API: it answers each route from what the test set, and keeps every
//! request the app made, in order.

use std::cell::RefCell;

use serde_json::Value;

use super::Failure;

/// A route, what it answers, and whether that answers a single request and goes.
type Answer = (String, Result<Value, Failure>, bool);

thread_local! {
    /// Each route's answers, newest last.
    static ANSWERS: RefCell<Vec<Answer>> = const { RefCell::new(Vec::new()) };
    static SENT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Answers `route` ("PUT /queue/active") with `reply` from now on.
pub fn reply(route: &str, reply: Value) {
    ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Ok(reply), false)));
}

/// Refuses `route` with `why` from now on.
pub fn refuse(route: &str, why: &str) {
    refuse_with(route, 500, why);
}

/// Refuses `route` with `status` and `why` from now on.
pub fn refuse_with(route: &str, status: u16, why: &str) {
    ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Err(Failure::new(Some(status), why)), false)));
}

/// Refuses `route` with `status` and `why` for its next request only; `None` is no answer at all.
/// Set several to refuse that many requests; then the answer set before stands again.
pub fn refuse_once(route: &str, status: Option<u16>, why: &str) {
    ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Err(Failure::new(status, why)), true)));
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
    let found = ANSWERS.with_borrow_mut(|a| {
        let at = a.iter().rposition(|(r, _, _)| *r == route)?;
        Some(if a[at].2 { a.remove(at).1 } else { a[at].1.clone() })
    });
    found.unwrap_or_else(|| Err(Failure::new(None, format!("the fixture has no answer for {route}"))))
}
