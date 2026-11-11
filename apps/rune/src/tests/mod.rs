//! Press tests: each drives the real view the way a person would, answers the API from the
//! fixture, and checks what the app sent and what it then shows. One file per area; the helpers
//! they share are here.

mod account;
mod library;
mod playback;

use rune::Runtime;
use serde_json::{Value, json};

use crate::api::{self, fixture};
use crate::goldens::runtime;
use crate::{App, Screen};

/// A Set as the API sends it.
pub(super) fn set_json(id: &str, title: &str) -> Value {
    json!({
        "id": id, "title": title, "creator": "Harbour Unit", "durationSeconds": 120, "downloadState": "ready", "source": "youtube",
        "playbackPositionSeconds": 0, "tags": [], "artworkUrl": null, "listenCount": 0
    })
}

/// The demo app, talking to the fixture, its first frame drawn, on `screen`.
pub(super) fn live(screen: Screen) -> Runtime<App> {
    crate::clock::freeze_here();
    let mut s = crate::demo_app();
    s.service = api::Service::Fixture;
    s.screen = screen;
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt
}

/// Lands what the fixture answered, and draws what that changed.
pub(super) fn land(rt: &mut Runtime<App>) {
    api::settle(&mut rt.state);
    rt.invalidate();
    rt.frame(1.0 / 60.0);
}

/// Whether an element keyed `key` is on screen.
pub(super) fn shows(rt: &Runtime<App>, key: &str) -> bool {
    rt.elements().iter().any(|e| !e.exiting && e.key.as_deref() == Some(key))
}

/// Lets what animates in (a dialog, a page) come to rest, so a press lands where it shows.
pub(super) fn still(rt: &mut Runtime<App>) {
    rt.frame(1.0);
    rt.settle_all();
    rt.frame(0.0);
}

/// Answers the reloads a change starts: the Library, the queue and the Playlists.
pub(super) fn answer_reloads() {
    fixture::reply("GET /sets", json!({ "sets": [set_json("s-ferry", "Night Ferry")] }));
    fixture::reply("GET /queue", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    fixture::reply("GET /playlists", json!({ "playlists": [] }));
    fixture::reply("GET /playlists/shared", json!({ "playlists": [] }));
}

/// What the app asked of Orbis, beside Presence and playback reports.
pub(super) fn calls() -> Vec<String> {
    fixture::sent().into_iter().filter(|c| !c.starts_with("POST /presence/actions") && !c.starts_with("POST /diagnostics/playback")).collect()
}

pub(super) fn press(rt: &mut Runtime<App>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("{key} is on screen"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

pub(super) fn space() -> rune::KeyEvent {
    rune::KeyEvent { key: rune::Key::Text(" ".to_owned()), mods: rune::Mods::default() }
}
