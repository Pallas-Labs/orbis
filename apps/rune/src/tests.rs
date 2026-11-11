//! Press tests: each drives the real view the way a person would, answers the API from the
//! fixture, and checks what the app sent and what it then shows.

use rune::Runtime;
use serde_json::{Value, json};

use crate::api::{self, fixture};
use crate::goldens::runtime;
use crate::playing::Status;
use crate::{App, Screen};

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

/// Lets what animates in (a dialog, a page) come to rest, so a press lands where it shows.
fn still(rt: &mut Runtime<App>) {
    rt.frame(1.0);
    rt.settle_all();
    rt.frame(0.0);
}

/// Answers the reloads a change starts: the Library, the queue and the Playlists.
fn answer_reloads() {
    fixture::reply("GET /sets", json!({ "sets": [set_json("s-ferry", "Night Ferry")] }));
    fixture::reply("GET /queue", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    fixture::reply("GET /playlists", json!({ "playlists": [] }));
    fixture::reply("GET /playlists/shared", json!({ "playlists": [] }));
}

/// What the app asked of Orbis, beside Presence and playback reports.
fn calls() -> Vec<String> {
    fixture::sent().into_iter().filter(|c| !c.starts_with("POST /presence/actions") && !c.starts_with("POST /diagnostics/playback")).collect()
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
    assert_eq!(calls(), ["GET /sets/s-low-tide/tracklist", "PUT /queue/active {\"setId\":\"s-low-tide\"}"]);
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
    assert_eq!(calls(), ["POST /queue/entries {\"placement\":\"next\",\"setId\":\"s-ferry\"}"]);
    assert_eq!(rt.state.toast.as_deref(), Some("Night Ferry plays next"));
}

#[test]
fn a_set_without_audio_says_why_it_does_not_play_and_sends_nothing() {
    let mut rt = live(Screen::Library);
    press(&mut rt, "set-s-dunes");
    assert_eq!(rt.state.toast.as_deref(), Some("Can't play Dune Radio 41: Not downloaded yet"));
    assert!(calls().is_empty());
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

#[test]
fn shuffling_a_playlist_replaces_the_queue_and_plays_its_first_set() {
    let mut rt = live(Screen::Library);
    let detail = json!({ "id": "p-morning", "name": "Morning", "setCount": 2, "creator": { "id": "u-me", "username": "avery" }, "role": "creator", "sets": [set_json("s-ferry", "Night Ferry"), set_json("s-tram", "Tram Lines at Dawn")] });
    fixture::reply("GET /playlists/p-morning", detail);
    fixture::reply("PUT /queue/playlist", json!({ "queue": { "activeSetId": "s-tram", "entries": [set_json("s-tram", "Tram Lines at Dawn"), set_json("s-ferry", "Night Ferry")] } }));
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| s.go(Screen::Playlist("p-morning".to_owned())));
    land(&mut rt);
    still(&mut rt);
    assert!(shows(&rt, "playlist-name"), "the Playlist's page shows");
    press(&mut rt, "playlist-shuffle");
    land(&mut rt);
    assert!(calls().contains(&"PUT /queue/playlist {\"order\":\"shuffled\",\"playlistId\":\"p-morning\"}".to_owned()), "{:?}", calls());
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-tram"), "the queue's new first Set plays");
    assert_eq!(rt.state.playing.status, Status::Playing);
}

#[test]
fn adding_a_set_to_a_playlist_keeps_the_members_another_editor_added() {
    let mut rt = live(Screen::Library);
    let detail = json!({ "id": "p-road", "name": "Road Trip", "setCount": 1, "creator": { "id": "u-mira", "username": "mira" }, "role": "editor", "sets": [set_json("s-theirs", "Their Set")] });
    fixture::reply("GET /playlists/p-road", detail);
    fixture::reply("PUT /playlists/p-road/sets", json!({ "sets": [] }));
    answer_reloads();
    rt.update(|s, _| s.toggle_in_playlist("s-ferry", "p-road"));
    land(&mut rt);
    assert!(calls().contains(&"PUT /playlists/p-road/sets {\"setIds\":[\"s-theirs\",\"s-ferry\"]}".to_owned()), "{:?}", calls());
    assert_eq!(rt.state.toast.as_deref(), Some("Added to Road Trip"));
}

#[test]
fn a_new_playlist_from_a_sets_menu_holds_that_set_and_opens() {
    let mut rt = live(Screen::Library);
    rt.update(|s, _| s.new_playlist(Some("s-ferry".to_owned())));
    rt.frame(1.0 / 60.0);
    assert!(shows(&rt, "dialog-field"), "the dialog asks for a name");
    rt.update(|s, _| {
        if let Some(crate::dialogs::Dialog::NewPlaylist { edit, .. }) = s.dialog.as_mut() {
            *edit = rune::TextEdit::new("Late Drive");
        }
    });
    fixture::reply("POST /playlists", json!({ "id": "p-late", "name": "Late Drive", "setCount": 0, "createdAt": "2027-01-15T08:00:00Z" }));
    fixture::reply("PUT /playlists/p-late/sets", json!({ "sets": [set_json("s-ferry", "Night Ferry")] }));
    fixture::reply(
        "GET /playlists/p-late",
        json!({ "id": "p-late", "name": "Late Drive", "setCount": 1, "creator": { "id": "u-me", "username": "avery" }, "role": "creator", "sets": [set_json("s-ferry", "Night Ferry")] }),
    );
    answer_reloads();
    still(&mut rt);
    press(&mut rt, "dialog-save");
    land(&mut rt);
    let sent = calls();
    assert!(sent.contains(&"POST /playlists {\"name\":\"Late Drive\"}".to_owned()), "{sent:?}");
    assert!(sent.contains(&"PUT /playlists/p-late/sets {\"setIds\":[\"s-ferry\"]}".to_owned()), "{sent:?}");
    assert_eq!(rt.state.screen, Screen::Playlist("p-late".to_owned()));
    assert!(rt.state.dialog.is_none());
}

#[test]
fn saving_a_link_says_its_download_started_and_a_refusal_stays_in_the_dialog() {
    let mut rt = live(Screen::Library);
    answer_reloads();
    press(&mut rt, "save-link");
    rt.update(|s, _| {
        if let Some(crate::dialogs::Dialog::SaveLink { edit, .. }) = s.dialog.as_mut() {
            *edit = rune::TextEdit::new("https://example.com/nope");
        }
    });
    fixture::refuse_with("POST /sets", 400, "Orbis saves YouTube, SoundCloud and Apple Music links");
    still(&mut rt);
    press(&mut rt, "dialog-save");
    land(&mut rt);
    assert!(shows(&rt, "dialog-problem"), "the dialog says why");
    let mut saved = set_json("s-new", "Sunrise Again");
    saved["autoDownloadResult"] = json!("queued");
    fixture::reply("POST /sets", saved);
    press(&mut rt, "dialog-save");
    land(&mut rt);
    assert!(rt.state.dialog.is_none());
    assert_eq!(rt.state.toast.as_deref(), Some("Saved Sunrise Again. Its audio is downloading."));
    assert!(calls().contains(&"GET /sets".to_owned()), "the Library reloads");
}

#[test]
fn tags_are_typed_lower_case_and_saved_with_the_set() {
    let mut rt = live(Screen::Library);
    rt.update(|s, _| s.edit_tags("s-ferry"));
    rt.update(|s, _| {
        if let Some(crate::dialogs::Dialog::Tags { edit, .. }) = s.dialog.as_mut() {
            *edit = rune::TextEdit::new("  Night Drive ");
        }
    });
    let mut tagged = set_json("s-ferry", "Night Ferry");
    tagged["tags"] = json!(["night drive", "ambient"]);
    fixture::reply("PATCH /sets/s-ferry/tags", tagged);
    rt.update(|s, _| s.add_typed_tag());
    still(&mut rt);
    press(&mut rt, "dialog-tag-ambient");
    press(&mut rt, "dialog-save");
    land(&mut rt);
    assert!(calls().contains(&"PATCH /sets/s-ferry/tags {\"tags\":[\"night drive\",\"ambient\"]}".to_owned()), "{:?}", calls());
    let ferry = rt.state.find_set("s-ferry").unwrap();
    assert_eq!(ferry.tags, ["night drive", "ambient"], "the row shows them");
}

#[test]
fn a_sign_in_code_saves_the_key_privately_and_opens_the_library() {
    let dir = std::env::temp_dir().join(format!("orbis-rune-test-{}", crate::playing::new_id()));
    api::config_here(dir.join("config.json"));
    let mut s = App { signed_out: true, service: api::Service::Fixture, ..App::new() };
    s.account.signin.code = rune::TextEdit::new("k7q2-m9xh");
    let mut rt = runtime(s);
    rt.frame(0.0);
    fixture::reply("POST /sign-in/code", json!({ "key": "made-up-key", "person": { "id": "u-me", "username": "avery" } }));
    press(&mut rt, "sign-in-go");
    land(&mut rt);
    assert!(calls()[0].starts_with("POST /sign-in/code {\"code\":\"K7Q2M9XH\""), "{:?}", calls());
    assert!(!rt.state.signed_out);
    assert_eq!(rt.state.screen, Screen::Library);
    let saved = std::fs::read_to_string(dir.join("config.json")).unwrap();
    assert!(saved.contains("made-up-key") && saved.contains(api::DEFAULT_URL), "{saved}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("config.json")).unwrap().permissions().mode() & 0o777, 0o600, "only this user reads the key");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_approval_request_shows_its_code_and_signs_in_once_approved() {
    let dir = std::env::temp_dir().join(format!("orbis-rune-test-{}", crate::playing::new_id()));
    api::config_here(dir.join("config.json"));
    let mut rt = runtime(App { signed_out: true, service: api::Service::Fixture, ..App::new() });
    rt.frame(0.0);
    fixture::reply("POST /sign-in/requests", json!({ "code": "482719", "expiresAt": "2027-01-15T08:02:00Z", "secret": "s3cret" }));
    fixture::reply("POST /sign-in/requests/wait", json!({ "status": "pending" }));
    rt.update(|s, _| s.sign_in_by(crate::account::Method::Approve));
    // A pending answer asks again at once, as a long poll does: land them one at a time.
    for _ in 0..3 {
        api::settle_one(&mut rt.state);
    }
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(shows(&rt, "approval-code"), "the code shows while it waits");
    fixture::reply("POST /sign-in/requests/wait", json!({ "status": "approved", "key": "made-up-key", "person": { "id": "u-me", "username": "avery" } }));
    answer_reloads();
    while rt.state.signed_out && api::settle_one(&mut rt.state) {}
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(!rt.state.signed_out, "approved: signed in");
    assert!(fixture::bodies("POST /sign-in/requests/wait").iter().all(|b| b["secret"] == "s3cret"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn signing_out_removes_this_devices_key_and_shows_sign_in() {
    let dir = std::env::temp_dir().join(format!("orbis-rune-test-{}", crate::playing::new_id()));
    api::config_here(dir.join("config.json"));
    let mut rt = live(Screen::Settings);
    fixture::reply("GET /me/devices", json!({ "devices": [{ "id": "d-here", "label": "Orbis for Linux", "addedAt": "2026-09-14T10:00:00Z", "lastUsedAt": null, "current": true }] }));
    fixture::reply("DELETE /me/devices/d-here", json!({ "id": "d-here", "label": "Orbis for Linux", "addedAt": "2026-09-14T10:00:00Z", "lastUsedAt": null, "current": true }));
    rt.update(|s, _| s.dialog = Some(crate::dialogs::Dialog::SignOut));
    rt.frame(1.0 / 60.0);
    press(&mut rt, "dialog-save");
    land(&mut rt);
    assert!(calls().contains(&"DELETE /me/devices/d-here".to_owned()), "{:?}", calls());
    assert!(rt.state.signed_out);
    assert!(shows(&rt, "sign-in"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn presence_plays_then_pauses_with_the_generation_orbis_gave() {
    let mut rt = live(Screen::Library);
    fixture::reply(
        "POST /presence/actions",
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 1, "ownerGeneration": 7, "sessionId": "x", "setId": "s-sunrise", "leaseExpiresAt": "2027-01-15T08:00:30Z" } }),
    );
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    let sent = fixture::bodies("POST /presence/actions");
    assert_eq!(sent.iter().map(|b| b["kind"].as_str().unwrap_or_default()).collect::<Vec<_>>(), ["play", "pause"], "{sent:?}");
    assert_eq!((sent[0]["setId"].as_str(), sent[0]["actionNumber"].as_u64()), (Some("s-sunrise"), Some(1)));
    assert_eq!((sent[1]["ownerGeneration"].as_u64(), sent[1]["actionNumber"].as_u64()), (Some(7), Some(2)));
    assert_eq!(sent[0]["sessionId"], sent[1]["sessionId"], "one session for the Set");
}

#[test]
fn playback_reports_go_out_in_order_and_a_refused_batch_is_named_lost() {
    let mut rt = live(Screen::Library);
    fixture::refuse_with("POST /diagnostics/playback", 400, "bad batch");
    rt.key(space());
    // Rune runs a key's handler after that frame's poll, so the batch's 5 s start on the next.
    rt.frame(1.0 / 60.0);
    rt.frame(6.0);
    rt.frame(1.0 / 60.0);
    let first = fixture::bodies("POST /diagnostics/playback");
    assert_eq!(first.len(), 1, "one batch after 5 s");
    let batch = &first[0];
    assert_eq!((batch["schemaVersion"].as_u64(), batch["metadata"]["client"].as_str()), (Some(1), Some("rune")));
    let sequences: Vec<u64> = batch["entries"].as_array().unwrap().iter().map(|e| e["sequence"].as_u64().unwrap()).collect();
    assert!(sequences.windows(2).all(|w| w[0] < w[1]) && sequences[0] == 1, "{sequences:?}");
    assert!(batch.to_string().find("Sunrise").is_none(), "no titles leave the app");
    fixture::reply("POST /diagnostics/playback", json!({ "accepted": 1, "rejected": 0 }));
    land(&mut rt);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    rt.frame(6.0);
    rt.frame(1.0 / 60.0);
    let sent = fixture::bodies("POST /diagnostics/playback");
    let second = sent.last().unwrap();
    assert_eq!(second["lost"][0]["afterSequence"].as_u64(), Some(0));
    assert_eq!(second["lost"][0]["throughSequence"].as_u64(), sequences.last().copied(), "the refused entries are named lost: {second}");
    assert_eq!(second["entries"][0]["sequence"].as_u64(), Some(sequences.last().unwrap() + 1));
}

#[test]
fn another_devices_queue_change_and_the_groups_listening_show_at_once() {
    let mut rt = live(Screen::Queue);
    let queue: crate::model::Queue = serde_json::from_value(json!({ "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] })).unwrap();
    rt.update(|s, _| s.heard_live(api::events::Event::Queue { queue }));
    let presence: Vec<crate::model::Presence> = serde_json::from_value(json!([{ "personId": "u-mira", "username": "mira", "set": set_json("s-low-tide", "Low Tide Dub") }])).unwrap();
    rt.update(|s, _| s.heard_live(api::events::Event::Presence { presence }));
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().entries.len(), 1);
    assert!(shows(&rt, "set-s-ferry") && !shows(&rt, "set-s-static"), "the queue shows the new order");
    assert!(shows(&rt, "listening-u-mira"), "the sidebar shows who is listening");
}

#[test]
fn an_sse_stream_reads_as_events() {
    let line = r#"{"kind":"changed","topic":"listen-history"}"#;
    assert_eq!(serde_json::from_str::<api::events::Event>(line).unwrap(), api::events::Event::Changed { topic: api::events::Topic::ListenHistory });
    let heartbeat: api::events::Event = serde_json::from_str(r#"{"kind":"heartbeat"}"#).unwrap();
    assert_eq!(heartbeat, api::events::Event::Heartbeat);
}

#[test]
fn a_late_completion_answer_leaves_the_set_the_person_started_since() {
    let mut rt = live(Screen::Playing);
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub")] } }));
    fixture::reply("GET /sets/s-low-tide/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] } }));
    // The Set ends; before Orbis answers, the person plays another one.
    rt.update(|s, _| s.next());
    rt.update(|s, _| s.play("s-ferry"));
    land(&mut rt);
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-ferry"), "the old answer doesn't take over");
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().active_set_id.as_deref(), Some("s-ferry"));
}

#[test]
fn trying_a_failed_set_again_resumes_where_the_person_was() {
    let mut rt = live(Screen::Playing);
    fixture::reply("GET /sets/s-sunrise/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| {
        s.playing.position = 2_000.0;
        s.playing.status = Status::Failed("The stream wouldn't play".to_owned());
    });
    rt.update(|s, _| s.toggle());
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.playing.status, Status::Playing);
    assert!((rt.state.playing.position - 2_000.0).abs() < 1.0, "not back at the opening place: {}", rt.state.playing.position);
}

#[test]
fn a_playlists_late_answer_leaves_the_set_the_person_started_since() {
    let mut rt = live(Screen::Library);
    fixture::reply("PUT /queue/playlist", json!({ "queue": { "activeSetId": "s-tram", "entries": [set_json("s-tram", "Tram Lines at Dawn")] } }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] } }));
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    // Play is pressed on a Playlist, then on a Set, before Orbis answers the first.
    rt.update(|s, _| s.play_playlist("p-morning", false));
    rt.update(|s, _| s.play("s-ferry"));
    land(&mut rt);
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-ferry"));
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().active_set_id.as_deref(), Some("s-ferry"));
}

#[test]
fn presence_refused_while_the_queue_catches_up_is_asked_again_once_it_has() {
    let mut rt = live(Screen::Playing);
    let accepted =
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 1, "ownerGeneration": 3, "sessionId": "x", "setId": "s-low-tide", "leaseExpiresAt": "2027-01-15T08:00:30Z" } });
    fixture::reply("GET /sets/s-low-tide/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub")] } }));
    // The next Set starts before Orbis has heard the last one ended, so its play is refused.
    fixture::refuse_with("POST /presence/actions", 409, "The queue changed");
    rt.update(|s, _| s.next());
    fixture::reply("POST /presence/actions", accepted);
    land(&mut rt);
    let plays: Vec<Value> = fixture::bodies("POST /presence/actions").into_iter().filter(|b| b["kind"] == "play" && b["setId"] == "s-low-tide").collect();
    assert_eq!(plays.len(), 2, "asked again once the completion landed: {plays:?}");
    assert_ne!(plays[0]["actionNumber"], plays[1]["actionNumber"]);
}

