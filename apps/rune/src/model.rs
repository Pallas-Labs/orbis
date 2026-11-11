//! What Orbis sends back, as the app reads it: a Set, the Listening Queue and a Tracklist.
//! Each mirrors its schema in `packages/contracts/src/http-api.ts`, with only the fields the app
//! shows; serde skips the rest, so a new field on the server breaks nothing here.

use serde::Deserialize;

/// Where a Set's Source Link points.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    #[default]
    Youtube,
    Soundcloud,
    AppleMusic,
}

/// Where a Set's Retained Audio stands. Only `Ready` plays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Download {
    #[default]
    None,
    Queued,
    Downloading,
    Ready,
    Failed,
    Canceled,
}

/// One Set as the caller's Library holds it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Set {
    pub id: String,
    pub title: String,
    pub creator: Option<String>,
    pub duration_seconds: Option<f64>,
    pub download_state: Download,
    pub source: Source,
    pub playback_position_seconds: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    /// The Artwork a listing draws, and the large one a Set's own page draws.
    #[serde(default)]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub artwork_large_url: Option<String>,
    /// The caller's Playlists that hold this Set.
    #[serde(default)]
    pub playlist_ids: Vec<String>,
    /// Set when the Person saved it, for "Recently filed".
    #[serde(default)]
    pub created_at: String,
}

impl Set {
    /// Whether this app can play the Set: it has Retained Audio. Apple Music Sets play only
    /// through MusicKit, in the Apple apps.
    pub fn playable(&self) -> bool {
        self.source != Source::AppleMusic && self.download_state == Download::Ready
    }

    /// Why the Set can't play here, in words for the person; `None` when it can.
    pub fn unplayable_reason(&self) -> Option<&'static str> {
        match (self.source, self.download_state) {
            (Source::AppleMusic, _) => Some("Apple Music Sets play in the Orbis apps for iPhone and Mac"),
            (_, Download::Ready) => None,
            (_, Download::Queued | Download::Downloading) => Some("Downloading: it plays once its audio is on Vanta"),
            (_, Download::Failed) => Some("The download failed"),
            (_, Download::None | Download::Canceled) => Some("Not downloaded yet"),
        }
    }
}

/// One Person's Listening Queue. `entries` holds every Set in it, the active one included.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub active_set_id: Option<String>,
    pub entries: Vec<Set>,
}

impl Queue {
    /// The Set playing now, if the queue names one.
    pub fn active(&self) -> Option<&Set> {
        let id = self.active_set_id.as_deref()?;
        self.entries.iter().find(|e| e.id == id)
    }

    /// Makes `set` the active Set, as Orbis does on Play: a Set already in the queue keeps its
    /// place, and another goes in after the active one (ADR 0001).
    pub fn activate(&mut self, set: &Set) {
        if !self.entries.iter().any(|e| e.id == set.id) {
            let at = self.active_set_id.as_ref().and_then(|a| self.entries.iter().position(|e| e.id == *a)).map_or(0, |i| i + 1);
            self.entries.insert(at, set.clone());
        }
        self.active_set_id = Some(set.id.clone());
    }

    /// `id` played out: it leaves the queue, and the Set after it becomes active (ADR 0001).
    /// Returns the new active Set.
    pub fn advance(&mut self, id: &str) -> Option<Set> {
        let at = self.entries.iter().position(|e| e.id == id)?;
        self.entries.remove(at);
        let next = self.entries.get(at).cloned();
        self.active_set_id = next.as_ref().map(|n| n.id.clone());
        next
    }
}

/// One named recording in a Tracklist.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub artist: String,
    pub title: String,
    pub start_seconds: Option<f64>,
}

/// Where a Set's Tracklist stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TracklistState {
    #[default]
    Pending,
    Ready,
    None,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Tracklist {
    pub cues: Vec<Cue>,
    pub state: TracklistState,
}

impl Tracklist {
    /// The index of the Cue playing at `seconds`: the last one that starts at or before it.
    pub fn cue_at(&self, seconds: f64) -> Option<usize> {
        self.cues.iter().rposition(|c| c.start_seconds.is_some_and(|s| s <= seconds))
    }
}

/// `3:07`, or `1:02:09` past an hour, for a length or a place in a Set.
pub fn clock_time(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// A Playlist, as a list of them shows it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub set_count: usize,
    /// The Person who made it, for a Collaborative Playlist someone else made.
    #[serde(default)]
    pub creator: Option<Person>,
}

/// What a Person may do with a Playlist: only its creator renames, deletes or names editors.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    Creator,
    Editor,
}

/// One Playlist with its Sets in order (ADR 0010).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    pub id: String,
    pub name: String,
    pub creator: Person,
    pub role: Role,
    pub sets: Vec<Set>,
}

/// Someone in the Group, as another Person sees them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Person {
    pub id: String,
    pub username: String,
}

/// The signed-in Person and their settings.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub id: String,
    pub username: String,
    pub auto_download: bool,
    /// Share with Group: whether the Group sees what this Person listens to.
    pub social: bool,
    pub host: bool,
}

/// One device signed in as the Person.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub label: String,
    pub added_at: String,
    pub last_used_at: Option<String>,
    /// This device.
    pub current: bool,
}

/// What someone in the Group is listening to now.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub person_id: String,
    pub username: String,
    pub set: Set,
}

/// A code a signed-in device shows, for a new device to type (ADR 0020).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInCode {
    pub code: String,
    pub expires_at: String,
}

/// A new device's key, given once, and the Person it signs in as.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct SignedIn {
    pub key: String,
    pub person: Person,
}

/// An Approval Request a signed-out device started: the code it shows, and its secret.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub code: String,
    pub expires_at: String,
    pub secret: String,
}

/// What waiting on an Approval Request heard.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ApprovalWait {
    Pending,
    Approved { key: String, person: Person },
}

/// What saving a link did, beside the Set it made: whether a Download started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoDownload {
    Queued,
    #[default]
    Disabled,
    Ready,
    InProgress,
    QueueFull,
    Unavailable,
}

impl AutoDownload {
    /// What to tell the person after saving `title`.
    pub fn said(self, title: &str) -> String {
        match self {
            AutoDownload::Queued => format!("Saved {title}. Its audio is downloading."),
            AutoDownload::InProgress => format!("Saved {title}. Its audio is already downloading."),
            AutoDownload::QueueFull => format!("Saved {title}. The download queue is full, so download it later."),
            AutoDownload::Ready | AutoDownload::Disabled | AutoDownload::Unavailable => format!("Saved {title}"),
        }
    }
}

/// The local date in `iso` (`2026-11-09T…`) as "9 Nov 2026", for lists of devices.
pub fn day(iso: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = iso.get(..10).unwrap_or_default().split('-').map(|p| p.parse::<usize>().ok());
    match (parts.next().flatten(), parts.next().flatten(), parts.next().flatten()) {
        (Some(y), Some(m @ 1..=12), Some(d)) => format!("{d} {} {y}", MONTHS[m - 1]),
        _ => iso.to_owned(),
    }
}
