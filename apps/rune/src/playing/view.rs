//! Now Playing, and the bar at the foot of the other screens. Now Playing shows the Set's large
//! Artwork, its place and controls, and beside them (under them in a narrow window) the
//! Tracklist with the Cue playing now. The bar shows the Set, the controls with a slim seek bar,
//! and a way to the queue.

use rune::{Cursor, El, Icon, Phase, ScrollSpec, col, el, icon, row, text};
use rune_kit::{Button, IconButton, IconButtonVariant, Spinner};

use super::{AHEAD, BACK, State, Status};
use crate::model::{Source, Tracklist, TracklistState, clock_time};
use crate::theme::{self, Look, size};
use crate::{App, Screen};

/// The main pane's width past which Now Playing sets the Tracklist beside the Set.
const WIDE: f32 = 760.0;

/// The Now Playing screen. `width` is the pane's, when laid out.
pub fn screen(s: &App, l: &Look, width: Option<f32>) -> El {
    let p = &s.playing;
    let Some(set) = &p.set else {
        return l.empty(
            "nothing-playing",
            "Nothing is playing",
            "Choose a Set in the Library, or play a Playlist.",
            Some(Button::new("Open Library").on_press(|s: &mut App| s.go(Screen::Library)).build(&l.k).key("open-library")),
        );
    };
    let wide = width.is_none_or(|w| w >= WIDE);
    let side = 300.0;
    let art = l.art(&s.artwork, set.artwork_large_url.as_deref().or(set.artwork_url.as_deref()), &set.id, &set.title, side).key("playing-art").shadow(8.0, 24.0, rune::Color::BLACK.alpha(0.22));
    let mut about = col()
        .key("about")
        .w_full()
        .gap(4.0)
        .child(text(set.title.clone()).key("set-title").font(l.display).color(l.fg).wrap())
        .children(set.creator.clone().map(|c| text(c).key("set-creator").font(l.k.ty.body).color(l.muted).wrap()))
        .child(text(facts(set.source, &set.tags)).key("set-facts").font(l.k.ty.small).color(l.faint).wrap());
    if let Status::Failed(why) = &p.status {
        about = about.child(text(why.clone()).key("set-problem").font(l.k.ty.ui).color(l.k.c.danger.fg).wrap().pt(4.0));
    }
    let player = col().key("player").w(side).gap(20.0).child(art).child(about).child(scrubber(p, l, "seek", 16.0)).child(controls(p, l));
    let list = tracklist(p, l);
    let body = if wide {
        row().key("now-playing").w_full().max_w(1040.0).px(32.0).pt(24.0).pb(32.0).gap(40.0).items_start().child(player).child(list.grow(1.0).shrink())
    } else {
        col().key("now-playing").w_full().px(size::PAGE_X).pt(16.0).pb(32.0).gap(28.0).items_center().child(player).child(list.max_w(560.0))
    };
    col().key("playing-scroll").w_full().h_full().min_h(0.0).items_center().scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(body)
}

fn facts(source: Source, tags: &[String]) -> String {
    let source = match source {
        Source::Youtube => "YouTube",
        Source::Soundcloud => "SoundCloud",
        Source::AppleMusic => "Apple Music",
    };
    std::iter::once(source).chain(tags.iter().map(String::as_str)).collect::<Vec<_>>().join(" · ")
}

