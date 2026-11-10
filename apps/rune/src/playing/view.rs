//! Now Playing, and the bar at the foot of the other screens: the Set, its place, the
//! controls and the Tracklist with the Cue playing now.

use rune::{Cursor, El, Icon, Phase, ScrollSpec, TextStyle, col, el, icon, row, text};
use rune_kit::{Button, ButtonVariant, IconButton, IconButtonVariant, Spinner};

use super::{AHEAD, BACK, State, Status};
use crate::model::{Source, TracklistState, clock_time};
use crate::theme::{self, Look};
use crate::{App, Screen};

/// The Now Playing screen.
pub fn screen(s: &App, l: &Look) -> El {
    let p = &s.playing;
    let Some(set) = &p.set else { return nothing(l) };
    let big = TextStyle { size: 22.0, line_height: 28.0, ..l.k.ty.body_medium };
    let mut about = col()
        .key("about")
        .grow(1.0)
        .shrink()
        .gap(6.0)
        .child(text(set.title.clone()).key("set-title").font(big).color(l.fg).wrap())
        .children(set.creator.clone().map(|c| text(c).key("set-creator").font(l.k.ty.body).color(l.muted).wrap()))
        .child(text(facts(set.source, set.tags.as_slice())).key("set-facts").font(l.k.ty.small).color(l.faint).wrap());
    if let Status::Failed(why) = &p.status {
        about = about.child(text(why.clone()).key("set-problem").font(l.k.ty.ui).color(l.k.c.danger.fg).wrap());
    }
    let head = row().w_full().gap(24.0).items_center().child(l.tile(&set.id, &set.title, 152.0)).child(about);
    let body = col().key("now-playing").w_full().max_w(760.0).padding(32.0).gap(24.0).child(head).child(scrubber(p, l)).child(controls(p, l)).child(tracklist(p, l));
    col().key("playing-scroll").w_full().h_full().min_h(0.0).items_center().scroll(ScrollSpec { stick_bottom: false }).child(body)
}

fn facts(source: Source, tags: &[String]) -> String {
    let source = match source {
        Source::Youtube => "YouTube",
        Source::Soundcloud => "SoundCloud",
        Source::AppleMusic => "Apple Music",
    };
    std::iter::once(source).chain(tags.iter().map(String::as_str)).collect::<Vec<_>>().join(" · ")
}

fn nothing(l: &Look) -> El {
    col()
        .key("nothing-playing")
        .w_full()
        .h_full()
        .center()
        .gap(8.0)
        .child(icon(&theme::WAVE, 28.0).color(l.faint))
        .child(text("Nothing is playing").font(l.title).color(l.fg))
        .child(text("Choose a Set in the Library, or play the Listening Queue.").font(l.k.ty.ui).color(l.muted))
        .child(el().h(8.0))
        .child(Button::new("Open Library").variant(ButtonVariant::Neutral).on_press(|s: &mut App| s.go(Screen::Library)).build(&l.k).key("open-library"))
}

/// The place in the Set: a bar to press or drag, and the time played and left.
fn scrubber(p: &State, l: &Look) -> El {
    let rail = el().w_full().h(4.0).radius(2.0).fill(l.fg.alpha(0.12)).child(el().key("seek-fill").h_full().w_frac(p.progress()).radius(2.0).fill(l.accent).transition(rune::Transition::none()));
    let seek = col().key("seek").role("slider").label("Place in the Set").w_full().h(16.0).justify_center().cursor(Cursor::Pointer).child(rail).on_drag(|s: &mut App, drag, _| {
        let Some(d) = s.playing.duration else { return };
        let at = f64::from((drag.x / drag.w.max(1.0)).clamp(0.0, 1.0)) * d;
        if drag.phase == Phase::Up {
            s.seek(at);
        } else {
            s.playing.position = at;
        }
    });
    let left = p.duration.map_or_else(|| "–:––".to_owned(), |d| format!("−{}", clock_time(d - p.position)));
    let times = row().w_full().justify_between().child(text(clock_time(p.position)).key("elapsed").font(l.figures).color(l.muted)).child(text(left).key("remaining").font(l.figures).color(l.muted));
    col().w_full().gap(6.0).child(seek).child(times)
}

fn controls(p: &State, l: &Look) -> El {
    let small = |glyph: &'static Icon, key: &str, label: &str, press: fn(&mut App)| {
        IconButton::new(glyph).variant(IconButtonVariant::Ghost).label(label).help(label).on_press(press).build(&l.k).key(key.to_owned())
    };
    row()
        .key("controls")
        .w_full()
        .center()
        .gap(16.0)
        .child(small(&theme::BACK, "back", "Back 15 seconds", |s| s.seek(s.playing.position - BACK)))
        .child(play_button(p, l, 48.0, "play"))
        .child(small(&theme::AHEAD, "ahead", "Ahead 30 seconds", |s| s.seek(s.playing.position + AHEAD)))
        .child(small(&theme::NEXT, "next", "Next Set", |s| s.next()))
}

