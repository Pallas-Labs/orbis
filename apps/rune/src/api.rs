//! The one door to the outside: where work goes ([`Service`]), how it runs off the UI thread
//! and lands back in the app ([`App::spawn`]), and the calls to the Orbis API. Views and
//! handlers never touch the network; they call `s.spawn(work, land)`.
//!
//! Every call goes through [`request`]. In a test it answers from [`fixture`] and records what
//! the app sent, so a test covers a press, the call it makes and what the person then sees.

#[cfg(test)]
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;

use rune::AppHandle;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::App;
use crate::model::{Queue, Set, Tracklist};

/// Where the app's work goes.
#[derive(Default)]
pub enum Service {
    /// The live service: work runs on a thread and lands through the handle.
    Live(AppHandle<App>),
    /// Made-up data for headless renders, the demo and goldens. Nothing goes out.
    #[default]
    Demo,
    /// A test's stand-in: work runs at once on the test's thread, and lands at [`settle`].
    #[cfg(test)]
    Fixture,
}

#[cfg(test)]
type Landing = Box<dyn FnOnce(&mut App)>;

#[cfg(test)]
thread_local! {
    /// What fixture work handed back, waiting for [`settle`], as the UI thread would wait.
    static WAITING: RefCell<Vec<Landing>> = const { RefCell::new(Vec::new()) };
}

impl App {
    /// Runs `work` off the UI thread, then `land`s what it returns in the app.
    pub fn spawn<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static, land: impl FnOnce(&mut App, T) + Send + 'static) {
        match &self.service {
            Service::Live(handle) => {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let out = work();
                    handle.update(move |s: &mut App, _| land(s, out));
                });
            }
            Service::Demo => {}
            #[cfg(test)]
            Service::Fixture => {
                let out = work();
                WAITING.with_borrow_mut(|w| w.push(Box::new(move |s| land(s, out))));
            }
        }
    }
}

/// Lands everything fixture work handed back, and what landing that starts, oldest first.
#[cfg(test)]
pub fn settle(s: &mut App) {
    while let Some(landing) = WAITING.with_borrow_mut(|w| (!w.is_empty()).then(|| w.remove(0))) {
        landing(s);
    }
}

/// The Orbis API this app talks to, and the device key it signs in with.
#[derive(Deserialize)]
pub struct Server {
    pub url: String,
    #[cfg_attr(test, expect(dead_code, reason = "tests answer from the fixture and never send the key"))]
    pub key: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

impl Server {
    /// `ORBIS_URL` and `ORBIS_KEY`, else the file at [`Server::config_path`]. `None` when neither
    /// names both.
    pub fn from_env_or_file() -> Option<Server> {
        let env = |name| std::env::var(name).ok().filter(|v: &String| !v.trim().is_empty());
        if let (Some(url), Some(key)) = (env("ORBIS_URL"), env("ORBIS_KEY")) {
            return Some(Server { url: url.trim_end_matches('/').to_owned(), key });
        }
        let file: Server = serde_json::from_str(&std::fs::read_to_string(Self::config_path()).ok()?).ok()?;
        Some(Server { url: file.url.trim_end_matches('/').to_owned(), ..file })
    }

    /// `$XDG_CONFIG_HOME/orbis-rune/config.json`, else under `~/.config`.
    pub fn config_path() -> PathBuf {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
        base.unwrap_or_default().join("orbis-rune").join("config.json")
    }

    /// Makes this the server every call goes to. Only `main` calls it, for a live app.
    pub fn connect(self) {
        let _ = SERVER.set(self);
    }
}

/// One call to the API: `method` and `path` (from the API's root), and a JSON body. Answers the
/// decoded reply, or words the person can act on.
fn request<T: DeserializeOwned>(method: &str, path: &str, body: Option<Value>) -> Result<T, String> {
    #[cfg(test)]
    let reply = fixture::answer(method, path, body.as_ref());
    #[cfg(not(test))]
    let reply = http::send(method, path, body);
    serde_json::from_value(reply?).map_err(|e| format!("Orbis answered in a shape this app doesn't read ({e})"))
}

/// The live calls over HTTP, with the device key. Tests never build it: they answer from
/// [`fixture`].
#[cfg(not(test))]
mod http {
    use std::sync::OnceLock;
    use std::time::Duration;

    use serde_json::Value;

    use super::SERVER;

