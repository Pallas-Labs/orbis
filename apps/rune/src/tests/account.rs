//! The account and the Group: signing in and out, sessions, Presence, playback reports and live events.

use rune::Runtime;
use serde_json::{Value, json};

use super::*;
use crate::api::{self, fixture};
use crate::goldens::runtime;
use crate::playing::Status;
use crate::{App, Screen};

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
fn pausing_and_resuming_keeps_one_renewal_going() {
    let mut rt = live(Screen::Library);
    fixture::reply(
        "POST /presence/actions",
        json!({ "outcome": "accepted", "session": { "state": "playing", "actionNumber": 1, "ownerGeneration": 7, "sessionId": "x", "setId": "s-sunrise", "leaseExpiresAt": "2027-01-15T08:00:30Z" } }),
    );
    for _ in 0..3 {
        rt.key(space());
        rt.frame(1.0 / 60.0);
        land(&mut rt);
        rt.frame(2.0);
    }
    let renewals = |rt: &Runtime<App>| {
        let _ = rt;
        fixture::bodies("POST /presence/actions").iter().filter(|b| b["kind"] == "renew").count()
    };
    let before = renewals(&rt);
    rt.frame(15.0);
    rt.frame(1.0 / 60.0);
    land(&mut rt);
    assert_eq!(renewals(&rt) - before, 1, "one renewal each 15 s, not one per resume");
}
