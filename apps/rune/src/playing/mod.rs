//! Playback: the Set playing now, where it is, and its Tracklist. Pressing Play makes a Set the
//! Listening Queue's active one, then streams its Retained Audio. Orbis keeps the place: every
//! 15 s while it plays, on pause and when another Set starts. At the end, Orbis takes the Set
//! out of the queue and the next one plays.
//!
//! A live app streams through mpv ([`crate::audio`]). Headless renders, the demo and tests make
//! no sound; their place moves on Rune's clock in [`poll`].
//!
//! Every change of state tells Presence ([`presence`]) and goes in the playback report
//! ([`crate::diagnostics`]).

pub mod presence;
mod view;

use std::time::Duration;

use rune::Tx;
use serde_json::{Value, json};

use crate::App;
use crate::api::{self, Service};
use crate::audio::{Event, Mpv};
use crate::load::Load;
use crate::model::{Set, Tracklist};

pub use presence::new_id;
pub use view::{bar, screen};

/// Who asked for a command, for the playback report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    App,
    Internal,
}

/// How often a playing Set's place is saved.
const SAVE_EVERY: f64 = 15.0;
/// What Back and Ahead move, in seconds.
pub const BACK: f64 = 15.0;
pub const AHEAD: f64 = 30.0;

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Status {
    /// Nothing playing.
    #[default]
    Idle,
    /// Asking for the stream, or waiting for its first second.
    Loading,
    Playing,
    Paused,
    /// It stopped, in words for the person.
    Failed(String),
}

/// What makes the sound.
#[derive(Default)]
enum Player {
    #[default]
    None,
    /// No sound: the place moves on Rune's clock.
    Silent,
    Live(Mpv),
}

#[derive(Default)]
pub struct State {
    pub set: Option<Set>,
    pub status: Status,
    /// The place in the Set, in seconds.
    pub position: f64,
    pub duration: Option<f64>,
    pub tracklist: Load<Tracklist>,
    player: Player,
    /// Counts each Set started, so a stopped stream's late reports change nothing.
    generation: u64,
    /// Rune's clock at the last `poll`, for the silent player.
    clock: Option<f64>,
    /// The place last saved.
    saved: f64,
    /// Counts the plays the person asked for (a Set, a Playlist, Next, Play after a failure).
    /// A play's answer acts only while its count is still the latest, so the newest choice wins.
    intent: u64,
    /// Orbis has confirmed the loaded Set as the queue's active one.
    activated: bool,
    /// The Set whose activation (`PUT /queue/active`) is still out.
    activating: Option<String>,
    /// A completion held until that activation answers, so Orbis hears them in order.
    held: Option<(String, u64)>,
    /// Where the last early end of the stream left the Set, by its id.
    early_end: Option<(String, f64)>,
    /// Seeks asked for, for the playback report.
    seeks: u64,
    /// The place at the last report sample.
    sampled: f64,
}

impl State {
    /// Orbis's queue names another Set active: the loaded one asks again before it plays.
    pub fn unconfirm(&mut self) {
        self.activated = false;
    }

    /// Counts a play the person asked for, and returns its count.
    pub fn intend(&mut self) -> u64 {
        self.intent += 1;
        self.intent
    }

    /// The latest play the person asked for.
    pub fn intent(&self) -> u64 {
        self.intent
    }

    /// Counts each Set started: a call's answer for an older count is out of date.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The fraction of the Set played, for a progress bar.
    pub fn progress(&self) -> f32 {
        self.duration.filter(|d| *d > 0.0).map_or(0.0, |d| (self.position / d).clamp(0.0, 1.0) as f32)
    }

    /// Made-up playback for scenes: `set` at `position`, with no sound.
    pub fn demo(&mut self, set: Set, position: f64, status: Status, tracklist: Option<Tracklist>) {
        // The demo's Set is the queue's active one, as Orbis has it.
        self.activated = true;
        self.player = if matches!(status, Status::Playing | Status::Paused) { Player::Silent } else { Player::None };
        self.duration = set.duration_seconds;
        self.set = Some(set);
        self.position = position;
        self.saved = position;
        self.status = status;
        self.tracklist = Load::default();
        match tracklist {
            Some(list) => drop(self.tracklist.land(Ok(list))),
            None => self.tracklist.begin(),
        }
    }

