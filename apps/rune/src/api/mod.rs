//! The one door to the outside: where work goes ([`Service`]), how it runs off the UI thread
//! and lands back in the app ([`App::spawn`]), which Orbis the app talks to ([`Server`]), and the
//! calls themselves ([`calls`]). Views and handlers never touch the network; they call
//! `s.spawn(work, land)`.
//!
//! Every call goes through [`request`]. In a test it answers from [`fixture`] and records what
//! the app sent, so a test covers a press, the call it makes and what the person then sees. The
//! live event stream is [`events`], one thread for a signed-in window.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::RwLock;

use rune::AppHandle;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::App;

mod calls;
pub mod events;
#[cfg(test)]
pub mod fixture;
#[cfg(not(test))]
mod http;

pub use calls::*;

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
        let session = self.session;
        // The work keeps the key that was current when it was scheduled (see `with_server`).
        let server = Server::for_call();
        let work = move || with_server(server, work);
        let land = move |s: &mut App, out: T| {
            if s.session == session {
                land(s, out);
            }
        };
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

    /// Whether calls go anywhere: a live window or a test's fixture, not the demo.
    pub fn online(&self) -> bool {
        !matches!(self.service, Service::Demo)
    }
}

/// Lands everything fixture work handed back, and what landing that starts, oldest first.
#[cfg(test)]
pub fn settle(s: &mut App) {
    while let Some(landing) = WAITING.with_borrow_mut(|w| (!w.is_empty()).then(|| w.remove(0))) {
        landing(s);
    }
}

/// Lands the oldest landing fixture work handed back. False when none waits.
#[cfg(test)]
pub fn settle_one(s: &mut App) -> bool {
    let landing = WAITING.with_borrow_mut(|w| (!w.is_empty()).then(|| w.remove(0)));
    landing.map(|landing| landing(s)).is_some()
}

/// The Orbis this app talks to: the API's address and the device key it signs in with.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Server {
    pub url: String,
    pub key: String,
}

/// Orbis's own API, which a new device signs in to unless the person names another.
pub const DEFAULT_URL: &str = "https://orbis.p11a.xyz/api";

static SERVER: RwLock<Option<Server>> = RwLock::new(None);

thread_local! {
    /// The server a piece of work speaks to: the one current when it was scheduled.
    static BOUND: RefCell<Option<Server>> = const { RefCell::new(None) };
}

/// Runs `work` with `server` as every call's server on this thread, so work scheduled under
/// one account keeps speaking as it through a sign-out and a sign-in as another.
pub fn with_server<T>(server: Option<Server>, work: impl FnOnce() -> T) -> T {
    let before = BOUND.replace(server);
    let out = work();
    BOUND.set(before);
    out
}

#[cfg(test)]
thread_local! {
    static CONFIG_HERE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Points this test thread's config file at `path`, so tests never touch a real one.
#[cfg(test)]
pub fn config_here(path: PathBuf) {
    CONFIG_HERE.set(Some(path));
}

impl Server {
    /// `ORBIS_URL` and `ORBIS_KEY`, else the file at [`Server::config_path`]. `None` when neither
    /// names both.
    pub fn from_env_or_file() -> Option<Server> {
        let env = |name| std::env::var(name).ok().filter(|v: &String| !v.trim().is_empty());
        if let (Some(url), Some(key)) = (env("ORBIS_URL"), env("ORBIS_KEY")) {
            return Some(Server { url: trim_url(&url), key });
        }
        let file: Server = serde_json::from_str(&std::fs::read_to_string(Self::config_path()).ok()?).ok()?;
        (!file.key.is_empty()).then(|| Server { url: trim_url(&file.url), ..file })
    }

    /// `$XDG_CONFIG_HOME/orbis-rune/config.json`, else under `~/.config`. A test's own file when
    /// it set one ([`config_here`]).
    pub fn config_path() -> PathBuf {
        #[cfg(test)]
        if let Some(path) = CONFIG_HERE.with_borrow(Clone::clone) {
            return path;
        }
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
        base.unwrap_or_default().join("orbis-rune").join("config.json")
    }

    /// Writes this server and key to the config file, readable by this user alone.
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        let fail = |e: std::io::Error| format!("Couldn't save the key to {}: {e}", path.display());
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(fail)?;
        }
        let body = serde_json::to_string_pretty(self).unwrap_or_default();
        write_private(&path, body.as_bytes()).map_err(fail)
    }

    /// Forgets the saved key.
    pub fn forget() {
        let _ = std::fs::remove_file(Self::config_path());
        *SERVER.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Makes this the server every call goes to.
    pub fn connect(self) {
        *SERVER.write().unwrap_or_else(|e| e.into_inner()) = Some(self);
    }

    /// The server calls go to now.
    pub fn current() -> Option<Server> {
        SERVER.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The server this call speaks to: the one its work was bound to, else the current one.
    pub fn for_call() -> Option<Server> {
        BOUND.with_borrow(Clone::clone).or_else(Server::current)
    }
}

fn trim_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// A refused or failed call: Orbis's status when it answered, and words the person can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub status: Option<u16>,
    pub message: String,
}

impl Failure {
    pub fn new(status: Option<u16>, message: impl Into<String>) -> Failure {
        Failure { status, message: message.into() }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<Failure> for String {
    fn from(f: Failure) -> String {
        f.message
    }
}

/// Who a call speaks as: the saved device key, or no one (signing in).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum As {
    Device,
    /// No key, to this address.
    Nobody,
}

/// One call to the API: `method` and `path` (from the API's root), and a JSON body. Answers the
/// decoded reply.
fn request<T: DeserializeOwned>(method: &str, path: &str, body: Option<Value>) -> Result<T, String> {
    exchange(As::Device, None, method, path, body).map_err(String::from)
}

/// [`request`] with the whole failure, to `url` when given, as `who`.
fn exchange<T: DeserializeOwned>(who: As, url: Option<&str>, method: &str, path: &str, body: Option<Value>) -> Result<T, Failure> {
    #[cfg(test)]
    let reply = {
        let _ = (who, url);
        fixture::answer(method, path, body.as_ref())
    };
    #[cfg(not(test))]
    let reply = http::send(who, url, method, path, body);
    let reply = reply?;
    serde_json::from_value(reply).map_err(|e| Failure::new(None, format!("Orbis answered in a shape this app doesn't read ({e})")))
}

/// `id` as one segment of a path.
pub fn segment(id: &str) -> String {
    id.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