#[test]
fn a_stream_that_ends_early_keeps_the_place_and_ends_the_set_only_the_second_time() {
    use crate::audio::Event;
    let mut rt = live(Screen::Playing);
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    rt.key(space());
    rt.frame(1.0 / 60.0);
    let generation = rt.state.playing.generation();
    let at = rt.state.playing.position;
    rt.update(move |s, _| s.heard(generation, Event::Ended));
    land(&mut rt);
    assert!(matches!(rt.state.playing.status, Status::Failed(_)), "{:?}", rt.state.playing.status);
    assert!(!calls().iter().any(|c| c.starts_with("POST /queue/completion")), "no Finish: {:?}", calls());
    assert!((rt.state.playing.position - at).abs() < 1.0, "the place stays");
    // Play again; the stream ends at the same place: now the Set is over.
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    rt.update(|s, _| s.toggle());
    rt.frame(1.0 / 60.0);
    let generation = rt.state.playing.generation();
    rt.update(move |s, _| {
        s.playing.position = at;
        s.heard(generation, Event::Ended);
    });
    land(&mut rt);
    assert!(calls().iter().any(|c| c.starts_with("POST /queue/completion")), "{:?}", calls());
}

#[test]
fn leaving_approve_before_its_code_arrives_lets_a_sign_in_code_go() {
    let mut rt = runtime(App { signed_out: true, service: api::Service::Fixture, ..App::new() });
    rt.frame(0.0);
    rt.update(|s, _| s.sign_in_by(crate::account::Method::Approve));
    rt.update(|s, _| {
        s.sign_in_by(crate::account::Method::Code);
        s.account.signin.code = rune::TextEdit::new("ABCD EFGH");
    });
    rt.frame(1.0 / 60.0);
    api::settle(&mut rt.state);
    rt.update(|s, _| s.redeem_code());
    assert!(calls().iter().any(|c| c.starts_with("POST /sign-in/code")), "{:?}", calls());
}