/// The place in the Set: a 4 pt track to press or drag, whose knob shows under the pointer, and
/// the time played and left under it. Arrow keys step it 15 s.
fn scrubber(p: &State, l: &Look, key: &str, height: f32) -> El {
    let knob = el().size(12.0, 12.0).radius(6.0).fill(l.fg).shadow(1.0, 3.0, rune::Color::BLACK.alpha(0.3)).mr(-6.0).group_opacity(0.0, 1.0);
    let fill = row().key(format!("{key}-fill")).h_full().w_frac(p.progress()).radius(2.0).fill(l.accent).justify_end().items_center().child(knob).transition(rune::Transition::none());
    let rail = row().w_full().h(4.0).radius(2.0).fill(l.fg.alpha(0.12)).child(fill);
    let duration = p.duration.unwrap_or(0.0);
    col()
        .key(key.to_owned())
        .role("slider")
        .label("Place in the Set")
        .range_value(p.position, 0.0, duration)
        .focusable(true)
        .hover_group_focus()
        .w_full()
        .h(height)
        .justify_center()
        .cursor(Cursor::Pointer)
        .child(rail)
        .on_step(|s: &mut App, step, _| s.skip(f64::from(step) * BACK))
        .on_drag(|s: &mut App, drag, _| {
            let Some(d) = s.playing.duration else { return };
            let at = f64::from((drag.x / drag.w.max(1.0)).clamp(0.0, 1.0)) * d;
            if drag.phase == Phase::Up {
                s.seek(at);
            } else {
                s.playing.position = at;
            }
        })
}

fn times(p: &State, l: &Look) -> (El, El) {
    let left = p.duration.map_or_else(|| "–:––".to_owned(), |d| format!("−{}", clock_time(d - p.position)));
    (text(clock_time(p.position)).key("elapsed").font(l.figures).color(l.muted), text(left).key("remaining").font(l.figures).color(l.muted))
}

fn small(l: &Look, glyph: &'static Icon, key: &str, label: &str, press: fn(&mut App)) -> El {
    IconButton::new(glyph).variant(IconButtonVariant::Ghost).label(label).help(label).on_press(press).build(&l.k).key(key.to_owned())
}

fn controls(p: &State, l: &Look) -> El {
    let (elapsed, remaining) = times(p, l);
    let buttons = row()
        .key("controls")
        .w_full()
        .center()
        .gap(20.0)
        .child(small(l, &theme::BACK, "back", "Back 15 seconds", |s| s.skip(-BACK)))
        .child(play_button(p, l, 52.0, "play"))
        .child(small(l, &theme::AHEAD, "ahead", "Ahead 30 seconds", |s| s.skip(AHEAD)))
        .child(small(l, &theme::NEXT, "next", "Next Set", |s| s.next()));
    col().w_full().gap(14.0).child(row().w_full().mt(-14.0).justify_between().child(elapsed).child(remaining)).child(buttons)
}

/// The round Play and Pause button, or a spinner while the stream starts.
fn play_button(p: &State, l: &Look, side: f32, key: &str) -> El {
    let ink = l.k.on(rune::Color::WHITE, l.accent);
    let (glyph, label) = if p.status == Status::Playing { (&theme::PAUSE, "Pause") } else { (&theme::PLAY, "Play") };
    let face = if p.status == Status::Loading { Spinner::new().size(side * 0.38).color(ink).build(&l.k) } else { icon(glyph, side * 0.4).color(ink) };
    row()
        .key(key.to_owned())
        .role("button")
        .label(if p.status == Status::Loading { "Loading" } else { label })
        .focusable(true)
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .size(side, side)
        .radius(side / 2.0)
        .fill(l.accent)
        .hover(rune::Color::WHITE.alpha(0.1))
        .center()
        .child(face.transition(rune::Transition::none()))
        .on_press(|s: &mut App| s.toggle())
}

fn tracklist(p: &State, l: &Look) -> El {
    let count = p.tracklist.data.as_ref().filter(|t| !t.cues.is_empty()).map(|t| format!("{} Cues", t.cues.len()));
    let label = row().w_full().px(size::ROW_X).pb(6.0).justify_between().child(text("Tracklist").font(l.title).color(l.fg)).children(count.map(|c| text(c).font(l.figures).color(l.faint)));
    let note = |words: &str| text(words.to_owned()).key("tracklist-note").font(l.k.ty.ui).color(l.muted).wrap().px(size::ROW_X);
    let body = match (&p.tracklist.data, p.tracklist.busy) {
        (None, true) => l.skeleton("tracklist-loading", 4).px(0.0),
        (None, false) => note(&p.tracklist.error.as_ref().map_or_else(|| "No Tracklist".to_owned(), |why| format!("The Tracklist didn't load: {why}"))),
        (Some(list), _) if list.cues.is_empty() => note(match list.state {
            TracklistState::Pending => "Orbis is still identifying this Set's Tracklist.",
            TracklistState::Failed => "Orbis couldn't identify this Set's Tracklist.",
            TracklistState::Ready | TracklistState::None => "This Set has no Tracklist.",
        }),
        (Some(list), _) => cues(list, p, l),
    };
    col().key("tracklist").w_full().child(label).child(body)
}

