//! Made-up data for headless renders, `ORBIS_RUNE_DEMO=1` and the goldens, and the scenes
//! `--scene` names. Every state the person can see has a scene: full, empty, loading, failed and
//! long text, for each screen. The Sets, people and Cues here are invented; a screenshot never
//! holds anyone's real Library.

use crate::model::{Cue, Download, Queue, Set, Source, Tracklist, TracklistState};
use crate::playing::Status;
use crate::{App, Screen};

/// A scene: its name for `--scene`, and what it does to the demo app.
pub type Scene = (&'static str, fn(&mut App));

pub const SCENES: &[Scene] = &[
    ("library", |_| {}),
    ("library-search", |s| s.library.query = rune::TextEdit::new("harbour")),
    ("library-empty", |s| {
        s.library.sets.data = Some(Vec::new());
        s.queue.items.data = Some(Queue::default());
        s.playing = Default::default();
    }),
    ("library-loading", |s| {
        s.library.sets.data = None;
        s.library.sets.begin();
    }),
    ("library-failed", |s| {
        s.library.sets.data = None;
        s.library.sets.land(Err("Couldn't reach Orbis at https://orbis.example".to_owned()));
    }),
    ("library-long", |s| {
        let mut long = set("long", LONG_TITLE, LONG_CREATOR, Some(14_520.0), Download::Ready);
        long.tags = vec!["a tag that runs on for a while".to_owned(), "deep".to_owned(), "late".to_owned()];
        let lib = s.library.sets.data.get_or_insert_default();
        lib.insert(0, long.clone());
        s.playing.demo(long, 9_000.0, Status::Playing, Some(tracklist(true)));
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
        let mut long = set("long", LONG_TITLE, LONG_CREATOR, Some(14_520.0), Download::Ready);
        long.tags = vec!["a tag that runs on for a while".to_owned(), "deep".to_owned()];
        s.playing.demo(long, 9_000.0, Status::Playing, Some(tracklist(true)));
    }),
    ("signed-out", |s| {
        *s = App { signed_out: true, ..App::new() };
    }),
    ("toast", |s| s.say("Low Tide Dub plays next".to_owned())),
];

const LONG_TITLE: &str = "An All-Night Session Recorded Live from the Harbour Warehouse, Parts One Through Four, with the Sunrise Encore and the Crowd Singing Along";
const LONG_CREATOR: &str = "The Extremely Long Collective Name of Avery Coast, Harbour Unit and Friends";

fn set(id: &str, title: &str, creator: &str, duration: Option<f64>, download: Download) -> Set {
    Set {
        id: id.to_owned(),
        title: title.to_owned(),
        creator: (!creator.is_empty()).then(|| creator.to_owned()),
        duration_seconds: duration,
        download_state: download,
        source: Source::Youtube,
        playback_position_seconds: 0.0,
        tags: Vec::new(),
    }
}

/// The demo Library: ready Sets, one downloading, one never downloaded, one that failed, and
/// an Apple Music album.
fn sets() -> Vec<Set> {
    let mut list = vec![
        set("s-sunrise", "Sunrise on the Pier", "Avery Coast", Some(3_492.0), Download::Ready),
        set("s-low-tide", "Low Tide Dub", "Harbour Unit", Some(4_210.0), Download::Ready),
        set("s-ferry", "Night Ferry", "Avery Coast", Some(2_745.0), Download::Ready),
        set("s-static", "Salt and Static", "Mira Holt", Some(5_403.0), Download::Ready),
        set("s-last-light", "Last Light Session", "Harbour Unit", Some(3_600.0), Download::Downloading),
        set("s-dunes", "Dune Radio 41", "Ines Varga", Some(7_198.0), Download::None),
        set("s-glass", "Glasshouse Mix", "Theo Brandt", None, Download::Failed),
        set("s-apple", "Coastline Selections, Vol. 2", "Mira Holt", Some(4_580.0), Download::Ready),
    ];
    list[7].source = Source::AppleMusic;
    list[0].playback_position_seconds = 1_421.0;
    list[0].tags = vec!["morning".to_owned(), "ambient".to_owned()];
    list[1].tags = vec!["dub".to_owned()];
    list
}

/// A Tracklist of made-up Cues. `long` gives them long names.
fn tracklist(long: bool) -> Tracklist {
    let cue = |t: &str, a: &str, at: Option<f64>| Cue { title: t.to_owned(), artist: a.to_owned(), start_seconds: at };
    let cues = if long {
        vec![
            cue("Intro (the version with the field recording from the pier before the first kick comes in)", "Avery Coast", Some(0.0)),
            cue("A Very Long Remix Title (Harbour Unit's Twelve-Inch Extended Dub Reinterpretation)", "Harbour Unit, Mira Holt and The Extremely Long Collective", Some(4_800.0)),
            cue("Untitled", "Unknown", None),
            cue("Encore", "Everyone", Some(13_900.0)),
        ]
    } else {
        vec![
            cue("Tide Tables", "Avery Coast", Some(0.0)),
            cue("Gull Song", "Mira Holt", Some(412.0)),
            cue("Breakwater", "Harbour Unit", Some(1_015.0)),
            cue("Ferry Lights", "Avery Coast", Some(1_660.0)),
            cue("ID", "Unknown", None),
            cue("Morning Fog", "Ines Varga", Some(2_480.0)),
            cue("Home Port", "Avery Coast", Some(3_105.0)),
        ]
    };
    Tracklist { cues, state: TracklistState::Ready }
}

/// The demo app's data, before a scene changes it: a Library, a queue of four with the first
/// active, and that Set paused part-way.
pub fn fill(s: &mut App) {
    let library = sets();
    let entries = vec![library[0].clone(), library[1].clone(), library[3].clone(), library[2].clone()];
    s.queue.items.data = Some(Queue { active_set_id: Some(library[0].id.clone()), entries });
    s.playing.demo(library[0].clone(), library[0].playback_position_seconds, Status::Paused, Some(tracklist(false)));
    s.library.sets.data = Some(library);
}