    /// The player's state now, for the playback report: numbers, fixed words and the Set's id.
    pub fn snapshot(&self) -> Value {
        let state = match self.status {
            Status::Idle => "idle",
            Status::Loading => "loading",
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Failed(_) => "failed",
        };
        let item = match (&self.status, &self.player) {
            (Status::Failed(_), _) => "failed",
            (Status::Idle, _) => "none",
            (Status::Loading, _) => "unknown",
            _ => "ready",
        };
        let mut snapshot = json!({
            "actualTime": self.position, "displayedTime": self.position, "duration": self.duration,
            "bufferEmpty": false, "bufferFull": false, "bufferRanges": [],
            "itemState": item, "likelyToKeepUp": self.status == Status::Playing, "pendingSeek": null,
            "playbackGeneration": self.generation, "rate": if self.status == Status::Playing { 1.0 } else { 0.0 },
            "seekID": self.seeks, "seekInFlight": false, "sessionReady": true, "state": state,
            "waitingReason": if self.status == Status::Loading { "other" } else { "none" },
        });
        if let Some(set) = &self.set {
            snapshot["setId"] = json!(set.id);
        }
        snapshot
    }

    fn snapshot_state(&self, status: &Status) -> &'static str {
        match status {
            Status::Idle => "idle",
            Status::Loading => "loading",
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Failed(_) => "failed",
        }
    }

    /// Stops the sound and forgets the Set.
    fn stop(&mut self) {
        self.player = Player::None;
        self.generation += 1;
    }
}

impl App {
    /// Finds a Set the app has shown: in the Library, the queue, the open Playlist, or what
    /// someone in the Group is listening to.
    pub fn find_set(&self, id: &str) -> Option<Set> {
        let library = self.library.sets.data.iter().flatten();
        let queue = self.queue.items.data.iter().flat_map(|q| q.entries.iter());
        let playlist = self.playlists.open.data.iter().flat_map(|p| p.sets.iter());
        let group = self.presence.listening.iter().map(|p| &p.set);
        library.chain(queue).chain(playlist).chain(group).find(|x| x.id == id).cloned()
    }

    /// Puts what Orbis sent back for a Set wherever the app shows that Set.
    pub fn replace_set(&mut self, set: &Set) {
        let library = self.library.sets.data.iter_mut().flatten();
        let queue = self.queue.items.data.iter_mut().flat_map(|q| q.entries.iter_mut());
        let playlist = self.playlists.open.data.iter_mut().flat_map(|p| p.sets.iter_mut());
        for x in library.chain(queue).chain(playlist).filter(|x| x.id == set.id) {
            *x = set.clone();
        }
        if let Some(loaded) = self.playing.set.as_mut().filter(|x| x.id == set.id) {
            loaded.playback_position_seconds = set.playback_position_seconds;
        }
    }

    /// Shows `set` in the player without playing it: the queue's active Set when the app opens.
    /// Its Tracklist loads, so Now Playing has it before Play.
    pub fn show_set(&mut self, set: Set) {
        let p = &mut self.playing;
        // A new generation: the Set shown before can't land its Tracklist under this one.
        p.stop();
        p.activated = true;
        p.duration = set.duration_seconds;
        p.position = set.playback_position_seconds;
        p.saved = p.position;
        p.tracklist = Load::default();
        p.tracklist.begin();
        let id = set.id.clone();
        p.set = Some(set);
        let generation = p.generation;
        self.spawn(
            move || api::tracklist(&id),
            move |s, got| {
                if s.playing.generation == generation {
                    s.playing.tracklist.land(got);
                }
            },
        );
    }

