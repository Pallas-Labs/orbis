//! The calls to the Orbis API (`packages/contracts/src/http-api.ts`). Each answers what the app
//! reads, or words the person can act on.

use serde::Deserialize;
use serde_json::{Value, json};

use super::{As, Failure, Server, exchange, request, segment};
use crate::model::{Approval, ApprovalWait, AutoDownload, Device, Me, Playlist, PlaylistDetail, Queue, Set, SignInCode, SignedIn, Tracklist};

#[derive(Deserialize)]
struct Sets {
    sets: Vec<Set>,
}

#[derive(Deserialize)]
struct QueueReply {
    queue: Queue,
}

fn set_path(id: &str, rest: &str) -> String {
    format!("/sets/{}{rest}", segment(id))
}

fn playlist_path(id: &str, rest: &str) -> String {
    format!("/playlists/{}{rest}", segment(id))
}

fn queue_call(method: &str, path: &str, body: Value) -> Result<Queue, String> {
    request::<QueueReply>(method, path, Some(body)).map(|r| r.queue)
}

// The Library.

/// The caller's Library, newest first as the server orders it.
pub fn library() -> Result<Vec<Set>, String> {
    request::<Sets>("GET", "/sets", None).map(|r| r.sets)
}

/// Saves a Source Link to the Library, and says whether its Download started.
pub fn save(url: &str) -> Result<(Set, AutoDownload), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Saved {
        #[serde(flatten)]
        set: Set,
        auto_download_result: AutoDownload,
    }
    let saved: Saved = request("POST", "/sets", Some(json!({ "url": url.trim() })))?;
    Ok((saved.set, saved.auto_download_result))
}

/// Takes a Set out of the caller's Library.
pub fn remove(id: &str) -> Result<Set, String> {
    request("DELETE", &set_path(id, ""), None)
}

/// Replaces a Set's Tags.
pub fn set_tags(id: &str, tags: &[String]) -> Result<Set, String> {
    request("PATCH", &set_path(id, "/tags"), Some(json!({ "tags": tags })))
}

/// Saves where the caller is in `id`, in whole seconds.
pub fn save_position(id: &str, seconds: f64) -> Result<Set, String> {
    request("PUT", &set_path(id, "/position"), Some(json!({ "seconds": seconds.clamp(0.0, 604_800.0).floor() })))
}

/// A Set's Tracklist.
pub fn tracklist(id: &str) -> Result<Tracklist, String> {
    request("GET", &set_path(id, "/tracklist"), None)
}

/// Asks Orbis to make Retained Audio for `id`.
pub fn download(id: &str) -> Result<Set, String> {
    request("POST", &set_path(id, "/audio/download"), None)
}

/// An address a player can stream `id`'s audio from without the key: the API signs the audio
/// route for a day (ADR 0007). Refuses a grant for any other route.
pub fn stream_url(id: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Grant {
        url: String,
    }
    let grant: Grant = request("POST", &set_path(id, "/audio/grant"), None)?;
    if !grant.url.starts_with(&set_path(id, "/audio?")) {
        return Err("Orbis granted audio for another address".to_owned());
    }
    let base = Server::for_call().map(|s| s.url).unwrap_or_default();
    Ok(format!("{base}{}", grant.url))
}

// The Listening Queue.

/// The caller's Listening Queue.
pub fn queue() -> Result<Queue, String> {
    request::<QueueReply>("GET", "/queue", None).map(|r| r.queue)
}

/// Makes `id` the active Set, keeping the rest of the queue.
pub fn play(id: &str) -> Result<Queue, String> {
    queue_call("PUT", "/queue/active", json!({ "setId": id }))
}

/// Where a Set joins the queue: right after the active one, or at the end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    Next,
    End,
}

/// Puts `id` in the queue.
pub fn enqueue(id: &str, placement: Placement) -> Result<Queue, String> {
    let placement = if placement == Placement::Next { "next" } else { "end" };
    queue_call("POST", "/queue/entries", json!({ "setId": id, "placement": placement }))
}

/// Tells Orbis `id` played to its end: it leaves the queue and the next Set becomes active.
pub fn complete(id: &str) -> Result<Queue, String> {
    queue_call("POST", "/queue/completion", json!({ "setId": id }))
}

/// Replaces the queue with a Playlist's playable Sets, in order or shuffled.
pub fn play_playlist(id: &str, shuffled: bool) -> Result<Queue, String> {
    queue_call("PUT", "/queue/playlist", json!({ "playlistId": id, "order": if shuffled { "shuffled" } else { "playlist" } }))
}

// Playlists.

#[derive(Deserialize)]
struct Playlists {
    playlists: Vec<Playlist>,
}

/// The caller's own Playlists, and the Collaborative ones they edit.
pub fn playlists() -> Result<(Vec<Playlist>, Vec<Playlist>), String> {
    let own = request::<Playlists>("GET", "/playlists", None)?.playlists;
    let shared = request::<Playlists>("GET", "/playlists/shared", None)?.playlists;
    Ok((own, shared))
}

/// One Playlist with its Sets.
pub fn playlist(id: &str) -> Result<PlaylistDetail, String> {
    request("GET", &playlist_path(id, ""), None)
}

