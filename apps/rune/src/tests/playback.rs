//! Playback: play, pause, the queue, Next, the end of a Set, Tracklists and resume points.

use rune::Runtime;
use serde_json::json;

use super::*;
use crate::api::{self, fixture};
use crate::playing::Status;
use crate::{App, Screen};

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
fn a_position_save_carries_the_time_zone_the_app_found() {
    let mut rt = live(Screen::Library);
    crate::clock::zone_here(Some("Europe/Berlin"));
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    rt.key(space());
    rt.frame(1.0 / 60.0);
    rt.update(|s, _| {
        s.playing.position = 1_800.0;
        s.toggle();
    });
    land(&mut rt);
    assert_eq!(fixture::bodies("PUT /sets/s-sunrise/position"), [json!({ "seconds": 1800.0, "timeZone": "Europe/Berlin" })]);
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
fn next_on_the_last_set_before_its_play_answers_still_completes_it_after() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-tram/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-tram", "entries": [set_json("s-tram", "Tram Lines at Dawn")] } }));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    rt.update(|s, _| {
        if let Some(q) = s.queue.items.data.as_mut() {
            q.entries.clear();
            q.active_set_id = None;
        }
        s.play("s-tram");
        s.next();
    });
    assert!(!calls().iter().any(|c| c.starts_with("POST /queue/completion")), "held while the activation is out: {:?}", calls());
    land(&mut rt);
    let sent = calls();
    let active = sent.iter().position(|c| c.starts_with("PUT /queue/active")).unwrap();
    let done = sent.iter().position(|c| c.starts_with("POST /queue/completion {\"setId\":\"s-tram\"}")).expect("the completion goes out");
    assert!(done > active, "{sent:?}");
}

#[test]
fn of_two_sets_picked_quickly_orbis_hears_them_in_order_and_ends_on_the_second() {
    let mut rt = live(Screen::Library);
    for id in ["s-ferry", "s-tram", "s-static"] {
        fixture::reply(&format!("GET /sets/{id}/tracklist"), json!({ "cues": [], "state": "none" }));
    }
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-static", "entries": [set_json("s-static", "Salt and Static")] } }));
    rt.update(|s, _| {
        s.play("s-ferry");
        s.play("s-tram");
        s.play("s-static");
    });
    let asked = |rt: &Runtime<App>| {
        let _ = rt;
        calls().into_iter().filter(|c| c.starts_with("PUT /queue/active")).collect::<Vec<_>>()
    };
    assert_eq!(asked(&rt), ["PUT /queue/active {\"setId\":\"s-ferry\"}"], "one at a time");
    land(&mut rt);
    assert_eq!(asked(&rt).last().map(String::as_str), Some("PUT /queue/active {\"setId\":\"s-static\"}"), "the newest goes last: {:?}", asked(&rt));
    assert!(!asked(&rt).iter().any(|c| c.contains("s-tram")), "a choice already replaced isn't sent");
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-static"));
}

/// Sets Orbis to answer the playing Set's end with the queue that names Low Tide Dub next.
fn answer_the_end() {
    fixture::reply("PUT /sets/s-sunrise/position", set_json("s-sunrise", "Sunrise on the Pier"));
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub")] } }));
    fixture::reply("GET /sets/s-low-tide/tracklist", json!({ "cues": [], "state": "none" }));
}

/// Moves Rune's clock on `seconds`, and lands what the timers due by then sent.
fn wait(rt: &mut Runtime<App>, seconds: f64) {
    rt.frame(seconds);
    land(rt);
}

fn completions() -> usize {
    calls().iter().filter(|c| c.starts_with("POST /queue/completion")).count()
}

#[test]
fn a_completion_orbis_refused_with_503_is_sent_again_and_the_next_set_plays() {
    let mut rt = live(Screen::Playing);
    answer_the_end();
    fixture::refuse_once("POST /queue/completion", Some(503), "Orbis answered 503");
    rt.update(|s, _| s.next());
    land(&mut rt);
    assert_eq!(completions(), 1);
    assert_eq!(rt.state.toast, None, "nothing is said while a try is left");
    wait(&mut rt, 1.0);
    assert_eq!(completions(), 2, "sent again after a second: {:?}", calls());
    assert_eq!(rt.state.queue.items.data.as_ref().unwrap().active_set_id.as_deref(), Some("s-low-tide"), "the queue Orbis sent back lands");
    assert_eq!(rt.state.playing.set.as_ref().map(|x| x.id.as_str()), Some("s-low-tide"), "the next Set plays");
    wait(&mut rt, 8.0);
    assert_eq!(completions(), 2, "and not again");
    assert_eq!(rt.state.toast, None);
}