#[test]
fn of_two_playlists_pressed_quickly_the_second_plays_whichever_answer_comes_first() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/playlist", json!({ "queue": { "activeSetId": "s-tram", "entries": [set_json("s-tram", "Tram Lines at Dawn")] } }));
    rt.update(|s, _| s.play_playlist("p-morning", false));
    fixture::reply("PUT /queue/playlist", json!({ "queue": { "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] } }));
    rt.update(|s, _| s.play_playlist("p-road", false));
    land(&mut rt);
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-ferry"), "the newer Playlist wins");
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().active_set_id.as_deref(), Some("s-ferry"));
}

#[test]
fn trying_again_after_orbis_refused_a_play_asks_it_to_make_the_set_active_again() {
    let mut rt = live(Screen::Playing);
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::refuse("PUT /queue/active", "Orbis answered 503");
    rt.update(|s, _| s.play("s-ferry"));
    land(&mut rt);
    assert!(matches!(rt.state.playing.status, Status::Failed(_)));
    rt.update(|s, _| s.playing.position = 600.0);
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] } }));
    rt.update(|s, _| s.toggle());
    land(&mut rt);
    let asks = calls().iter().filter(|c| c.starts_with("PUT /queue/active")).count();
    assert_eq!(asks, 2, "Orbis is asked again: {:?}", calls());
    assert_eq!(rt.state.playing.status, Status::Playing);
    assert!((rt.state.playing.position - 600.0).abs() < 1.0, "from where the person was: {}", rt.state.playing.position);
}

