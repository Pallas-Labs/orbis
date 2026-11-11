//! Playback reports, as the Apple app keeps them (`docs/development.md`, "Playback reports"): the
//! player records what it does, each entry with a snapshot of its state. Settings copies the
//! last 256 entries as JSON. While signed in, the entries also go to Orbis's relay
//! (`/diagnostics/playback`) in batches of at most 32 every 5 s, one batch at a time, and a batch
//! Orbis doesn't take comes back later. Entries are lost only when Orbis refuses their batch for
//! good or more than 1,024 wait; the next batch names each lost range once.
//!
//! Entries never name a Set's title, an address or the key: only the Set's id, numbers and
//! fixed words.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::App;
use crate::api;

/// Entries the copied report holds.
const REPORT: usize = 256;
/// Entries waiting to go to Orbis.
const WAITING: usize = 1024;
const BATCH: usize = 32;
const BATCH_BYTES: usize = 64 * 1024;
const EVERY: Duration = Duration::from_secs(5);
const MOST: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub sequence: u64,
    /// Milliseconds since 1970.
    pub wall: f64,
    /// Seconds since the app started.
    pub uptime: f64,
    pub event: Value,
    pub snapshot: Value,
}

impl Entry {
    fn json(&self) -> Value {
        json!({ "sequence": self.sequence, "wallTime": self.wall, "uptime": self.uptime, "event": self.event, "snapshot": self.snapshot })
    }
}

pub struct State {
    run: String,
    started: Instant,
    sequence: u64,
    report: VecDeque<Entry>,
    evicted: usize,
    waiting: VecDeque<Entry>,
    /// Ranges `(after, through]` never to be delivered, not yet named to Orbis.
    lost: Vec<(u64, u64)>,
    /// Every sequence at or below this is delivered or named lost.
    through: u64,
    sending: bool,
    /// The wait before the next batch; it doubles after a failure.
    wait: Duration,
    /// Orbis turned delivery off: 401, 403, 404, or a long Retry-After.
    stopped: bool,
    /// The next batch is already due.
    due: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            run: crate::playing::new_id(),
            started: Instant::now(),
            sequence: 0,
            report: VecDeque::new(),
            evicted: 0,
            waiting: VecDeque::new(),
            lost: Vec::new(),
            through: 0,
            sending: false,
            wait: EVERY,
            stopped: false,
            due: false,
        }
    }
}

impl State {
    /// The entries the report holds, oldest first.
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.report.iter()
    }

    /// Entries waiting to go to Orbis.
    pub fn unsent(&self) -> usize {
        self.waiting.len()
    }

    /// The report as JSON, with `now` as its tap-time snapshot.
    pub fn report(&self, now: Value) -> String {
        let entries: Vec<Value> = self.report.iter().map(Entry::json).collect();
        let body = json!({ "metadata": metadata(), "runId": self.run, "evicted": self.evicted, "snapshot": now, "entries": entries });
        serde_json::to_string_pretty(&body).unwrap_or_default()
    }
}

/// What the app says about itself in each batch.
fn metadata() -> Value {
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "macOS",
        "windows" => "Windows",
        other => other,
    };
    json!({ "appVersion": env!("CARGO_PKG_VERSION"), "appBuild": "rune", "osName": os, "osVersion": os_version(), "client": "rune" })
}

/// The system's version, at most 64 characters: the kernel release on Linux.
fn os_version() -> String {
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    let release = release.trim();
    if release.is_empty() { "unknown".to_owned() } else { release.chars().take(64).collect() }
}

impl App {
    /// Records `event` with `snapshot`, and starts a batch when one is due.
    pub fn record_playback(&mut self, event: Value, snapshot: Value) {
        let online = self.online();
        let d = &mut self.diagnostics;
        d.sequence += 1;
        let entry = Entry { sequence: d.sequence, wall: crate::clock::now() * 1000.0, uptime: d.started.elapsed().as_secs_f64(), event, snapshot };
        d.report.push_back(entry.clone());
        if d.report.len() > REPORT {
            d.report.pop_front();
            d.evicted += 1;
        }
        if d.stopped || !online {
            return;
        }
        d.waiting.push_back(entry);
        if d.waiting.len() > WAITING
            && let Some(old) = d.waiting.pop_front()
        {
            d.lose(old.sequence, old.sequence);
        }
        if !d.due && !d.sending {
            d.due = true;
            let wait = d.wait;
            self.after(wait, |s| s.send_playback());
        }
    }

    /// Sends the oldest waiting entries as one batch.
    fn send_playback(&mut self) {
        let d = &mut self.diagnostics;
        d.due = false;
        if d.sending || d.stopped || (d.waiting.is_empty() && d.lost.is_empty()) {
            return;
        }
        let mut entries = Vec::new();
        let mut bytes = 0;
        for entry in d.waiting.iter().take(BATCH) {
            let one = entry.json();
            bytes += one.to_string().len();
            if bytes > BATCH_BYTES && !entries.is_empty() {
                break;
            }
            entries.push(one);
        }
        let count = entries.len();
        let last = d.waiting.get(count.saturating_sub(1)).map(|e| e.sequence).filter(|_| count > 0);
        let through = last.into_iter().chain(d.lost.iter().map(|l| l.1)).max().unwrap_or(d.through);
        let lost: Vec<Value> = d.lost.iter().take(BATCH).map(|(a, t)| json!({ "afterSequence": a, "throughSequence": t })).collect();
        let named = lost.len();
        let mut batch = json!({ "schemaVersion": 1, "runId": d.run, "afterSequence": d.through, "throughSequence": through, "entries": entries, "metadata": metadata() });
        if !lost.is_empty() {
            batch["lost"] = Value::Array(lost);
        }
        d.sending = true;
        self.spawn(
            move || api::diagnostics(batch),
            move |s, got| {
                let d = &mut s.diagnostics;
                d.sending = false;
                match got {
                    Ok(_) => {
                        d.waiting.drain(..count);
                        d.lost.drain(..named);
                        d.through = through;
                        d.wait = EVERY;
                    }
                    Err(failure) => match failure.status {
                        Some(401 | 403 | 404) => {
                            d.stopped = true;
                            d.waiting.clear();
                        }
                        None | Some(408 | 429 | 502 | 503 | 504) => d.wait = (d.wait * 2).min(MOST),
                        Some(_) => {
                            // Refused for good: these entries are lost, and the next batch says so.
                            let gone: Vec<u64> = d.waiting.drain(..count).map(|e| e.sequence).collect();
                            if let (Some(first), Some(last)) = (gone.first(), gone.last()) {
                                d.lose(*first, *last);
                            }
                        }
                    },
                }
                if !d.waiting.is_empty() || !d.lost.is_empty() {
                    d.due = true;
                    let wait = d.wait;
                    s.after(wait, |s| s.send_playback());
                }
            },
        );
    }
}

impl State {
    /// Another account signs in: the report stays to copy, but nothing of the last account's
    /// waits to go out, and delivery starts over (a batch still out lands in the old session).
    pub fn new_account(&mut self) {
        self.waiting.clear();
        self.lost.clear();
        self.through = self.sequence;
        (self.sending, self.due, self.stopped, self.wait) = (false, false, false, EVERY);
    }

    /// Entries `first..=last` will never go out.
    fn lose(&mut self, first: u64, last: u64) {
        let after = first.saturating_sub(1);
        match self.lost.last_mut() {
            Some(range) if range.1 == after => range.1 = last,
            _ => self.lost.push((after.max(self.through), last)),
        }
    }
}