    /// Puts the Library's fresh Sets into the queue's and the open Playlist's copies, and the
    /// loaded Set's resume point.
    pub fn refresh_copies(&mut self) {
        let Some(sets) = &self.library.sets.data else { return };
        let fresh: std::collections::HashMap<&str, &Set> = sets.iter().map(|x| (x.id.as_str(), x)).collect();
        let queue = self.queue.items.data.iter_mut().flat_map(|q| q.entries.iter_mut());
        let playlist = self.playlists.open.data.iter_mut().flat_map(|p| p.sets.iter_mut());
        for x in queue.chain(playlist) {
            if let Some(new) = fresh.get(x.id.as_str()) {
                *x = (*new).clone();
            }
        }
        if let Some(loaded) = self.playing.set.as_mut()
            && let Some(new) = fresh.get(loaded.id.as_str())
        {
            loaded.playback_position_seconds = new.playback_position_seconds;
        }
    }

    /// Plays `set`, which is already the queue's active Set.
    pub fn start_set(&mut self, set: Set) {
        self.start(Some(set));
        self.playing.activated = true;
    }

    /// Records `event` in the playback report with the player's state now.
    fn report(&mut self, event: Value) {
        let snapshot = self.playing.snapshot();
        self.record_playback(event, snapshot);
    }

    /// Records a command.
    pub fn command(&mut self, kind: &str, origin: Origin, target: Option<f64>) {
        let origin = if origin == Origin::App { "app" } else { "internalOperation" };
        self.report(json!({ "command": { "_0": { "kind": kind, "origin": origin, "target": target } } }));
    }

    /// Moves the player to `to`, and tells Presence and the report.
    fn set_status(&mut self, to: Status) {
        let from = std::mem::replace(&mut self.playing.status, to.clone());
        if from == to {
            return;
        }
        match to {
            Status::Playing => {
                // A Set loaded without a fresh start (the queue's active one) has no session yet.
                if let Some(id) = self.playing.set.as_ref().map(|x| x.id.clone()) {
                    self.presence_ensure(&id);
                }
                self.presence_act(presence::Kind::Play);
            }
            Status::Paused => self.presence_act(presence::Kind::Pause),
            Status::Idle | Status::Failed(_) => self.presence_act(presence::Kind::Stop),
            Status::Loading => {}
        }
        let word = |s: &Status| self.playing.snapshot_state(s);
        let event = json!({ "state": { "_0": { "from": word(&from), "to": word(&to) } } });
        self.report(event);
        if let Status::Failed(_) = to {
            self.report(json!({ "error": { "_0": { "domain": "other", "code": 0 } } }));
        }
    }

    /// Whether `set` can be `verb`ed here; when not, says why.
    pub fn can(&mut self, verb: &str, set: &Set) -> bool {
        let why = set.unplayable_reason();
        if let Some(why) = why {
            self.say(format!("Can't {verb} {}: {why}", set.title));
        }
        why.is_none()
    }

    /// Plays `id` from where the person left it: it becomes the queue's active Set at once,
    /// keeping the rest of the queue, and Orbis hears so while the stream starts.
    pub fn play(&mut self, id: &str) {
        let Some(set) = self.find_set(id).filter(|set| self.can("play", set)) else { return };
        self.activate(set);
    }

    /// Makes `set` the queue's active Set here at once, starts it, and asks Orbis to do the same.
    fn activate(&mut self, set: Set) {
        if let Some(queue) = self.queue.items.data.as_mut() {
            queue.activate(&set);
        }
        let id = set.id.clone();
        let intent = self.playing.intend();
        let generation = self.start(Some(set));
        self.playing.activating = Some(id.clone());
        let asked = id.clone();
        self.spawn(
            move || api::play(&id),
            move |s, got| match got {
                // A completion waiting on this activation goes out now, whatever it answered.
                _ if s.release_completion(&asked) => {}
                // The person chose something else since: its own answer brings the queue.
                _ if s.playing.intent != intent => {}
                Ok(queue) => {
                    s.queue.items.land(Ok(queue));
                    s.playing.activated = s.playing.generation == generation;
                    s.presence_retry();
                }
                Err(why) => s.fail(generation, why),
            },
        );
    }

