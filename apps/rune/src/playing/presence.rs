//! Presence (ADR 0019): Orbis hears when this device plays, pauses and stops a Set, so the Group
//! sees what the Person is listening to, and so their other devices know who plays. Each Set the
//! player starts is one session. Actions go out one at a time, in order, each carrying the owner
//! generation the last play returned; a playing session renews its 30 s lease every 15 s.
//!
//! The live event stream brings back who in the Group is listening ([`State::listening`]).

use std::collections::VecDeque;
use std::time::Duration;

use serde_json::json;

use crate::App;
use crate::api;
use crate::model;

/// How often a playing session renews its lease.
const RENEW: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Play,
    Pause,
    Stop,
    Renew,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Local {
    Idle,
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug)]
struct Session {
    id: String,
    set_id: String,
    actions: u64,
    owner: Option<u64>,
    state: Local,
}

#[derive(Debug)]
pub struct State {
    session: Option<Session>,
    waiting: VecDeque<(String, Kind)>,
    sending: bool,
    /// False once Orbis answers 404: an older API without Presence.
    supported: bool,
    /// Who in the Group is listening now, from the event stream.
    pub listening: Vec<model::Presence>,
}

impl Default for State {
    fn default() -> Self {
        State { session: None, waiting: VecDeque::new(), sending: false, supported: true, listening: Vec::new() }
    }
}

impl App {
    /// A new Set starts: the last session stops, and a new one begins.
    pub fn presence_begin(&mut self, set_id: &str) {
        self.presence_act(Kind::Stop);
        self.presence.session = Some(Session { id: new_id(), set_id: set_id.to_owned(), actions: 0, owner: None, state: Local::Idle });
    }

    /// Asks for Presence again for the Set playing now, when Orbis refused its play. Orbis
    /// refuses a play while its queue names another Set (`queue-changed`), so this runs each
    /// time the queue catches up (ADR 0019).
    pub fn presence_retry(&mut self) {
        let playing = self.playing.status == super::Status::Playing;
        let refused = self.presence.session.as_ref().is_some_and(|x| x.state == Local::Idle);
        if playing && refused {
            self.presence_act(Kind::Play);
        }
    }

    /// Begins a session for `set_id` unless one is open for it.
    pub fn presence_ensure(&mut self, set_id: &str) {
        if self.presence.session.as_ref().is_none_or(|x| x.set_id != set_id) {
            self.presence_begin(set_id);
        }
    }

    /// Tells Orbis the player did `kind`, when the session is in a state that allows it.
    pub fn presence_act(&mut self, kind: Kind) {
        let Some(session) = self.presence.session.as_mut() else { return };
        let to = match (kind, session.state) {
            (Kind::Play, Local::Idle | Local::Paused) => Local::Playing,
            (Kind::Pause, Local::Playing) => Local::Paused,
            (Kind::Renew, Local::Playing) => Local::Playing,
            (Kind::Stop, Local::Playing | Local::Paused) => Local::Stopped,
            _ => return,
        };
        session.state = to;
        let id = session.id.clone();
        self.presence.waiting.push_back((id.clone(), kind));
        if kind == Kind::Play {
            self.after(RENEW, move |s| s.renew(&id));
        }
        self.send_presence();
    }

    fn renew(&mut self, id: &str) {
        let playing = self.presence.session.as_ref().is_some_and(|x| x.id == id && x.state == Local::Playing);
        if playing {
            self.presence_act(Kind::Renew);
            let id = id.to_owned();
            self.after(RENEW, move |s| s.renew(&id));
        }
    }

    fn send_presence(&mut self) {
        let p = &mut self.presence;
        if !p.supported {
            p.waiting.clear();
        }
        if p.sending {
            return;
        }
        while let Some((id, kind)) = p.waiting.pop_front() {
            let Some(session) = p.session.as_mut().filter(|x| x.id == id) else { continue };
            let number = session.actions + 1;
            let mut body = json!({ "actionId": new_id(), "actionNumber": number, "sessionId": session.id });
            match (kind, session.owner) {
                (Kind::Play, _) => {
                    body["kind"] = json!("play");
                    body["setId"] = json!(session.set_id);
                }
                (_, Some(owner)) => {
                    body["kind"] = json!(match kind {
                        Kind::Pause => "pause",
                        Kind::Stop => "stop",
                        _ => "renew",
                    });
                    body["ownerGeneration"] = json!(owner);
                }
                // An action before any play landed has no generation to carry.
                (_, None) => continue,
            }
            session.actions = number;
            p.sending = true;
            self.spawn(
                move || api::presence(body),
                move |s, got| {
                    s.presence.sending = false;
                    match got {
                        Ok(owner) => {
                            if let Some(session) = s.presence.session.as_mut().filter(|x| x.id == id) {
                                session.owner = Some(owner);
                            }
                        }
                        Err(failure) if failure.status == Some(404) => s.presence.supported = false,
                        Err(_) if kind == Kind::Play => {
                            if let Some(session) = s.presence.session.as_mut().filter(|x| x.id == id && x.state == Local::Playing) {
                                session.state = Local::Idle;
                            }
                        }
                        Err(_) => {}
                    }
                    s.send_presence();
                },
            );
            return;
        }
    }
}

/// A random UUID, for a session or an action.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