/// Makes a Playlist.
pub fn create_playlist(name: &str) -> Result<Playlist, String> {
    request("POST", "/playlists", Some(json!({ "name": name.trim() })))
}

/// Renames a Playlist.
pub fn rename_playlist(id: &str, name: &str) -> Result<Playlist, String> {
    request("PATCH", &playlist_path(id, ""), Some(json!({ "name": name.trim() })))
}

/// Deletes a Playlist. Its Sets stay in the Library.
pub fn delete_playlist(id: &str) -> Result<Playlist, String> {
    request("DELETE", &playlist_path(id, ""), None)
}

/// Replaces a Playlist's Sets, in this order.
pub fn set_members(id: &str, set_ids: &[String]) -> Result<Vec<Set>, String> {
    request::<Sets>("PUT", &playlist_path(id, "/sets"), Some(json!({ "setIds": set_ids }))).map(|r| r.sets)
}

// The Person and their devices.

/// The signed-in Person.
pub fn me() -> Result<Me, String> {
    request("GET", "/me", None)
}

/// A change to the Person's settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeChange {
    AutoDownload(bool),
    Social(bool),
    Username(String),
}

/// Changes one of the Person's settings.
pub fn update_me(change: &MeChange) -> Result<Me, String> {
    let body = match change {
        MeChange::AutoDownload(on) => json!({ "autoDownload": on }),
        MeChange::Social(on) => json!({ "social": on }),
        MeChange::Username(name) => json!({ "username": name.trim() }),
    };
    request("PATCH", "/me", Some(body))
}

/// The devices signed in as the Person.
pub fn devices() -> Result<Vec<Device>, String> {
    #[derive(Deserialize)]
    struct Devices {
        devices: Vec<Device>,
    }
    request::<Devices>("GET", "/me/devices", None).map(|d| d.devices)
}

/// Signs a device out by removing its key.
pub fn revoke_device(id: &str) -> Result<Device, String> {
    request("DELETE", &format!("/me/devices/{}", segment(id)), None)
}

/// A Sign-in Code for the Person's next device.
pub fn sign_in_code() -> Result<SignInCode, String> {
    request("POST", "/me/sign-in-codes", None)
}

/// Approves the signed-out device showing `code`, so it signs in as this Person.
pub fn approve(code: &str) -> Result<(), String> {
    request::<Value>("POST", "/me/sign-in-requests/approve", Some(json!({ "code": code }))).map(drop)
}

// Signing in, with no key yet (ADR 0020).

/// The name this device goes by on the Person's Devices list.
pub fn device_label() -> String {
    let system = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "Mac",
        "windows" => "Windows",
        other => other,
    };
    format!("Orbis for {system}")
}

/// Signs in with a Sign-in Code from a signed-in device.
pub fn redeem(url: &str, code: &str) -> Result<SignedIn, Failure> {
    exchange(As::Nobody, Some(url), "POST", "/sign-in/code", Some(json!({ "code": code, "label": device_label() })))
}

/// Joins the Group with its Group Passcode, as a new Person.
pub fn join(url: &str, username: &str, passcode: &str) -> Result<SignedIn, Failure> {
    exchange(As::Nobody, Some(url), "POST", "/sign-in/join", Some(json!({ "username": username.trim(), "passcode": passcode, "label": device_label() })))
}

/// Starts an Approval Request: a code this device shows for a signed-in Person to approve.
pub fn start_approval(url: &str) -> Result<Approval, Failure> {
    let platform = if cfg!(target_os = "macos") { "macOS" } else { "web" };
    exchange(As::Nobody, Some(url), "POST", "/sign-in/requests", Some(json!({ "label": device_label(), "platform": platform })))
}

/// Waits a while for the request to be approved.
pub fn wait_approval(url: &str, secret: &str) -> Result<ApprovalWait, Failure> {
    exchange(As::Nobody, Some(url), "POST", "/sign-in/requests/wait", Some(json!({ "secret": secret })))
}

// Presence and playback reports.

/// A Presence action (ADR 0019): `body` is the whole action.
pub fn presence(body: Value) -> Result<u64, Failure> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Session {
        owner_generation: u64,
    }
    #[derive(Deserialize)]
    struct Answer {
        session: Session,
    }
    exchange::<Answer>(As::Device, None, "POST", "/presence/actions", Some(body)).map(|a| a.session.owner_generation)
}

/// A batch of playback history. Answers how many entries the relay accepted.
pub fn diagnostics(batch: Value) -> Result<u64, Failure> {
    #[derive(Deserialize)]
    struct Receipt {
        accepted: u64,
    }
    exchange::<Receipt>(As::Device, None, "POST", "/diagnostics/playback", Some(batch)).map(|r| r.accepted)
}

/// A Set's Artwork bytes from its provider, at most 4 MB.
#[cfg(not(test))]
pub fn artwork(url: &str) -> Result<Vec<u8>, String> {
    super::http::fetch(url, 4 << 20)
}

#[cfg(test)]
pub fn artwork(_url: &str) -> Result<Vec<u8>, String> {
    Err("tests fetch no Artwork".to_owned())
}
