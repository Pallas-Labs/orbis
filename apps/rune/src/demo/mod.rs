//! Made-up data for headless renders, `ORBIS_RUNE_DEMO=1` and the goldens, and the scenes
//! `--scene` names. Every state the person can see has a scene: full, empty, loading, failed and
//! long text for each screen, and each dialog and menu. A screenshot never holds anyone's real
//! Library.

mod data;

use rune::TextEdit;

use crate::account::Method;
use crate::dialogs::Dialog;
use crate::model::{Approval, Download, Queue, SignInCode, Tracklist, TracklistState};
use crate::playing::Status;
use crate::playlists::focused;
use crate::rows::{Place, SetMenu};
use crate::{App, Screen};

use data::{LONG_CREATOR, LONG_TITLE};

/// A scene: its name for `--scene`, and what it does to the demo app.
pub type Scene = (&'static str, fn(&mut App));

pub const SCENES: &[Scene] = &[
    ("library", |_| {}),
    ("library-search", |s| s.library.query = TextEdit::new("harbour")),
    ("library-tag", |s| s.library.tag = Some("morning".to_owned())),
    ("library-empty", empty_library),
    ("library-loading", |s| {
        s.library.sets.data = None;
        s.library.sets.begin();
    }),
    ("library-failed", |s| {
        s.library.sets.data = None;
        s.library.sets.land(Err("Couldn't reach Orbis at https://orbis.example".to_owned()));
    }),
    ("library-long", |s| {
        let mut long = data::set("long", LONG_TITLE, LONG_CREATOR, Some(14_520.0), Download::Ready);
        long.tags = vec!["a tag that runs on for a while".to_owned(), "deep".to_owned(), "late".to_owned()];
        s.library.sets.data.get_or_insert_default().insert(0, long.clone());
        s.playing.demo(long, 9_000.0, Status::Playing, Some(data::tracklist(true)));
    }),
    ("library-menu", |s| s.menu = Some(SetMenu { id: "s-ferry".to_owned(), place: Place::Library, at: None, sub: true })),
    ("library-save", |s| s.dialog = Some(Dialog::SaveLink { edit: focused("https://www.youtube.com/watch?v=lane0001"), busy: false, error: None })),
    ("library-save-failed", |s| {
        s.dialog = Some(Dialog::SaveLink { edit: TextEdit::new("https://example.com/not-a-set"), busy: false, error: Some("Orbis saves YouTube, SoundCloud and Apple Music links".to_owned()) });
    }),
    ("library-tags", |s| {
        s.dialog = Some(Dialog::Tags {
            set: "s-sunrise".to_owned(),
            title: "Sunrise on the Pier".to_owned(),
            tags: vec!["morning".to_owned(), "ambient".to_owned()],
            edit: focused("sea"),
            busy: false,
            error: None,
        });
    }),
    ("library-remove", |s| s.dialog = Some(Dialog::RemoveSet { id: "s-glass".to_owned(), title: "Glasshouse Mix".to_owned() })),
    ("toast", |s| s.say("Low Tide Dub plays next".to_owned())),
    ("listening", |s| s.presence.listening = data::listening(s.library.sets.data.as_deref().unwrap_or_default())),
    ("playlist", open_morning),
    ("playlist-empty", |s| {
        open_morning(s);
        if let Some(p) = s.playlists.open.data.as_mut() {
            p.sets.clear();
        }
    }),
    ("playlist-loading", |s| {
        s.screen = Screen::Playlist("p-morning".to_owned());
        s.playlists.open.begin();
    }),
    ("playlist-failed", |s| {
        s.screen = Screen::Playlist("p-morning".to_owned());
        s.playlists.open.land(Err("Orbis answered 500".to_owned()));
    }),
    ("playlist-menu", |s| {
        open_morning(s);
        s.playlist_menu = true;
    }),
    ("playlist-new", |s| s.dialog = Some(Dialog::NewPlaylist { edit: focused("Late Drive"), add: None, busy: false, error: None })),
    ("playlist-delete", |s| {
        open_morning(s);
        s.dialog = Some(Dialog::DeletePlaylist { id: "p-morning".to_owned(), name: "Morning".to_owned() });
    }),
    ("queue", |s| s.screen = Screen::Queue),
    ("queue-empty", |s| {
        s.screen = Screen::Queue;
        s.queue.items.data = Some(Queue::default());
        s.playing = Default::default();
    }),
    ("queue-loading", |s| {
        s.screen = Screen::Queue;
        s.queue.items.data = None;
        s.queue.items.begin();
    }),
    ("queue-failed", |s| {
        s.screen = Screen::Queue;
        s.queue.items.data = None;
        s.queue.items.land(Err("Orbis answered 500".to_owned()));
    }),
    ("playing", |s| {
        s.screen = Screen::Playing;
        s.playing.status = Status::Playing;
    }),
    ("playing-empty", |s| {
        s.screen = Screen::Playing;
        s.playing = Default::default();
    }),
    ("playing-loading", |s| {
        s.screen = Screen::Playing;
        let x = s.library.sets.data.as_ref().unwrap()[1].clone();
        s.playing.demo(x, 0.0, Status::Loading, None);
    }),
    ("playing-failed", |s| {
        s.screen = Screen::Playing;
        let x = s.library.sets.data.as_ref().unwrap()[2].clone();
        s.playing.demo(x, 312.0, Status::Failed("Playing needs mpv, and this computer doesn't have it. Install mpv, then press Play again.".to_owned()), None);
        s.playing.tracklist.land(Err("Orbis answered 500".to_owned()));
    }),
    ("playing-no-tracklist", |s| {
        s.screen = Screen::Playing;
        let x = s.library.sets.data.as_ref().unwrap()[3].clone();
        s.playing.demo(x, 60.0, Status::Paused, Some(Tracklist { cues: Vec::new(), state: TracklistState::Pending }));
    }),
    ("playing-long", |s| {
        s.screen = Screen::Playing;
        let mut long = data::set("long", LONG_TITLE, LONG_CREATOR, Some(14_520.0), Download::Ready);
        long.tags = vec!["a tag that runs on for a while".to_owned(), "deep".to_owned()];
        s.playing.demo(long, 9_000.0, Status::Playing, Some(data::tracklist(true)));
    }),
    ("settings", |s| s.screen = Screen::Settings),
    ("settings-code", |s| {
        s.screen = Screen::Settings;
        s.account.code.land(Ok(SignInCode { code: "K7Q2M9XH".to_owned(), expires_at: "2027-01-15T08:05:00Z".to_owned() }));
    }),
    ("settings-loading", |s| {
        s.screen = Screen::Settings;
        s.account.me.data = None;
        s.account.devices.data = None;
    }),
    ("settings-approve", |s| {
        s.screen = Screen::Settings;
        s.dialog = Some(Dialog::Approve { edit: focused("482 719"), busy: false, error: None });
    }),
    ("sign-out", |s| {
        s.screen = Screen::Settings;
        s.dialog = Some(Dialog::SignOut);
    }),
    ("sign-in", signed_out),
    ("sign-in-approve", |s| {
        signed_out(s);
        s.account.signin.method = Method::Approve;
        s.account.signin.approval = Some(Approval { code: "482719".to_owned(), expires_at: "2027-01-15T08:02:00Z".to_owned(), secret: "made-up".to_owned() });
    }),
    ("sign-in-join", |s| {
        signed_out(s);
        s.account.signin.method = Method::Join;
        s.account.signin.username = TextEdit::new("avery");
    }),
    ("sign-in-failed", |s| {
        signed_out(s);
        s.account.signin.code = TextEdit::new("ABCD EFGH");
        s.account.signin.error = Some("That code didn't work: it may have expired. Make a new one on your other device.".to_owned());
    }),
];

fn empty_library(s: &mut App) {
    s.library.sets.data = Some(Vec::new());
    s.queue.items.data = Some(Queue::default());
    s.playlists.lists.data = Some((Vec::new(), Vec::new()));
    s.playing = Default::default();
}

fn open_morning(s: &mut App) {
    s.screen = Screen::Playlist("p-morning".to_owned());
    let detail = data::morning(s.library.sets.data.as_deref().unwrap_or_default());
    s.playlists.open.land(Ok(detail));
}

fn signed_out(s: &mut App) {
    let (artwork, diagnostics) = (std::mem::take(&mut s.artwork), std::mem::take(&mut s.diagnostics));
    *s = App { signed_out: true, artwork, diagnostics, ..App::new() };
}

/// The demo app's data, before a scene changes it: a Library, Playlists, a queue of four with
/// the first active and that Set paused part-way, and the account.
pub fn fill(s: &mut App) {
    let library = data::sets();
    let entries = vec![library[0].clone(), library[1].clone(), library[3].clone(), library[2].clone()];
    s.queue.items.data = Some(Queue { active_set_id: Some(library[0].id.clone()), entries });
    s.playing.demo(library[0].clone(), library[0].playback_position_seconds, Status::Paused, Some(data::tracklist(false)));
    s.playlists.lists.data = Some(data::playlists());
    s.account.me.data = Some(data::me());
    s.account.username = TextEdit::new("avery");
    s.account.devices.data = Some(data::devices());
    s.library.sets.data = Some(library);
}

/// Made-up Artwork for every Set the demo shows. Runs in `setup`, once the image cache exists.
pub fn artwork(s: &mut App) {
    let mut sets: Vec<crate::model::Set> = s.library.sets.data.clone().unwrap_or_default();
    sets.extend(s.playing.set.clone());
    sets.extend(s.presence.listening.iter().map(|p| p.set.clone()));
    for x in sets {
        if let Some(url) = &x.artwork_url {
            s.artwork.demo(url, &x.id, 96);
        }
        if let Some(url) = &x.artwork_large_url {
            s.artwork.demo(url, &x.id, 480);
        }
    }
}
