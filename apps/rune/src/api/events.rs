//! Orbis's live events (`GET /events?changes=1`, ADR 0014 and 0019): the Listening Queue when any
//! of the Person's devices changes it, who in the Group is listening, and which lists changed.
//! One thread reads the stream for a signed-in window and lands each event in the app; it
//! reconnects on its own and says so, so every screen can reload what it missed.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;

use crate::model::{Presence, Queue};

/// What changed, by name, for the screens that show it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Topic {
    Library,
    Playlist,
    ListenHistory,
    Set,
}

/// One event from the stream.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Queue {
        queue: Queue,
    },
    Presence {
        presence: Vec<Presence>,
    },
    Heartbeat,
    Changed {
        topic: Topic,
    },
    /// A playlist import's progress. The app reloads Playlists when one ends.
    PlaylistImport {
        #[serde(rename = "playlistImport")]
        import: serde_json::Value,
    },
    /// Not from Orbis: the stream opened (true), or dropped and is trying again (false).
    #[serde(skip)]
    Connected(bool),
}

/// Bumped on sign-out, so a stream for the old key ends.
static RUN: AtomicU64 = AtomicU64::new(0);

/// Ends the running stream, if any.
pub fn stop() {
    RUN.fetch_add(1, Ordering::SeqCst);
}

/// Reads the stream on a thread until [`stop`], handing each event to `deliver`.
#[cfg(not(test))]
pub fn start(deliver: impl Fn(Event) + Send + 'static) {
    let run = RUN.load(Ordering::SeqCst);
    // The stream speaks as the account current now, through any later sign-in.
    let server = super::Server::current();
    std::thread::spawn(move || {
        super::with_server(server, || read(run, &deliver));
    });
}

#[cfg(not(test))]
fn read(run: u64, deliver: &impl Fn(Event)) {
    use std::io::{BufRead, BufReader};
    use std::time::Duration;

    let mut wait = 1;
    while RUN.load(Ordering::SeqCst) == run {
        // Orbis sends a heartbeat every 30 s, so 75 s of quiet means the link is gone.
        match super::http::stream("/events?changes=1", Duration::from_secs(75)) {
            Ok(body) => {
                deliver(Event::Connected(true));
                wait = 1;
                let mut data = String::new();
                for line in BufReader::new(body).lines() {
                    let Ok(line) = line else { break };
                    if RUN.load(Ordering::SeqCst) != run {
                        return;
                    }
                    if let Some(rest) = line.strip_prefix("data:") {
                        data.push_str(rest.trim_start());
                    } else if line.is_empty() && !data.is_empty() {
                        if let Ok(event) = serde_json::from_str::<Event>(&data) {
                            deliver(event);
                        }
                        data.clear();
                    }
                }
                deliver(Event::Connected(false));
            }
            Err(failure) if matches!(failure.status, Some(401 | 403)) => {
                deliver(Event::Connected(false));
                return;
            }
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_secs(wait));
        wait = (wait * 2).min(30);
    }
}