#[test]
fn playing_a_set_from_outside_the_queue_puts_it_before_the_one_it_interrupts() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| s.play("s-tram"));
    let order: Vec<String> = rt.state.queue.items.data.as_ref().unwrap().entries.iter().map(|x| x.id.clone()).collect();
    assert_eq!(order[..3], ["s-tram", "s-sunrise", "s-low-tide"], "as Orbis's placedBefore: {order:?}");
    let mut empty = crate::model::Queue { active_set_id: None, entries: vec![crate::model::Set { id: "a".into(), ..Default::default() }] };
    empty.activate(&crate::model::Set { id: "b".into(), ..Default::default() });
    assert_eq!(empty.entries.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a", "b"], "with nothing active it goes at the end");
}

#[test]
fn an_answer_from_before_a_sign_out_lands_nowhere() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets", json!({ "sets": [set_json("s-theirs", "The Other Account's Set")] }));
    rt.update(|s, _| s.reload_library());
    rt.update(|s, _| s.forget_account());
    land(&mut rt);
    assert!(rt.state.signed_out);
    assert!(rt.state.library.sets.data.is_none(), "the old account's Library didn't land: {:?}", rt.state.library.sets.data);
}

#[test]
fn another_device_making_a_set_active_moves_an_idle_player_to_it() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-sunrise/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| {
        s.playing = Default::default();
        s.queue_landed();
    });
    let queue: crate::model::Queue = serde_json::from_value(json!({ "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] })).unwrap();
    rt.update(|s, _| s.heard_live(api::events::Event::Queue { queue }));
    land(&mut rt);
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-ferry"), "the idle player follows Orbis's active Set");
}

#[test]
fn a_paused_set_another_device_replaced_asks_orbis_again_on_play() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-sunrise/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-sunrise", "entries": [set_json("s-sunrise", "Sunrise on the Pier")] } }));
    rt.update(|s, _| {
        s.playing = Default::default();
        s.queue_landed();
        s.toggle();
        s.toggle();
    });
    land(&mut rt);
    assert_eq!(rt.state.playing.status, Status::Paused);
    let queue: crate::model::Queue = serde_json::from_value(json!({ "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] })).unwrap();
    rt.update(|s, _| s.heard_live(api::events::Event::Queue { queue }));
    rt.update(|s, _| s.toggle());
    land(&mut rt);
    assert!(calls().iter().any(|c| c.starts_with("PUT /queue/active {\"setId\":\"s-sunrise\"}")), "{:?}", calls());
}

#[test]
fn playback_reports_go_out_again_after_signing_out_mid_batch_and_back_in() {
    let mut rt = live(Screen::Library);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    rt.frame(6.0);
    assert_eq!(fixture::bodies("POST /diagnostics/playback").len(), 1, "a batch is out");
    rt.update(|s, _| s.forget_account());
    land(&mut rt);
    fixture::reply("POST /diagnostics/playback", json!({ "accepted": 1, "rejected": 0 }));
    rt.update(|s, _| {
        s.signed_out = false;
        s.playing.demo(crate::model::Set { id: "s-x".into(), duration_seconds: Some(600.0), ..Default::default() }, 0.0, Status::Paused, None);
    });
    rt.key(space());
    rt.frame(1.0 / 60.0);
    rt.frame(6.0);
    rt.frame(1.0 / 60.0);
    assert_eq!(fixture::bodies("POST /diagnostics/playback").len(), 2, "delivery isn't stuck on the old account's batch");
}

#[test]
fn next_before_a_plays_answer_completes_that_set_only_after_orbis_made_it_active() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("GET /sets/s-sunrise/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-tram", "entries": [set_json("s-tram", "Tram Lines at Dawn"), set_json("s-sunrise", "Sunrise on the Pier")] } }));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": "s-sunrise", "entries": [set_json("s-sunrise", "Sunrise on the Pier")] } }));
    rt.update(|s, _| s.play("s-tram"));
    rt.update(|s, _| s.next());
    assert!(!calls().iter().any(|c| c.starts_with("POST /queue/completion")), "held while the activation is out: {:?}", calls());
    land(&mut rt);
    let sent = calls();
    let active = sent.iter().position(|c| c.starts_with("PUT /queue/active")).unwrap();
    let done = sent.iter().position(|c| c.starts_with("POST /queue/completion {\"setId\":\"s-tram\"}")).expect("the completion goes out");
    assert!(done > active, "{sent:?}");
}