    /// Plays `next`, or stops when there is none. Returns its generation.
    fn start(&mut self, next: Option<Set>) -> u64 {
        match next {
            Some(set) if set.playable() => {
                let generation = self.begin(set);
                self.stream(generation);
                generation
            }
            Some(set) => {
                let why = set.unplayable_reason().unwrap_or_default().to_owned();
                let generation = self.begin(set);
                self.set_status(Status::Failed(why));
                generation
            }
            None => {
                self.save_place();
                self.set_status(Status::Idle);
                let (generation, intent) = (self.playing.generation + 1, self.playing.intent);
                self.playing = State { generation, intent, ..State::default() };
                generation
            }
        }
    }

    /// Play and pause. With nothing loaded, plays the queue's active Set.
    pub fn toggle(&mut self) {
        self.command("toggle", Origin::App, None);
        let p = &mut self.playing;
        match (&p.status, &p.player) {
            (Status::Playing, Player::Live(mpv)) => mpv.pause(true),
            (Status::Paused, Player::Live(mpv)) if p.activated => mpv.pause(false),
            (Status::Playing, _) => {}
            (Status::Paused, _) if p.activated => {}
            (Status::Loading, _) => return,
            // Idle, failed, or paused on a Set Orbis no longer has active.
            (Status::Idle | Status::Failed(_) | Status::Paused, _) => {
                // Trying the loaded Set again resumes where the person was in it, not where it opened.
                let here = p.set.clone().map(|mut x| {
                    x.playback_position_seconds = p.position;
                    x
                });
                // Orbis never confirmed it as the active Set (its Play failed): ask again first.
                let confirmed = p.activated;
                let next = here.or_else(|| self.queue.items.data.as_ref().and_then(|q| q.active().cloned()));
                if let Some(set) = next.filter(|set| self.can("play", set)) {
                    if confirmed || self.playing.set.is_none() {
                        self.playing.intend();
                        self.start(Some(set));
                        self.playing.activated = true;
                    } else {
                        self.activate(set);
                    }
                }
                return;
            }
        }
        let to = if self.playing.status == Status::Playing { Status::Paused } else { Status::Playing };
        self.set_status(to);
        if self.playing.status == Status::Paused {
            self.save_place();
        }
    }

    /// Moves to `seconds` in the Set.
    pub fn seek(&mut self, seconds: f64) {
        self.seek_as("seek", seconds);
    }

    /// Moves `by` seconds, back or ahead.
    pub fn skip(&mut self, by: f64) {
        let at = self.playing.position + by;
        self.seek_as(if by < 0.0 { "skipBackward" } else { "skipForward" }, at);
    }

    fn seek_as(&mut self, kind: &str, seconds: f64) {
        if self.playing.set.is_none() {
            return;
        }
        let target = seconds.clamp(0.0, self.playing.duration.unwrap_or(f64::MAX));
        self.command(kind, Origin::App, Some(target));
        let p = &mut self.playing;
        p.position = target;
        p.seeks += 1;
        if let Player::Live(mpv) = &p.player {
            mpv.seek(p.position);
        }
        let event = json!({ "seekResult": { "_0": { "actual": target, "duration": p.duration, "finished": true, "seekID": p.seeks, "target": target } } });
        self.report(event);
    }

    /// Ends the Set now, as if it had played out: the next one in the queue plays.
    pub fn next(&mut self) {
        self.command("stop", Origin::App, None);
        self.playing.intend();
        self.finish();
    }