fn cues(list: &Tracklist, p: &State, l: &Look) -> El {
    let now = list.cue_at(p.position);
    col().key("cues").w_full().gap(1.0).children(list.cues.iter().enumerate().map(|(i, cue)| {
        let on = now == Some(i);
        let start = cue.start_seconds;
        let lead = if on { icon(&theme::WAVE, 12.0).color(l.accent) } else { text(format!("{}", i + 1)).font(l.figures).color(l.faint) };
        let words = col()
            .grow(1.0)
            .shrink()
            .gap(2.0)
            .child(text(cue.title.clone()).font(l.title).color(if on { l.accent } else { l.fg }).wrap())
            .child(text(cue.artist.clone()).font(l.k.ty.small).color(l.muted).wrap());
        let time = text(start.map_or_else(String::new, clock_time)).font(l.figures).color(l.faint);
        let r = row()
            .key(format!("cue-{i}"))
            .role("button")
            .label(format!("{} by {}", cue.title, cue.artist))
            .w_full()
            .gap(12.0)
            .px(size::ROW_X)
            .py(8.0)
            .radius(l.k.radius.md)
            .items_center()
            .child(row().w(20.0).justify_center().child(lead))
            .child(words)
            .child(time);
        let r = if on { r.fill(l.accent.alpha(0.1)) } else { r };
        match start {
            Some(at) => r.focusable(true).cursor(Cursor::Pointer).hover(l.k.c.hover).help("Play from here").on_press(move |s: &mut App| s.seek(at)),
            None => r,
        }
    }))
}

/// The bar at the foot of the other screens: what plays, its controls over a slim seek bar,
/// and the way to the queue. `None` with nothing loaded.
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
        .w_frac(0.3)
        .shrink()
        .gap(10.0)
        .items_center()
        .radius(l.k.radius.md)
        .padding(4.0)
        .hover(l.k.c.hover)
        .on_press(|s: &mut App| s.go(Screen::Playing))
        .child(l.art(&s.artwork, set.artwork_url.as_deref(), &set.id, &set.title, size::THUMB))
        .child(col().grow(1.0).shrink().gap(2.0).child(line(set.title.clone(), l.title, l.fg)).child(match &p.status {
            Status::Failed(why) => line(why.clone(), l.k.ty.small, l.k.c.danger.fg),
            _ => line(set.creator.clone().unwrap_or_default(), l.k.ty.small, l.muted),
        }));
    let (elapsed, remaining) = times(p, l);
    let buttons = row()
        .gap(12.0)
        .items_center()
        .child(small(l, &theme::BACK, "bar-back", "Back 15 seconds", |s| s.skip(-BACK)))
        .child(play_button(p, l, 32.0, "bar-play"))
        .child(small(l, &theme::AHEAD, "bar-ahead", "Ahead 30 seconds", |s| s.skip(AHEAD)))
        .child(small(l, &theme::NEXT, "bar-next", "Next Set", |s| s.next()));
    let seek = row().w_full().max_w(480.0).gap(10.0).items_center().child(elapsed.w(48.0).align(rune::Align::End)).child(scrubber(p, l, "bar-seek", 12.0).grow(1.0).shrink()).child(remaining.w(48.0));
    let middle = col().grow(1.0).shrink().gap(2.0).items_center().child(buttons).child(seek);
    let queue = row().w_frac(0.3).shrink().justify_end().child(
        IconButton::new(&theme::QUEUE).variant(IconButtonVariant::GhostMuted).label("Listening Queue").help("Listening Queue").on_press(|s: &mut App| s.go(Screen::Queue)).build(&l.k).key("bar-queue"),
    );
    Some(row().key("bar").w_full().h(72.0).px(12.0).gap(16.0).items_center().child(about).child(middle).child(queue))
}