#[test]
fn a_tracklist_answer_for_the_set_shown_before_never_lands_under_the_next() {
    let mut rt = live(Screen::Library);
    fixture::reply(
        "GET /sets/s-sunrise/tracklist",
        json!({ "cues": [{ "artist": "A", "title": "Old Cue", "startSeconds": 10, "position": 0, "appleMusicId": null, "artworkUrl": null }], "state": "ready" }),
    );
    fixture::reply(
        "GET /sets/s-ferry/tracklist",
        json!({ "cues": [{ "artist": "B", "title": "New Cue", "startSeconds": 20, "position": 0, "appleMusicId": null, "artworkUrl": null }], "state": "ready" }),
    );
    rt.update(|s, _| {
        s.playing = Default::default();
        s.queue_landed();
    });
    let queue: crate::model::Queue = serde_json::from_value(json!({ "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] })).unwrap();
    rt.update(|s, _| s.heard_live(api::events::Event::Queue { queue }));
    // Sunrise's answer lands while Night Ferry's is still out.
    api::settle_one(&mut rt.state);
    let titles = |rt: &Runtime<App>| rt.state.playing.tracklist.data.as_ref().map(|t| t.cues.iter().map(|c| c.title.clone()).collect::<Vec<_>>());
    assert_eq!(titles(&rt), None, "Sunrise's Cues never show under Night Ferry");
    land(&mut rt);
    assert_eq!(titles(&rt), Some(vec!["New Cue".to_owned()]));
}

#[test]
fn two_sets_added_to_one_playlist_quickly_both_stay() {
    let mut rt = live(Screen::Library);
    let detail = |ids: &[&str]| json!({ "id": "p-road", "name": "Road Trip", "setCount": ids.len(), "creator": { "id": "u-me", "username": "avery" }, "role": "creator", "sets": ids.iter().map(|id| set_json(id, id)).collect::<Vec<_>>() });
    fixture::reply("GET /playlists/p-road", detail(&["s-a"]));
    fixture::reply("PUT /playlists/p-road/sets", json!({ "sets": [] }));
    answer_reloads();
    rt.update(|s, _| {
        s.toggle_in_playlist("s-b", "p-road");
        s.toggle_in_playlist("s-c", "p-road");
    });
    assert_eq!(fixture::bodies("PUT /playlists/p-road/sets").len(), 1, "the second waits for the first");
    // Orbis now holds what the first change wrote.
    fixture::reply("GET /playlists/p-road", detail(&["s-a", "s-b"]));
    land(&mut rt);
    let puts = fixture::bodies("PUT /playlists/p-road/sets");
    assert_eq!(puts.last().unwrap()["setIds"], json!(["s-a", "s-b", "s-c"]), "{puts:?}");
}

#[test]
fn a_full_report_queue_evicts_around_the_batch_in_flight_and_acks_by_sequence() {
    let mut rt = live(Screen::Library);
    fixture::reply("POST /diagnostics/playback", json!({ "accepted": 32, "rejected": 0 }));
    rt.update(|s, _| {
        for _ in 0..1024 {
            let snapshot = s.playing.snapshot();
            s.record_playback(json!({ "sample": {} }), snapshot);
        }
    });
    rt.frame(1.0 / 60.0);
    rt.frame(6.0);
    let first = fixture::bodies("POST /diagnostics/playback");
    assert_eq!(first.len(), 1);
    let last = first[0]["throughSequence"].as_u64().unwrap();
    // One more entry while the batch is out: the queue is full.
    rt.update(|s, _| {
        let snapshot = s.playing.snapshot();
        s.record_playback(json!({ "sample": {} }), snapshot);
    });
    land(&mut rt);
    rt.frame(6.0);
    rt.frame(1.0 / 60.0);
    let sent = fixture::bodies("POST /diagnostics/playback");
    let next = &sent[1];
    assert_eq!(next["lost"][0]["afterSequence"].as_u64(), Some(last), "the entry after the batch was evicted, not one in it: {}", next["lost"]);
    assert_eq!(next["lost"][0]["throughSequence"].as_u64(), Some(last + 1));
    assert_eq!(next["entries"][0]["sequence"].as_u64(), Some(last + 2), "nothing unsent was dropped");
}

#[test]
fn a_renewal_refused_after_the_lease_ran_out_plays_the_session_again() {
    let mut rt = live(Screen::Library);
    fixture::reply(
        "POST /presence/actions",
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 1, "ownerGeneration": 7, "sessionId": "x", "setId": "s-sunrise", "leaseExpiresAt": "2027-01-15T08:00:30Z" } }),
    );
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    // Orbis is out of reach past the 30 s lease: renewals fail, then it has paused the session
    // and refuses the next one.
    fixture::refuse_with("POST /presence/actions", 503, "unavailable");
    for _ in 0..2 {
        rt.frame(16.0);
        rt.frame(1.0 / 60.0);
        land(&mut rt);
    }
    fixture::refuse_with("POST /presence/actions", 409, "stale");
    rt.frame(16.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    let sent = fixture::bodies("POST /presence/actions");
    let kinds: Vec<&str> = sent.iter().map(|b| b["kind"].as_str().unwrap_or_default()).collect();
    let renew = kinds.iter().rposition(|k| *k == "renew").expect("a renewal went out");
    assert_eq!(kinds.get(renew + 1), Some(&"play"), "the session plays again: {kinds:?}");
    assert_eq!(sent[renew + 1]["sessionId"], sent[0]["sessionId"]);
}

#[test]
fn a_late_position_save_never_lands_after_the_completion_reset() {
    let mut rt = live(Screen::Library);
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    rt.key(space());
    rt.frame(1.0 / 60.0);
    rt.update(|s, _| {
        s.playing.position = 1_800.0;
        s.toggle();
        s.next();
    });
    let order: Vec<String> = calls().into_iter().filter(|c| c.contains("/position") || c.contains("/queue/completion")).collect();
    assert_eq!(order.len(), 1, "the reset waits for the save before it: {order:?}");
    land(&mut rt);
    let order: Vec<String> = calls().into_iter().filter(|c| c.contains("/position") || c.contains("/queue/completion")).collect();
    assert_eq!(order, ["PUT /sets/s-sunrise/position {\"seconds\":1800.0}", "PUT /sets/s-sunrise/position {\"seconds\":0.0}", "POST /queue/completion {\"setId\":\"s-sunrise\"}"]);
}

#[test]
fn next_partway_starts_the_set_over_next_time_it_plays() {
    let mut rt = live(Screen::Library);
    let mut reset = set_json("s-sunrise", "Sunrise on the Pier");
    reset["playbackPositionSeconds"] = json!(0);
    fixture::reply("PUT /sets/s-sunrise/position", reset);
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    assert!(rt.state.find_set("s-sunrise").unwrap().playback_position_seconds > 0.0);
    rt.update(|s, _| s.next());
    land(&mut rt);
    let library = rt.state.library.sets.data.as_ref().unwrap().iter().find(|x| x.id == "s-sunrise").unwrap();
    assert_eq!(library.playback_position_seconds, 0.0, "the Library's copy starts over too");
}

#[test]
fn artwork_still_loads_after_signing_out_while_fetches_were_out() {
    let mut rt = live(Screen::Library);
    rt.update(|s, _| {
        s.artwork.start(std::sync::Arc::new(|| {}));
        s.want_artwork(["https://a/1", "https://a/2", "https://a/3", "https://a/4"]);
    });
    assert_eq!(rt.state.artwork.fetching(), 4);
    rt.update(|s, _| s.forget_account());
    land(&mut rt);
    rt.update(|s, _| s.want_artwork(["https://a/5"]));
    assert_eq!(rt.state.artwork.fetching(), 1, "the old account's fetches hold no slots");
}

#[test]
fn work_keeps_the_key_it_started_with_through_an_account_switch() {
    let a = api::Server { url: "https://a.example".into(), key: "key-a".into() };
    let b = api::Server { url: "https://b.example".into(), key: "key-b".into() };
    let mut s = App { service: api::Service::Fixture, ..App::new() };
    s.session = 7;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = std::sync::Arc::clone(&seen);
    let (first, then) = (a.clone(), b.clone());
    api::with_server(Some(first), || {
        s.spawn(
            move || {
                log.lock().unwrap().push(api::Server::for_call().map(|x| x.key));
                // Signing out and in as another account while this work runs.
                then.connect();
                log.lock().unwrap().push(api::Server::for_call().map(|x| x.key));
            },
            |_, ()| {},
        );
    });
    assert_eq!(*seen.lock().unwrap(), [Some("key-a".to_owned()), Some("key-a".to_owned())], "every request in the work speaks as A");
}

#[test]
fn an_idle_set_never_started_here_takes_the_place_another_device_reached() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-sunrise/tracklist", json!({ "cues": [], "state": "none" }));
    rt.update(|s, _| {
        s.playing = Default::default();
        s.queue_landed();
    });
    let mut moved = set_json("s-sunrise", "Sunrise on the Pier");
    (moved["playbackPositionSeconds"], moved["durationSeconds"]) = (json!(2_000), json!(3_492));
    fixture::reply("GET /sets", json!({ "sets": [moved] }));
    rt.update(|s, _| s.reload_library());
    land(&mut rt);
    rt.update(|s, _| s.toggle());
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.playing.status, Status::Playing);
    assert!((rt.state.playing.position - 2_000.0).abs() < 1.0, "from the other device's place: {}", rt.state.playing.position);
}