    /// Readies `set` to play: saves the place in the Set before it, stops that one's sound and
    /// loads the new one's Tracklist. Returns the new Set's generation.
    fn begin(&mut self, set: Set) -> u64 {
        self.save_place();
        let p = &mut self.playing;
        p.stop();
        p.activated = false;
        let near_end = set.duration_seconds.is_some_and(|d| set.playback_position_seconds > d - 5.0);
        p.position = if near_end { 0.0 } else { set.playback_position_seconds };
        p.saved = p.position;
        p.sampled = p.position;
        p.duration = set.duration_seconds;
        p.tracklist = Load::default();
        p.tracklist.begin();
        let id = set.id.clone();
        p.set = Some(set);
        let generation = p.generation;
        self.presence_begin(&id);
        self.set_status(Status::Loading);
        self.report(json!({ "session": { "_0": { "phase": "startRequested", "playbackGeneration": generation, "requestID": generation } } }));
        let urls = self.playing.set.iter().flat_map(|x| [x.artwork_large_url.clone(), x.artwork_url.clone()]).flatten().collect::<Vec<_>>();
        self.want_artwork(urls.iter().map(String::as_str));
        self.spawn(
            move || api::tracklist(&id),
            move |s, got| {
                if s.playing.generation == generation {
                    s.playing.tracklist.land(got);
                }
            },
        );
        generation
    }

    /// Asks for the Set's stream and starts the player on it.
    fn stream(&mut self, generation: u64) {
        let Some(id) = self.playing.set.as_ref().map(|x| x.id.clone()) else { return };
        if !matches!(self.service, Service::Live(_)) {
            // Headless, the demo and tests: no sound, and no stream to ask for.
            self.playing.player = Player::Silent;
            self.set_status(Status::Playing);
            return;
        }
        self.spawn(
            move || api::stream_url(&id),
            move |s, got| match got {
                Ok(url) if s.playing.generation == generation => s.open(url, generation),
                Ok(_) => {}
                Err(why) => s.fail(generation, why),
            },
        );
    }

    fn open(&mut self, url: String, generation: u64) {
        let Service::Live(handle) = &self.service else { return };
        let handle = handle.clone();
        let report = move |event: Event| handle.update(move |s: &mut App, _| s.heard(generation, event));
        self.playing.player = Player::Live(Mpv::open(url, self.playing.position, report));
    }

    /// What the player reported about the Set of `generation`.
    pub(crate) fn heard(&mut self, generation: u64, event: Event) {
        let p = &mut self.playing;
        if p.generation != generation {
            return;
        }
        match event {
            Event::Time(t) => {
                p.position = t;
                if p.status == Status::Loading {
                    self.set_status(Status::Playing);
                    self.report(json!({ "session": { "_0": { "phase": "ready", "playbackGeneration": generation, "requestID": generation } } }));
                }
                self.tick();
            }
            Event::Paused(paused) if p.status != Status::Loading => {
                self.set_status(if paused { Status::Paused } else { Status::Playing });
            }
            Event::Paused(_) => {}
            Event::Duration(d) => p.duration = Some(d),
            Event::Ended => {
                let (actual, expected) = (self.playing.position, self.playing.duration);
                let premature = expected.is_some_and(|d| actual < d - 2.0);
                self.report(json!({ "ended": { "_0": { "actual": actual, "expected": expected, "premature": premature } } }));
                if premature && !self.ended_here_before(actual) {
                    // As the Apple app does (PAL-1840): the first early end is a stop, not a
                    // Finish. The place is kept, so Play goes on from here.
                    self.save_place();
                    self.fail(generation, "The stream stopped early. Press Play to go on from here.".to_owned());
                } else {
                    self.finish();
                }
            }
            Event::Failed(why) => self.fail(generation, why),
        }
    }

    /// Whether the stream ended early at `at` once already: the audio is shorter than Orbis said,
    /// so this end is the Set's end. Remembers `at` otherwise.
    fn ended_here_before(&mut self, at: f64) -> bool {
        let p = &mut self.playing;
        let Some(id) = p.set.as_ref().map(|x| x.id.clone()) else { return false };
        let again = p.early_end.as_ref().is_some_and(|(was, there)| *was == id && (there - at).abs() < 0.5);
        p.early_end = Some((id, at));
        again
    }

    fn fail(&mut self, generation: u64, why: String) {
        if self.playing.generation == generation {
            self.playing.player = Player::None;
            self.set_status(Status::Failed(why));
        }
    }