/// The round Play and Pause button, or a spinner while the stream starts.
fn play_button(p: &State, l: &Look, size: f32, key: &str) -> El {
    let ink = l.k.on(rune::Color::WHITE, l.accent);
    let (glyph, label) = if p.status == Status::Playing { (&theme::PAUSE, "Pause") } else { (&theme::PLAY, "Play") };
    let face = if p.status == Status::Loading { Spinner::new().size(size * 0.4).color(ink).build(&l.k) } else { icon(glyph, size * 0.4).color(ink) };
    row()
        .key(key.to_owned())
        .role("button")
        .label(if p.status == Status::Loading { "Loading" } else { label })
        .focusable(true)
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .size(size, size)
        .radius(size / 2.0)
        .fill(l.accent)
        .hover(l.fg.alpha(0.08))
        .center()
        .child(face.transition(rune::Transition::none()))
        .on_press(|s: &mut App| s.toggle())
}

fn tracklist(p: &State, l: &Look) -> El {
    let label = text("Tracklist").font(l.title).color(l.muted);
    let note = |words: &str| text(words.to_owned()).key("tracklist-note").font(l.k.ty.ui).color(l.muted).wrap();
    let body = match (&p.tracklist.data, p.tracklist.busy) {
        (None, true) => note("Finding the Tracklist…"),
        (None, false) => note(&p.tracklist.error.as_ref().map_or_else(|| "No Tracklist".to_owned(), |why| format!("Couldn't load the Tracklist: {why}"))),
        (Some(list), _) if list.cues.is_empty() => note(match list.state {
            TracklistState::Pending => "Orbis is still identifying this Set's Tracklist.",
            TracklistState::Failed => "Orbis couldn't identify this Set's Tracklist.",
            TracklistState::Ready | TracklistState::None => "This Set has no Tracklist.",
        }),
        (Some(list), _) => {
            let now = list.cue_at(p.position);
            col().key("cues").w_full().children(list.cues.iter().enumerate().map(|(i, cue)| {
                let on = now == Some(i);
                let start = cue.start_seconds;
                let time = text(start.map_or_else(String::new, clock_time)).font(l.figures).color(if on { l.accent } else { l.faint });
                let words = col()
                    .grow(1.0)
                    .shrink()
                    .gap(2.0)
                    .child(text(cue.title.clone()).font(l.title).color(if on { l.accent } else { l.fg }).wrap())
                    .child(text(cue.artist.clone()).font(l.k.ty.small).color(l.muted).wrap());
                let mut r = row()
                    .key(format!("cue-{i}"))
                    .role("button")
                    .label(format!("{} by {}", cue.title, cue.artist))
                    .w_full()
                    .gap(12.0)
                    .px(10.0)
                    .py(8.0)
                    .radius(l.k.radius.md)
                    .items_center()
                    .child(el().w(52.0).child(time))
                    .child(words);
                if on {
                    r = r.fill(l.accent.alpha(0.14));
                }
                match start {
                    Some(at) => r.focusable(true).cursor(Cursor::Pointer).hover(l.k.c.hover).on_press(move |s: &mut App| s.seek(at)),
                    None => r,
                }
            }))
        }
    };
    col().key("tracklist").w_full().gap(8.0).child(label).child(body)
}

/// The bar at the foot of the Library and the queue: what plays, its controls and its place.
/// `None` with nothing loaded.
pub fn bar(s: &App, l: &Look) -> Option<El> {
    let p = &s.playing;
    let set = p.set.as_ref()?;
    let line = |t: String, style, ink| text(t).font(style).color(ink).truncate();
    let about = row()
        .key("bar-open")
        .role("button")
        .label(format!("Open Now Playing: {}", set.title))
        .focusable(true)
        .cursor(Cursor::Pointer)
        .grow(1.0)
        .shrink()
        .gap(10.0)
        .items_center()
        .radius(l.k.radius.md)
        .padding(4.0)
        .hover(l.k.c.hover)
        .on_press(|s: &mut App| s.go(Screen::Playing))
        .child(l.tile(&set.id, &set.title, 32.0))
        .child(col().grow(1.0).shrink().gap(2.0).child(line(set.title.clone(), l.title, l.fg)).child(match &p.status {
            Status::Failed(why) => line(why.clone(), l.k.ty.small, l.k.c.danger.fg),
            _ => line(set.creator.clone().unwrap_or_default(), l.k.ty.small, l.muted),
        }));
    let left = p.duration.map_or_else(String::new, |d| format!("{} / {}", clock_time(p.position), clock_time(d)));
    let progress = el().w_full().h(2.0).fill(l.rule).child(el().h_full().w_frac(p.progress()).fill(l.accent).transition(rune::Transition::none()));
    let controls = row()
        .gap(6.0)
        .items_center()
        .child(text(left).key("bar-time").font(l.figures).color(l.muted))
        .child(el().w(6.0))
        .child(play_button(p, l, 32.0, "bar-play"))
        .child(IconButton::new(&theme::NEXT).variant(IconButtonVariant::GhostMuted).label("Next Set").help("Next Set").on_press(|s: &mut App| s.next()).build(&l.k).key("bar-next"));
    let strip = row().w_full().px(12.0).py(8.0).gap(12.0).items_center().child(about).child(controls);
    Some(col().key("bar").w_full().child(progress).child(strip))
}
