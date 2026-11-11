//! The Library and Playlists: saving links, Tags, Downloads, Playlist membership and covers.

use serde_json::json;

use super::*;
use crate::Screen;
use crate::api::{self, fixture};
use crate::playing::Status;

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

#[test]
fn a_set_change_reloads_the_open_playlist_too() {
    let mut rt = live(Screen::Playlist("p-morning".to_owned()));
    rt.update(|s, _| s.heard_live(api::events::Event::Changed { topic: api::events::Topic::Set }));
    assert!(calls().iter().any(|c| c == "GET /playlists/p-morning"), "{:?}", calls());
}

#[test]
fn an_open_playlist_with_a_download_running_checks_again_until_it_ends() {
    let mut rt = live(Screen::Library);
    let mut theirs = set_json("s-theirs", "Their Set");
    theirs["downloadState"] = json!("downloading");
    fixture::reply("GET /playlists/p-road", json!({ "id": "p-road", "name": "Road Trip", "setCount": 1, "creator": { "id": "u-mira", "username": "mira" }, "role": "editor", "sets": [theirs] }));
    rt.update(|s, _| s.open_playlist("p-road"));
    land(&mut rt);
    let reads = || calls().iter().filter(|c| *c == "GET /playlists/p-road").count();
    assert_eq!(reads(), 1);
    rt.frame(11.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    assert_eq!(reads(), 2, "checked again while the download runs");
}

#[test]
fn another_sign_in_code_can_be_made_after_the_first() {
    let mut rt = live(Screen::Library);
    fixture::reply("POST /me/sign-in-codes", json!({ "code": "K7Q2M9XH", "expiresAt": "2027-01-15T08:10:00Z" }));
    fixture::reply("GET /me/devices", json!({ "devices": [] }));
    fixture::reply("GET /me", json!({ "id": "u-me", "username": "avery", "autoDownload": true, "social": true, "host": false }));
    rt.update(|s, _| s.open_settings());
    rt.update(|s, _| s.new_sign_in_code());
    land(&mut rt);
    still(&mut rt);
    assert!(shows(&rt, "sign-in-code-shown"));
    press(&mut rt, "new-sign-in-code");
    let made = calls().iter().filter(|c| *c == "POST /me/sign-in-codes").count();
    assert_eq!(made, 2, "a new code beside the one shown");
    land(&mut rt);
    rt.frame(601.0);
    rt.frame(1.0 / 60.0);
    assert!(rt.state.account.code.data.is_none(), "the code leaves once Orbis has expired it");
    rt.update(|s, _| s.new_sign_in_code());
    land(&mut rt);
    rt.update(|s, _| s.open_settings());
    assert!(rt.state.account.code.data.is_none(), "reopening Settings starts without the old code");
}