#[test]
fn a_completion_that_gets_no_answer_is_tried_four_times_then_the_person_is_told() {
    let mut rt = live(Screen::Playing);
    answer_the_end();
    for _ in 0..4 {
        fixture::refuse_once("POST /queue/completion", None, "Orbis didn't answer");
    }
    rt.update(|s, _| s.next());
    land(&mut rt);
    // The next Set moves on far enough to save its place: that write waits behind the completion.
    fixture::reply("PUT /sets/s-low-tide/position", set_json("s-low-tide", "Low Tide Dub"));
    rt.update(|s, _| s.playing.position += 20.0);
    for (wait_s, sent) in [(1.0, 2), (2.0, 3)] {
        wait(&mut rt, wait_s - 0.1);
        assert_eq!(completions(), sent - 1, "not before the wait is over");
        wait(&mut rt, 0.1);
        assert_eq!(completions(), sent);
        assert_eq!(rt.state.toast, None, "nothing is said while a try is left");
    }
    wait(&mut rt, 4.0);
    assert_eq!(completions(), 4, "{:?}", calls());
    let sent = calls();
    let last_try = sent.iter().rposition(|c| c.starts_with("POST /queue/completion")).unwrap();
    let save = sent.iter().position(|c| c.starts_with("PUT /sets/s-low-tide/position"));
    assert!(save.is_some_and(|at| at > last_try), "the later write goes out after the last try: {sent:?}");
    assert_eq!(rt.state.toast.as_deref(), Some("Orbis didn't hear that the Set ended: Orbis didn't answer"));
    wait(&mut rt, 8.0);
    assert_eq!(completions(), 4, "three more tries, no fourth");
}

#[test]
fn a_completion_orbis_refused_with_404_is_sent_once() {
    let mut rt = live(Screen::Playing);
    answer_the_end();
    fixture::refuse_once("POST /queue/completion", Some(404), "No such Set");
    rt.update(|s, _| s.next());
    land(&mut rt);
    assert_eq!(rt.state.toast.as_deref(), Some("Orbis didn't hear that the Set ended: No such Set"));
    wait(&mut rt, 8.0);
    assert_eq!(completions(), 1, "{:?}", calls());
}

fn position_saves() -> Vec<String> {
    calls().into_iter().filter(|c| c.starts_with("PUT /sets/s-sunrise/position")).collect()
}

/// Plays Sunrise on the Pier and pauses it at 1800 s, where Orbis answers that pause's save with
/// `status` (`None` is no answer) once, and stores 1830 s after that.
fn pause_at_1800(rt: &mut Runtime<App>, status: Option<u16>, why: &str) {
    let mut stored = set_json("s-sunrise", "Sunrise on the Pier");
    (stored["playbackPositionSeconds"], stored["durationSeconds"]) = (json!(1_830), json!(3_492));
    fixture::reply("PUT /sets/s-sunrise/position", stored);
    rt.key(space());
    rt.frame(1.0 / 60.0);
    land(rt);
    let before = position_saves().len();
    // Armed only now, so a save the start itself makes takes the stored answer.
    fixture::refuse_once("PUT /sets/s-sunrise/position", status, why);
    rt.update(|s, _| {
        s.playing.position = 1_800.0;
        s.toggle();
    });
    land(rt);
    assert_eq!(rt.state.playing.status, Status::Paused);
    assert_eq!(position_saves()[before..], ["PUT /sets/s-sunrise/position {\"seconds\":1800.0}"]);
}

/// The saves of Sunrise on the Pier after the pause at 1800 s.
fn saves_from_the_pause() -> Vec<String> {
    let saves = position_saves();
    let at = saves.iter().position(|c| c.ends_with("{\"seconds\":1800.0}")).expect("the pause's save");
    saves[at..].to_vec()
}

#[test]
fn a_paused_place_whose_save_got_no_answer_is_saved_again_in_order() {
    let mut rt = live(Screen::Library);
    pause_at_1800(&mut rt, None, "Orbis didn't answer");
    // While paused, the place moves: the save that goes again carries the place at that time.
    rt.update(|s, _| s.playing.position = 1_830.0);
    wait(&mut rt, 14.9);
    assert_eq!(saves_from_the_pause().len(), 1, "not before the wait is over");
    wait(&mut rt, 0.1);
    assert_eq!(saves_from_the_pause(), ["PUT /sets/s-sunrise/position {\"seconds\":1800.0}", "PUT /sets/s-sunrise/position {\"seconds\":1830.0}"]);
    assert_eq!(rt.state.playing.saved, 1_830.0, "the place last saved");
    let library = rt.state.library.sets.data.as_ref().unwrap().iter().find(|x| x.id == "s-sunrise").unwrap();
    assert_eq!(library.playback_position_seconds, 1_830.0, "what Orbis sent back lands");
    wait(&mut rt, 60.0);
    assert_eq!(saves_from_the_pause().len(), 2, "an answered save goes once");
}

