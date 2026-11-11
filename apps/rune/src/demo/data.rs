//! The demo's made-up Library, Playlists, people and devices. Every name here is invented.

use crate::model::{Cue, Device, Download, Me, Person, Playlist, PlaylistDetail, Presence, Role, Set, Source, Tracklist, TracklistState};

pub const LONG_TITLE: &str = "An All-Night Session Recorded Live from the Harbour Warehouse, Parts One Through Four, with the Sunrise Encore and the Crowd Singing Along";
pub const LONG_CREATOR: &str = "The Extremely Long Collective Name of Avery Coast, Harbour Unit and Friends";

pub fn set(id: &str, title: &str, creator: &str, duration: Option<f64>, download: Download) -> Set {
    Set {
        id: id.to_owned(),
        title: title.to_owned(),
        creator: (!creator.is_empty()).then(|| creator.to_owned()),
        duration_seconds: duration,
        download_state: download,
        source: Source::Youtube,
        artwork_url: Some(format!("demo:{id}")),
        artwork_large_url: Some(format!("demo-large:{id}")),
        created_at: "2026-11-01T09:00:00Z".to_owned(),
        ..Set::default()
    }
}

/// The demo Library: ready Sets, one downloading, one never downloaded, one that failed, one
/// with no Artwork, and an Apple Music album.
pub fn sets() -> Vec<Set> {
    let mut list = vec![
        set("s-sunrise", "Sunrise on the Pier", "Avery Coast", Some(3_492.0), Download::Ready),
        set("s-low-tide", "Low Tide Dub", "Harbour Unit", Some(4_210.0), Download::Ready),
        set("s-ferry", "Night Ferry", "Avery Coast", Some(2_745.0), Download::Ready),
        set("s-static", "Salt and Static", "Mira Holt", Some(5_403.0), Download::Ready),
        set("s-last-light", "Last Light Session", "Harbour Unit", Some(3_600.0), Download::Downloading),
        set("s-dunes", "Dune Radio 41", "Ines Varga", Some(7_198.0), Download::None),
        set("s-glass", "Glasshouse Mix", "Theo Brandt", None, Download::Failed),
        set("s-apple", "Coastline Selections, Vol. 2", "Mira Holt", Some(4_580.0), Download::Ready),
        set("s-tram", "Tram Lines at Dawn", "Ines Varga", Some(3_311.0), Download::Ready),
    ];
    list[7].source = Source::AppleMusic;
    list[6].artwork_url = None;
    list[6].artwork_large_url = None;
    list[0].playback_position_seconds = 1_421.0;
    list[0].tags = vec!["morning".to_owned(), "ambient".to_owned()];
    list[1].tags = vec!["dub".to_owned()];
    list[3].tags = vec!["ambient".to_owned()];
    list[8].tags = vec!["morning".to_owned()];
    for x in [0, 2, 8] {
        list[x].playlist_ids = vec!["p-morning".to_owned()];
    }
    list[1].playlist_ids = vec!["p-harbour".to_owned()];
    list
}

/// A Tracklist of made-up Cues. `long` gives them long names.
pub fn tracklist(long: bool) -> Tracklist {
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

pub fn person(id: &str, name: &str) -> Person {
    Person { id: id.to_owned(), username: name.to_owned() }
}

/// Two own Playlists and one Collaborative Playlist someone else made.
pub fn playlists() -> (Vec<Playlist>, Vec<Playlist>) {
    let list = |id: &str, name: &str, n: usize, creator: Option<Person>| Playlist { id: id.to_owned(), name: name.to_owned(), set_count: n, creator };
    (vec![list("p-morning", "Morning", 3, None), list("p-harbour", "Harbour Nights", 1, None)], vec![list("p-road", "Road Trip", 2, Some(person("u-mira", "mira")))])
}

/// The Morning Playlist's page.
pub fn morning(library: &[Set]) -> PlaylistDetail {
    let sets = ["s-sunrise", "s-ferry", "s-tram", "s-static"].iter().filter_map(|id| library.iter().find(|x| x.id == *id).cloned()).collect();
    PlaylistDetail { id: "p-morning".to_owned(), name: "Morning".to_owned(), creator: person("u-me", "avery"), role: Role::Creator, sets }
}

pub fn me() -> Me {
    Me { id: "u-me".to_owned(), username: "avery".to_owned(), auto_download: true, social: true, host: false }
}

pub fn devices() -> Vec<Device> {
    let device = |id: &str, label: &str, used: Option<&str>, current: bool| Device {
        id: id.to_owned(),
        label: label.to_owned(),
        added_at: "2026-09-14T10:00:00Z".to_owned(),
        last_used_at: used.map(str::to_owned),
        current,
    };
    vec![device("d-here", "Orbis for Linux", Some("2027-01-15T07:58:00Z"), true), device("d-phone", "iPhone", Some("2027-01-14T21:10:00Z"), false), device("d-tv", "Living Room TV", None, false)]
}

/// Two people in the Group, listening now.
pub fn listening(library: &[Set]) -> Vec<Presence> {
    let at = |id: &str| library.iter().find(|x| x.id == id).cloned().unwrap_or_default();
    vec![Presence { person_id: "u-mira".to_owned(), username: "mira".to_owned(), set: at("s-low-tide") }, Presence { person_id: "u-theo".to_owned(), username: "theo".to_owned(), set: at("s-tram") }]
}