    /// A playing second passed: the place is saved every 15 s, and the report samples every 5 s.
    fn tick(&mut self) {
        let p = &mut self.playing;
        if (p.position - p.saved).abs() >= SAVE_EVERY {
            self.save_place();
        }
        let p = &mut self.playing;
        if (p.position - p.sampled).abs() >= 5.0 {
            p.sampled = p.position;
            self.report(json!({ "sample": {} }));
        }
    }

    /// Tells Orbis where the person is in the Set playing now.
    fn save_place(&mut self) {
        let p = &mut self.playing;
        let Some(id) = p.set.as_ref().map(|x| x.id.clone()) else { return };
        if p.player.is_none() || (p.position - p.saved).abs() < 1.0 {
            return;
        }
        p.saved = p.position;
        let seconds = p.position;
        self.spawn(
            move || api::save_position(&id, seconds),
            |s, got| {
                if let Ok(set) = got {
                    s.replace_set(&set);
                }
            },
        );
    }

    /// The Set played out: it leaves the queue and the next one plays at once (ADR 0001). Orbis
    /// resets the Set's place and names the next too; when it names another, that one plays.
    fn finish(&mut self) {
        let Some(id) = self.playing.set.as_ref().map(|x| x.id.clone()) else { return };
        self.playing.position = 0.0;
        self.playing.saved = 0.0;
        let next = self.queue.items.data.as_mut().and_then(|q| q.advance(&id));
        // A Set the person starts before Orbis answers wins: an answer for an older generation
        // changes nothing, queue included. The event stream brings the queue back in step.
        let generation = self.start(next);
        // A Set whose activation is still out isn't active on Orbis yet, and Orbis ignores the
        // completion of a Set that isn't: hold it until the activation answers.
        if self.playing.activating.as_deref() == Some(id.as_str()) {
            self.playing.held = Some((id, generation));
            return;
        }
        self.complete(id, generation);
    }

    /// Whether `asked`'s activation answered with a completion held for it: that completion goes
    /// out now, and the activation's answer is out of date.
    fn release_completion(&mut self, asked: &str) -> bool {
        if self.playing.activating.as_deref() == Some(asked) {
            self.playing.activating = None;
        }
        let Some((id, generation)) = self.playing.held.take_if(|(id, _)| id == asked) else { return false };
        self.complete(id, generation);
        true
    }

    /// Tells Orbis `id` played out, and follows what it names next.
    fn complete(&mut self, id: String, generation: u64) {
        self.spawn(
            move || {
                let _ = api::save_position(&id, 0.0);
                api::complete(&id)
            },
            move |s, got| match got {
                Ok(_) if s.playing.generation != generation => {}
                Ok(queue) => {
                    let active = queue.active().cloned();
                    s.queue.items.land(Ok(queue));
                    if active.as_ref().map(|a| &a.id) != s.playing.set.as_ref().map(|p| &p.id) {
                        s.start(active);
                    } else {
                        s.presence_retry();
                    }
                    s.playing.activated = s.playing.set.is_some();
                }
                Err(why) => s.say(format!("Orbis didn't hear that the Set ended: {why}")),
            },
        );
    }

    /// The window closes: the sound stops with it. The place saved last stands, at most
    /// [`SAVE_EVERY`] seconds behind.
    pub fn close(&mut self) {
        self.set_status(Status::Idle);
        self.playing.stop();
    }
}

impl Player {
    fn is_none(&self) -> bool {
        matches!(self, Player::None)
    }
}

/// Moves the silent player's place on Rune's clock, and wakes for its next whole second.
pub fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let p = &mut s.playing;
    let dt = (clock - p.clock.unwrap_or(clock)).max(0.0);
    p.clock = Some(clock);
    if p.status != Status::Playing || !matches!(p.player, Player::Silent) {
        return false;
    }
    let before = p.position.floor();
    p.position += dt;
    if let Some(d) = p.duration.filter(|d| p.position >= *d) {
        p.position = d;
        s.finish();
        return true;
    }
    tx.wake_after(Duration::from_secs_f64((1.0 - p.position.fract()).max(0.01)));
    let moved = p.position.floor() != before;
    if moved {
        s.tick();
    }
    moved
}