#[test]
fn a_paused_place_orbis_refused_with_503_is_saved_again_until_it_answers() {
    let mut rt = live(Screen::Library);
    pause_at_1800(&mut rt, Some(503), "Orbis answered 503");
    fixture::refuse_once("PUT /sets/s-sunrise/position", Some(429), "Orbis answered 429");
    wait(&mut rt, 15.0);
    assert_eq!(saves_from_the_pause().len(), 2);
    wait(&mut rt, 15.0);
    assert_eq!(saves_from_the_pause().len(), 3, "a 429 goes again too: {:?}", calls());
    wait(&mut rt, 60.0);
    assert_eq!(saves_from_the_pause().len(), 3, "and stops once Orbis answers");
}

#[test]
fn a_save_that_waits_to_go_again_never_overtakes_a_completion_after_it() {
    let mut rt = live(Screen::Library);
    pause_at_1800(&mut rt, None, "Orbis didn't answer");
    fixture::reply("POST /queue/completion", json!({ "queue": { "activeSetId": null, "entries": [] } }));
    rt.update(|s, _| s.next());
    land(&mut rt);
    wait(&mut rt, 60.0);
    let all: Vec<String> = calls().into_iter().filter(|c| c.contains("/sets/s-sunrise/position") || c.contains("/queue/completion")).collect();
    let order = &all[all.iter().position(|c| c.ends_with("{\"seconds\":1800.0}")).unwrap()..];
    assert_eq!(
        order,
        ["PUT /sets/s-sunrise/position {\"seconds\":1800.0}", "PUT /sets/s-sunrise/position {\"seconds\":0.0}", "POST /queue/completion {\"setId\":\"s-sunrise\"}"],
        "the reset stays last"
    );
}

#[test]
fn a_paused_place_orbis_refused_with_404_is_saved_once() {
    let mut rt = live(Screen::Library);
    pause_at_1800(&mut rt, Some(404), "No such Set");
    wait(&mut rt, 60.0);
    assert_eq!(saves_from_the_pause().len(), 1, "{:?}", calls());
}

#[test]
fn a_save_that_got_no_answer_is_not_sent_again_after_sign_out() {
    let mut rt = live(Screen::Library);
    pause_at_1800(&mut rt, None, "Orbis didn't answer");
    rt.update(|s, _| s.forget_account());
    wait(&mut rt, 60.0);
    assert_eq!(saves_from_the_pause().len(), 1, "{:?}", calls());
}

#[test]
fn a_pause_whose_save_fails_while_another_set_waits_to_go_again_is_saved_again() {
    let mut rt = live(Screen::Library);
    fixture::reply("GET /sets/s-low-tide/tracklist", json!({ "cues": [], "state": "none" }));
    fixture::reply("PUT /queue/active", json!({ "queue": { "activeSetId": "s-low-tide", "entries": [set_json("s-low-tide", "Low Tide Dub")] } }));
    let mut stored = set_json("s-low-tide", "Low Tide Dub");
    (stored["playbackPositionSeconds"], stored["durationSeconds"]) = (json!(900), json!(3_492));
    fixture::reply("PUT /sets/s-low-tide/position", stored);
    pause_at_1800(&mut rt, None, "Orbis didn't answer");
    rt.update(|s, _| s.play("s-low-tide"));
    land(&mut rt);
    wait(&mut rt, 5.0);
    // Low Tide Dub's pause gets no answer while Sunrise's resend still waits.
    fixture::refuse_once("PUT /sets/s-low-tide/position", None, "Orbis didn't answer");
    rt.update(|s, _| {
        s.playing.position = 900.0;
        s.toggle();
    });
    land(&mut rt);
    wait(&mut rt, 30.0);
    let low_tide: Vec<String> = calls().into_iter().filter(|c| c == "PUT /sets/s-low-tide/position {\"seconds\":900.0}").collect();
    assert_eq!(low_tide.len(), 2, "sent again: {:?}", calls());
    let library = rt.state.library.sets.data.as_ref().unwrap().iter().find(|x| x.id == "s-low-tide").unwrap();
    assert_eq!(library.playback_position_seconds, 900.0, "what Orbis stored lands");
}
