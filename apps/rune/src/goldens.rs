//! Golden trees: every demo scene, built in the test process as `--scene` builds it, run for
//! 1.5 s of frames, settled, and written as one line per element in `goldens/<scene>.txt`.
//! A change to what any scene shows fails `cargo test`; rewrite the files with
//! `ORBIS_RUNE_UPDATE_GOLDENS=1 cargo test goldens` and read the diff. Layout and text run on the
//! CPU and the clock is frozen, so the trees match on every run, with no GPU.
//!
//! Also here: press tests, which drive the real view the way a person would, answer the API
//! from the fixture, and check what the app sent and what it then shows.

use std::fmt::Write as _;
use std::path::PathBuf;

use rune::{Env, Runtime};
use serde_json::{Value, json};

use crate::api::{self, fixture};
use crate::playing::Status;
use crate::{App, Screen};

const SIZE: (f32, f32) = (1120.0, 760.0);

/// The checkout this run tests, read at run time: a test binary built in one worktree and run
/// from another writes only where it was run.
fn checkout() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn runtime(s: App) -> Runtime<App> {
    let mut rt = Runtime::new(s, crate::view, SIZE, Env::new(true, 1.0));
    rt.poll = Some(crate::poll);
    rt.on_key = Some(crate::on_key);
    rt
}

/// The scene's elements, settled, one line each.
fn tree(apply: fn(&mut App)) -> String {
    let mut s = crate::demo_app();
    apply(&mut s);
    let mut rt = runtime(s);
    for _ in 0..3 {
        rt.frame(0.5);
    }
    rt.settle_all();
    rt.frame(0.0);
    let mut out = String::new();
    for e in rt.elements().iter().filter(|e| !e.exiting) {
        let depth = e.path.matches('/').count();
        let name = e.path.rsplit('/').next().unwrap_or_default();
        let field = |v: &Option<String>| v.as_deref().map_or_else(|| "-".to_owned(), |t| t.replace('\n', "\\n"));
        let [x, y, w, h] = e.rect.map(|v| (v * 10.0).round() / 10.0);
        let color = e.text_color.map_or_else(|| "-".to_owned(), |c| c.hex());
        let _ = writeln!(out, "{:depth$}{name}\t{}\t{}\t{}\t{}\t{x},{y},{w},{h}\t{}\t{color}\t{:.2}", "", e.role, field(&e.key), field(&e.label), field(&e.text), e.fill.hex(), e.opacity);
    }
    out
}

#[test]
fn every_scene_draws_as_its_golden() {
    crate::clock::freeze_here();
    let update = std::env::var_os("ORBIS_RUNE_UPDATE_GOLDENS").is_some();
    let (folder, actual) = (checkout().join("goldens"), checkout().join("target/goldens-actual"));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(&actual).unwrap();
    let mut differ = Vec::new();
    for (name, apply) in crate::demo::SCENES {
        let got = tree(*apply);
        let path = folder.join(format!("{name}.txt"));
        if update {
            std::fs::write(&path, &got).unwrap();
        } else if std::fs::read_to_string(&path).unwrap_or_default() != got {
            std::fs::write(actual.join(format!("{name}.txt")), &got).unwrap();
            differ.push(*name);
        }
    }
    let names: Vec<String> = crate::demo::SCENES.iter().map(|(n, _)| format!("{n}.txt")).collect();
    let stale: Vec<String> = std::fs::read_dir(&folder).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|f| !names.contains(f)).collect();
    assert!(stale.is_empty(), "goldens/ holds files for no scene: {stale:?}");
    assert!(
        differ.is_empty(),
        "scenes differ from goldens/: {differ:?} (now in target/goldens-actual/; `diff -r goldens target/goldens-actual` shows how). If meant, rewrite with ORBIS_RUNE_UPDATE_GOLDENS=1 cargo test goldens and read the diff."
    );
}

/// A Set as the API sends it.
fn set_json(id: &str, title: &str) -> Value {
    json!({
        "id": id, "title": title, "creator": "Harbour Unit", "durationSeconds": 120, "downloadState": "ready", "source": "youtube",
        "playbackPositionSeconds": 0, "tags": [], "artworkUrl": null, "listenCount": 0
    })
}

/// The demo app, talking to the fixture, its first frame drawn, on `screen`.
fn live(screen: Screen) -> Runtime<App> {
    crate::clock::freeze_here();
    let mut s = crate::demo_app();
    s.service = api::Service::Fixture;
    s.screen = screen;
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt
}

/// Lands what the fixture answered, and draws what that changed.
fn land(rt: &mut Runtime<App>) {
    api::settle(&mut rt.state);
    rt.invalidate();
    rt.frame(1.0 / 60.0);
}

