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