#[test]
fn a_renewal_refused_inside_the_lease_leaves_the_set_to_the_device_that_took_it() {
    let mut rt = live(Screen::Library);
    fixture::reply(
        "POST /presence/actions",
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 1, "ownerGeneration": 7, "sessionId": "x", "setId": "s-sunrise", "leaseExpiresAt": "2027-01-15T08:00:30Z" } }),
    );
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    // Another device played this Set: Orbis superseded this session well inside its lease.
    fixture::refuse_with("POST /presence/actions", 409, "stale");
    for _ in 0..3 {
        rt.frame(16.0);
        rt.frame(1.0 / 60.0);
        land(&mut rt);
    }
    let kinds: Vec<String> = fixture::bodies("POST /presence/actions").iter().map(|b| b["kind"].as_str().unwrap_or_default().to_owned()).collect();
    assert_eq!(kinds, ["play", "renew"], "no play to take it back, and no more renewals");
}

#[test]
fn a_pending_tracklist_is_asked_again_until_orbis_has_it() {
    let mut rt = live(Screen::Playing);
    fixture::reply("GET /sets/s-ferry/tracklist", json!({ "cues": [], "state": "pending" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-ferry", "entries": [set_json("s-ferry", "Night Ferry")] } }));
    rt.update(|s, _| s.play("s-ferry"));
    land(&mut rt);
    fixture::reply(
        "GET /sets/s-ferry/tracklist",
        json!({ "cues": [{ "artist": "B", "title": "Found Cue", "startSeconds": 0, "position": 0, "appleMusicId": null, "artworkUrl": null }], "state": "ready" }),
    );
    rt.frame(11.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    let cues = rt.state.playing.tracklist.data.as_ref().map(|t| t.cues.len());
    assert_eq!(cues, Some(1), "the found Tracklist shows: {:?}", calls());
    let asks = calls().iter().filter(|c| *c == "GET /sets/s-ferry/tracklist").count();
    rt.frame(30.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    assert_eq!(calls().iter().filter(|c| *c == "GET /sets/s-ferry/tracklist").count(), asks, "a ready Tracklist isn't asked again");
}

#[test]
fn a_presence_play_lost_to_a_passing_outage_is_tried_again() {
    let mut rt = live(Screen::Library);
    fixture::refuse_with("POST /presence/actions", 503, "unavailable");
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    fixture::reply(
        "POST /presence/actions",
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 2, "ownerGeneration": 4, "sessionId": "x", "setId": "s-sunrise", "leaseExpiresAt": "2027-01-15T08:00:30Z" } }),
    );
    rt.frame(16.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    let plays = fixture::bodies("POST /presence/actions").into_iter().filter(|b| b["kind"] == "play").count();
    assert_eq!(plays, 2, "tried again while the Set plays");
}

#[test]
fn a_small_playlists_cover_fetches_the_large_artwork_it_draws() {
    let mut rt = live(Screen::Library);
    let mut one = set_json("s-ferry", "Night Ferry");
    (one["artworkUrl"], one["artworkLargeUrl"]) = (json!("https://art/small"), json!("https://art/large"));
    fixture::reply("GET /playlists/p-solo", json!({ "id": "p-solo", "name": "Solo", "setCount": 1, "creator": { "id": "u-me", "username": "avery" }, "role": "creator", "sets": [one] }));
    rt.update(|s, _| {
        s.artwork.start(std::sync::Arc::new(|| {}));
        s.open_playlist("p-solo");
    });
    land(&mut rt);
    assert!(rt.state.artwork.asked("https://art/small"), "the row's thumbnail");
    assert!(rt.state.artwork.asked("https://art/large"), "the cover's large picture");
}

#[test]
fn download_works_for_a_set_seen_only_in_a_collaborative_playlist() {
    let mut rt = live(Screen::Library);
    let mut theirs = set_json("s-theirs", "Their Set");
    theirs["downloadState"] = json!("none");
    fixture::reply(
        "GET /playlists/p-road",
        json!({ "id": "p-road", "name": "Road Trip", "setCount": 1, "creator": { "id": "u-mira", "username": "mira" }, "role": "editor", "sets": [theirs.clone()] }),
    );
    rt.update(|s, _| s.open_playlist("p-road"));
    land(&mut rt);
    let mut queued = theirs;
    queued["downloadState"] = json!("queued");
    fixture::reply("POST /sets/s-theirs/audio/download", queued);
    rt.update(|s, _| s.download("s-theirs"));
    assert!(calls().iter().any(|c| c == "POST /sets/s-theirs/audio/download"), "{:?}", calls());
    let shown = rt.state.playlists.open.data.as_ref().unwrap().sets[0].download_state;
    assert_eq!(shown, crate::model::Download::Queued, "the row says so at once");
}

#[test]
fn reconnecting_reloads_the_open_playlist() {
    let mut rt = live(Screen::Playlist("p-morning".to_owned()));
    rt.update(|s, _| {
        s.heard_live(api::events::Event::Connected(false));
        s.heard_live(api::events::Event::Connected(true));
    });
    assert!(calls().iter().any(|c| c == "GET /playlists/p-morning"), "{:?}", calls());
}