/// Whether an element keyed `key` is on screen.
fn shows(rt: &Runtime<App>, key: &str) -> bool {
    rt.elements().iter().any(|e| !e.exiting && e.key.as_deref() == Some(key))
}

fn press(rt: &mut Runtime<App>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("{key} is on screen"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

#[test]
fn pressing_a_set_plays_it_and_tells_orbis_it_is_active() {
    let mut rt = live(Screen::Library);
    let queue = json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub"), set_json("s-sunrise", "Sunrise on the Pier")] } });
    fixture::reply("PUT /queue/active", queue);
    fixture::reply(
        "GET /sets/s-low-tide/tracklist",
        json!({ "cues": [{ "artist": "Harbour Unit", "title": "Dub One", "startSeconds": 0, "position": 0, "appleMusicId": null, "artworkUrl": null }], "state": "ready" }),
    );
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    press(&mut rt, "set-s-low-tide");

    let p = &rt.state.playing;
    assert_eq!((p.set.as_ref().map(|x| x.id.as_str()), &p.status), (Some("s-low-tide"), &Status::Playing), "it plays at once");
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().active_set_id.as_deref(), Some("s-low-tide"), "and is active in the queue at once");
    land(&mut rt);
    assert_eq!(fixture::sent(), ["GET /sets/s-low-tide/tracklist", "PUT /queue/active {\"setId\":\"s-low-tide\"}"]);
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().entries.len(), 2, "the queue is what Orbis sent back");
    assert_eq!(rt.state.playing.tracklist.data.as_ref().map(|t| t.cues.len()), Some(1));
    assert!(shows(&rt, "bar-open"), "the bar shows what plays");
}

#[test]
fn a_set_that_plays_out_leaves_the_queue_and_the_next_one_plays() {
    let mut rt = live(Screen::Playing);
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub")] } }));
    fixture::reply("GET /sets/s-low-tide/tracklist", json!({ "cues": [], "state": "none" }));
    press(&mut rt, "play");
    assert_eq!(rt.state.playing.status, Status::Playing);
    let left = rt.state.playing.duration.unwrap() - rt.state.playing.position;
    // Rune's clock runs past the Set's end; the silent player moves the place on it.
    for _ in 0..=(left as usize / 30 + 1) {
        rt.frame(30.0);
    }
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-low-tide"), "the next Set plays");
    land(&mut rt);
    let sent = fixture::sent();
    assert!(sent.contains(&"PUT /sets/s-sunrise/position {\"seconds\":0.0}".to_owned()), "its place goes back to the start: {sent:?}");
    assert!(sent.contains(&"POST /queue/completion {\"setId\":\"s-sunrise\"}".to_owned()), "{sent:?}");
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().entries.len(), 1, "it left the queue");
}

#[test]
fn play_next_puts_a_set_after_the_active_one_and_says_so() {
    let mut rt = live(Screen::Library);
    fixture::reply("POST /queue/entries", json!({ "queue": { "activeSetId": "s-sunrise", "entries": [set_json("s-sunrise", "Sunrise on the Pier"), set_json("s-ferry", "Night Ferry")] } }));
    press(&mut rt, "next-s-ferry");
    land(&mut rt);
    assert_eq!(fixture::sent(), ["POST /queue/entries {\"placement\":\"next\",\"setId\":\"s-ferry\"}"]);
    assert_eq!(rt.state.toast.as_deref(), Some("Night Ferry plays next"));
}

#[test]
fn a_set_without_audio_says_why_it_does_not_play_and_sends_nothing() {
    let mut rt = live(Screen::Library);
    press(&mut rt, "set-s-dunes");
    assert_eq!(rt.state.toast.as_deref(), Some("Can't play Dune Radio 41: Not downloaded yet"));
    assert!(fixture::sent().is_empty());
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-sunrise"), "what was loaded stays");
}

#[test]
fn a_refused_play_stops_and_says_why() {
    let mut rt = live(Screen::Playing);
    fixture::refuse("PUT /queue/active", "Orbis answered 500");
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| s.play("s-ferry"));
    land(&mut rt);
    assert_eq!(rt.state.playing.status, Status::Failed("Orbis answered 500".to_owned()));
    assert!(shows(&rt, "set-problem"), "Now Playing shows why");
}

fn space() -> rune::KeyEvent {
    rune::KeyEvent { key: rune::Key::Text(" ".to_owned()), mods: rune::Mods::default() }
}

#[test]
fn space_plays_and_pauses() {
    let mut rt = live(Screen::Library);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.playing.status, Status::Playing);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.playing.status, Status::Paused);
}
