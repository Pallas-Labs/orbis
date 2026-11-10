//! Playback: the Set playing now, where it is, and its Tracklist. Pressing Play makes a Set the
//! Listening Queue's active one, then streams its Retained Audio. Orbis keeps the place: every
//! 15 s while it plays, on pause and when another Set starts. At the end, Orbis takes the Set
//! out of the queue and the next one plays.
//!
//! A live app streams through mpv ([`crate::audio`]). Headless renders, the demo and tests make
//! no sound; their place moves on Rune's clock in [`poll`].

mod view;

use std::time::Duration;

use rune::Tx;

use crate::App;
use crate::api::{self, Service};
use crate::audio::{Event, Mpv};
use crate::load::Load;
use crate::model::{Set, Tracklist};

pub use view::{bar, screen};

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
}

impl State {
    /// The fraction of the Set played, for a progress bar.
    pub fn progress(&self) -> f32 {
        self.duration.filter(|d| *d > 0.0).map_or(0.0, |d| (self.position / d).clamp(0.0, 1.0) as f32)
    }

    /// Made-up playback for scenes: `set` at `position`, with no sound.
    pub fn demo(&mut self, set: Set, position: f64, status: Status, tracklist: Option<Tracklist>) {
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

    /// Stops the sound and forgets the Set.
    fn stop(&mut self) {
        self.player = Player::None;
        self.generation += 1;
    }
}

impl App {
    /// Finds a Set the app has shown, in the Library or the queue.
    pub fn find_set(&self, id: &str) -> Option<Set> {
        let library = self.library.sets.data.iter().flatten();
        let queue = self.queue.items.data.iter().flat_map(|q| q.entries.iter());
        library.chain(queue).find(|x| x.id == id).cloned()
    }

    /// Puts what Orbis sent back for a Set wherever the app shows that Set.
    pub fn replace_set(&mut self, set: &Set) {
        let library = self.library.sets.data.iter_mut().flatten();
        let queue = self.queue.items.data.iter_mut().flat_map(|q| q.entries.iter_mut());
        for x in library.chain(queue).filter(|x| x.id == set.id) {
            *x = set.clone();
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
        if let Some(queue) = self.queue.items.data.as_mut() {
            queue.activate(&set);
        }
        let generation = self.start(Some(set));
        let id = id.to_owned();
        self.spawn(
            move || api::play(&id),
            move |s, got| match got {
                Ok(queue) => {
                    s.queue.items.land(Ok(queue));
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
                self.playing.status = Status::Failed(why);
                generation
            }
            None => {
                self.save_place();
                let generation = self.playing.generation + 1;
                self.playing = State { generation, ..State::default() };
                generation
            }
        }
    }

    /// Play and pause. With nothing loaded, plays the queue's active Set.
    pub fn toggle(&mut self) {
        let p = &mut self.playing;
        match (&p.status, &p.player) {
            (Status::Playing, Player::Live(mpv)) => mpv.pause(true),
            (Status::Paused, Player::Live(mpv)) => mpv.pause(false),
            (Status::Playing | Status::Paused, _) => {}
            (Status::Loading, _) => return,
            (Status::Idle | Status::Failed(_), _) => {
                let next = p.set.clone().or_else(|| self.queue.items.data.as_ref().and_then(|q| q.active().cloned()));
                if let Some(set) = next.filter(|set| self.can("play", set)) {
                    self.start(Some(set));
                }
                return;
            }
        }
        let p = &mut self.playing;
        p.status = if p.status == Status::Playing { Status::Paused } else { Status::Playing };
        if p.status == Status::Paused {
            self.save_place();
        }
    }

    /// Moves to `seconds` in the Set.
    pub fn seek(&mut self, seconds: f64) {
        let p = &mut self.playing;
        if p.set.is_none() {
            return;
        }
        p.position = seconds.clamp(0.0, p.duration.unwrap_or(f64::MAX));
        if let Player::Live(mpv) = &p.player {
            mpv.seek(p.position);
        }
    }

    /// Ends the Set now, as if it had played out: the next one in the queue plays.
    pub fn next(&mut self) {
        self.finish();
    }

    /// Readies `set` to play: saves the place in the Set before it, stops that one's sound and
    /// loads the new one's Tracklist. Returns the new Set's generation.
    fn begin(&mut self, set: Set) -> u64 {
        self.save_place();
        let p = &mut self.playing;
        p.stop();
        let near_end = set.duration_seconds.is_some_and(|d| set.playback_position_seconds > d - 5.0);
        p.position = if near_end { 0.0 } else { set.playback_position_seconds };
        p.saved = p.position;
        p.duration = set.duration_seconds;
        p.status = Status::Loading;
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
        generation
    }

    /// Asks for the Set's stream and starts the player on it.
    fn stream(&mut self, generation: u64) {
        let Some(id) = self.playing.set.as_ref().map(|x| x.id.clone()) else { return };
        if !matches!(self.service, Service::Live(_)) {
            // Headless, the demo and tests: no sound, and no stream to ask for.
            self.playing.player = Player::Silent;
            self.playing.status = Status::Playing;
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
    fn heard(&mut self, generation: u64, event: Event) {
        let p = &mut self.playing;
        if p.generation != generation {
            return;
        }
        match event {
            Event::Time(t) => {
                p.position = t;
                if p.status == Status::Loading {
                    p.status = Status::Playing;
                }
                if (p.position - p.saved).abs() >= SAVE_EVERY {
                    self.save_place();
                }
            }
            Event::Paused(paused) if p.status != Status::Loading => {
                p.status = if paused { Status::Paused } else { Status::Playing };
            }
            Event::Paused(_) => {}
            Event::Duration(d) => p.duration = Some(d),
            Event::Ended => self.finish(),
            Event::Failed(why) => self.fail(generation, why),
        }
    }

    fn fail(&mut self, generation: u64, why: String) {
        let p = &mut self.playing;
        if p.generation == generation {
            p.player = Player::None;
            p.status = Status::Failed(why);
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
        self.start(next);
        self.spawn(
            move || {
                let _ = api::save_position(&id, 0.0);
                api::complete(&id)
            },
            move |s, got| match got {
                Ok(queue) => {
                    let active = queue.active().cloned();
                    s.queue.items.land(Ok(queue));
                    if active.as_ref().map(|a| &a.id) != s.playing.set.as_ref().map(|p| &p.id) {
                        s.start(active);
                    }
                }
                Err(why) => s.say(format!("Orbis didn't hear that the Set ended: {why}")),
            },
        );
    }

    /// The window closes: the sound stops with it. The place saved last stands, at most
    /// [`SAVE_EVERY`] seconds behind.
    pub fn close(&mut self) {
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
    if (p.position - p.saved).abs() >= SAVE_EVERY {
        s.save_place();
    }
    s.playing.position.floor() != before
}