    fn agent() -> &'static ureq::Agent {
        static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
        AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(20)).timeout_write(Duration::from_secs(20)).build())
    }

    pub(super) fn send(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let Some(server) = SERVER.get() else { return Err("Not signed in".to_owned()) };
        let call = agent().request(method, &format!("{}{path}", server.url)).set("Authorization", &format!("Bearer {}", server.key));
        let answer = match body {
            Some(body) => call.send_json(body),
            None => call.call(),
        };
        match answer {
            Ok(reply) => reply.into_json().map_err(|_| "Orbis sent a reply this app couldn't read".to_owned()),
            Err(ureq::Error::Status(status, reply)) => {
                let message = reply.into_json::<Value>().ok().and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned));
                Err(failure(status, message))
            }
            Err(ureq::Error::Transport(_)) => Err(format!("Couldn't reach Orbis at {}", server.url)),
        }
    }

    /// Words for a refused call: what happened, and what to do when there is something.
    fn failure(status: u16, message: Option<String>) -> String {
        match status {
            401 | 403 => "Orbis didn't accept this device's key. Add a new key to the config file.".to_owned(),
            404 => message.unwrap_or_else(|| "Orbis has no such Set any more".to_owned()),
            429 => "Orbis is busy. Try again in a minute.".to_owned(),
            _ => message.unwrap_or_else(|| format!("Orbis answered {status}")),
        }
    }
}

#[derive(Deserialize)]
struct Sets {
    sets: Vec<Set>,
}

#[derive(Deserialize)]
struct QueueReply {
    queue: Queue,
}

#[derive(Deserialize)]
struct Grant {
    url: String,
}

fn set_path(id: &str, rest: &str) -> String {
    let id: String = id.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    format!("/sets/{id}{rest}")
}

/// The caller's Library, newest first as the server orders it.
pub fn library() -> Result<Vec<Set>, String> {
    request::<Sets>("GET", "/sets", None).map(|r| r.sets)
}

/// The caller's Listening Queue.
pub fn queue() -> Result<Queue, String> {
    request::<QueueReply>("GET", "/queue", None).map(|r| r.queue)
}

/// Makes `id` the active Set, keeping the rest of the queue.
pub fn play(id: &str) -> Result<Queue, String> {
    request::<QueueReply>("PUT", "/queue/active", Some(json!({ "setId": id }))).map(|r| r.queue)
}

/// Where a Set joins the queue: right after the active one, or at the end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    Next,
    End,
}

/// Puts `id` in the queue.
pub fn enqueue(id: &str, placement: Placement) -> Result<Queue, String> {
    let placement = if placement == Placement::Next { "next" } else { "end" };
    request::<QueueReply>("POST", "/queue/entries", Some(json!({ "setId": id, "placement": placement }))).map(|r| r.queue)
}

/// Tells Orbis `id` played to its end: it leaves the queue and the next Set becomes active.
pub fn complete(id: &str) -> Result<Queue, String> {
    request::<QueueReply>("POST", "/queue/completion", Some(json!({ "setId": id }))).map(|r| r.queue)
}

/// Saves where the caller is in `id`, in whole seconds.
pub fn save_position(id: &str, seconds: f64) -> Result<Set, String> {
    request("PUT", &set_path(id, "/position"), Some(json!({ "seconds": seconds.clamp(0.0, 604_800.0).floor() })))
}

/// A Set's Tracklist.
pub fn tracklist(id: &str) -> Result<Tracklist, String> {
    request("GET", &set_path(id, "/tracklist"), None)
}

/// Asks Orbis to make Retained Audio for `id`.
pub fn download(id: &str) -> Result<Set, String> {
    request("POST", &set_path(id, "/audio/download"), None)
}

/// An address a player can stream `id`'s audio from without the key: the API signs the audio
/// route for a day (ADR 0007). Refuses a grant for any other route.
pub fn stream_url(id: &str) -> Result<String, String> {
    let grant: Grant = request("POST", &set_path(id, "/audio/grant"), None)?;
    let route = set_path(id, "/audio?");
    if !grant.url.starts_with(&route) {
        return Err("Orbis granted audio for another address".to_owned());
    }
    let base = SERVER.get().map_or("", |s| s.url.as_str());
    Ok(format!("{base}{}", grant.url))
}

/// A test's stand-in for the API: it answers each route from what the test set, and keeps
/// every request the app made, in order.
#[cfg(test)]
pub mod fixture {
    use std::cell::RefCell;

    use serde_json::Value;

    thread_local! {
        static ANSWERS: RefCell<Vec<(String, Result<Value, String>)>> = const { RefCell::new(Vec::new()) };
        static SENT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// Answers `route` ("PUT /queue/active") with `reply` from now on.
    pub fn reply(route: &str, reply: Value) {
        ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Ok(reply))));
    }

    /// Refuses `route` with `why` from now on.
    pub fn refuse(route: &str, why: &str) {
        ANSWERS.with_borrow_mut(|a| a.push((route.to_owned(), Err(why.to_owned()))));
    }

    /// Every request so far, as `METHOD /path {body}`.
    pub fn sent() -> Vec<String> {
        SENT.with_borrow(Clone::clone)
    }

    pub(super) fn answer(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let route = format!("{method} {path}");
        SENT.with_borrow_mut(|s| s.push(body.map_or_else(|| route.clone(), |b| format!("{route} {b}"))));
        let found = ANSWERS.with_borrow(|a| a.iter().rev().find(|(r, _)| *r == route).map(|(_, reply)| reply.clone()));
        found.unwrap_or_else(|| Err(format!("the fixture has no answer for {route}")))
    }
}
