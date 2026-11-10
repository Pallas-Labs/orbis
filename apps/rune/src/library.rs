//! The Library: every Set the person saved, newest first, with a search that filters by
//! title, creator and Tag as they type. Pressing a Set plays it; under the pointer, a Set can go
//! next in the queue or at its end. A Set without Retained Audio says so, and offers a Download
//! where Orbis can make one.

use std::time::Duration;

use rune::{Cursor, El, ScrollSpec, TextEdit, col, el, icon, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Spinner, TextInput};

use crate::App;
use crate::api::{self, Placement};
use crate::load::Load;
use crate::model::{Download, Set, Source, clock_time};
use crate::theme::{self, Look};

/// The room a row keeps for its actions: the Download button, the widest.
const ACTIONS_W: f32 = 112.0;

/// How long a Library with a Download running waits before it reloads.
const RECHECK: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct State {
    pub sets: Load<Vec<Set>>,
    pub query: TextEdit,
}

impl State {
    /// The Sets the search lets through, in the Library's order.
    pub fn shown(&self) -> Vec<&Set> {
        let words: Vec<String> = self.query.text.split_whitespace().map(str::to_lowercase).collect();
        let fits = |x: &Set| {
            let hay = format!("{} {} {}", x.title, x.creator.as_deref().unwrap_or(""), x.tags.join(" ")).to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()))
        };
        self.sets.data.iter().flatten().filter(|x| fits(x)).collect()
    }
}

impl App {
    /// Loads the Library. What shows stays up while it loads, and through a failed reload.
    pub fn reload_library(&mut self) {
        self.library.sets.begin();
        self.spawn(api::library, |s, got| {
            if let Some(why) = s.library.sets.land(got) {
                s.say(format!("Couldn't load the Library: {why}"));
            }
            let downloading = s.library.sets.data.iter().flatten().any(|x| matches!(x.download_state, Download::Queued | Download::Downloading));
            if downloading {
                s.after(RECHECK, |s| {
                    if !s.library.sets.busy {
                        s.reload_library();
                    }
                });
            }
        });
    }

    /// Puts `id` in the Listening Queue, next or at the end.
    pub fn enqueue(&mut self, id: &str, placement: Placement) {
        let Some(set) = self.find_set(id).filter(|set| self.can("queue", set)) else { return };
        let id = id.to_owned();
        self.spawn(
            move || api::enqueue(&id, placement),
            move |s, got| match got {
                Ok(queue) => {
                    s.queue.items.land(Ok(queue));
                    s.say(format!("{} {}", set.title, if placement == Placement::Next { "plays next" } else { "is at the end of the queue" }));
                }
                Err(why) => s.say(format!("Not queued: {why}")),
            },
        );
    }

    /// Asks Orbis to make Retained Audio for `id`.
    pub fn download(&mut self, id: &str) {
        let Some(set) = self.library.sets.data.iter_mut().flatten().find(|x| x.id == id) else { return };
        set.download_state = Download::Queued;
        let id = id.to_owned();
        self.spawn(
            move || api::download(&id),
            |s, got| match got {
                Ok(set) => {
                    s.replace_set(&set);
                    s.after(RECHECK, |s| s.reload_library());
                }
                Err(why) => {
                    s.reload_library();
                    s.say(format!("Download not started: {why}"));
                }
            },
        );
    }
}

/// The Library screen.
pub fn view(s: &App, l: &Look) -> El {
    let lib = &s.library;
    let shown = lib.shown();
    let mut search = TextInput::new(&lib.query).placeholder("Search the Library").label("Search the Library").leading_icon(&rune_kit::glyphs::SEARCH);
    if !lib.query.text.is_empty() {
        search = search.clear_button();
    }
    let search = search.on_edit(|s: &mut App| &mut s.library.query).build(&l.k).key("search");
    let count = lib.sets.data.as_ref().map(|all| if shown.len() == all.len() { format!("{} Sets", all.len()) } else { format!("{} of {}", shown.len(), all.len()) });
    let head = row()
        .w_full()
        .gap(12.0)
        .items_center()
        .px(16.0)
        .pt(12.0)
        .pb(8.0)
        .child(el().grow(1.0).shrink().max_w(420.0).child(search))
        .child(el().grow(1.0))
        .children(lib.sets.busy.then(|| Spinner::new().size(14.0).build(&l.k).key("library-busy")))
        .children(count.map(|c| text(c).key("library-count").font(l.figures).color(l.muted)));
    let body = match &lib.sets.data {
        None if lib.sets.busy => note(l, "library-loading", "Loading the Library…", None),
        None => note(l, "library-failed", lib.sets.error.as_deref().unwrap_or("The Library isn't loaded"), Some(("Try again", |s: &mut App| s.reload_library()))),
        Some(all) if all.is_empty() => note(l, "library-empty", "No Sets yet. Save one from the Orbis app on your phone, or with Raycast.", None),
        Some(_) if shown.is_empty() => note(l, "library-no-match", "No Set matches the search", None),
        Some(_) => col().key("sets").w_full().px(8.0).pb(8.0).children(shown.iter().map(|x| set_row(s, x, l, true))),
    };
    let list = col().key("library-scroll").w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(body);
    col().key("library").w_full().h_full().min_h(0.0).child(head).child(list)
}

/// A button's label and what pressing it does.
pub type Action = (&'static str, fn(&mut App));

/// A line in place of a list: loading, empty, failed. With an action, a button under it.
pub fn note(l: &Look, key: &str, words: &str, action: Option<Action>) -> El {
    col()
        .key(key.to_owned())
        .w_full()
        .py(48.0)
        .px(24.0)
        .gap(12.0)
        .items_center()
        .child(text(words.to_owned()).font(l.k.ty.ui).color(l.muted).wrap().align(rune::Align::Center))
        .children(action.map(|(label, press)| Button::new(label).variant(ButtonVariant::Neutral).on_press(press).build(&l.k).key(format!("{key}-action"))))
}

/// One Set as a row: its square, title, creator and length. Pressing it plays it. With
/// `actions`, the pointer shows Play Next and Add to Queue, or Download.
pub fn set_row(s: &App, x: &Set, l: &Look, actions: bool) -> El {
    let playing = s.playing.set.as_ref().is_some_and(|p| p.id == x.id);
    let detail = [x.creator.clone(), x.duration_seconds.map(clock_time)].into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let title_row = row()
        .w_full()
        .gap(6.0)
        .items_center()
        .children(playing.then(|| icon(&theme::WAVE, 12.0).color(l.accent)))
        .child(text(x.title.clone()).font(l.title).color(if playing { l.accent } else { l.fg }).wrap().grow(1.0).shrink());
    let words = col().grow(1.0).shrink().gap(2.0).child(title_row).children((!detail.is_empty()).then(|| text(detail).font(l.k.ty.small).color(l.muted).truncate()));
    let state = chip(x, l);
    let id = x.id.clone();
    let mut r = row()
        .key(format!("set-{}", x.id))
        .role("button")
        .label(format!("Play {}", x.title))
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover_group_focus()
        .w_full()
        .gap(12.0)
        .px(8.0)
        .py(8.0)
        .radius(l.k.radius.md)
        .items_center()
        .hover(l.k.c.hover)
        .on_press(move |s: &mut App| s.play(&id))
        .child(l.tile(&x.id, &x.title, 36.0))
        .child(words)
        .children(state);
    if let Some(why) = x.unplayable_reason() {
        r = r.help(why);
    }
    if actions {
        r = r.child(row_actions(x, l));
    }
    r.border_sides([0.0, 0.0, 1.0, 0.0], l.rule)
}

/// Where a Set's audio stands, when it can't play yet.
fn chip(x: &Set, l: &Look) -> Option<El> {
    let (words, ink) = match (x.source, x.download_state) {
        (Source::AppleMusic, _) => ("Apple Music", l.muted),
        (_, Download::Ready) => return None,
        (_, Download::Queued) => ("Queued", l.muted),
        (_, Download::Downloading) => ("Downloading", l.k.c.info.fg),
        (_, Download::Failed) => ("Download failed", l.k.c.danger.fg),
        (_, Download::None | Download::Canceled) => ("Not downloaded", l.faint),
    };
    Some(row().key(format!("state-{}", x.id)).px(8.0).py(3.0).radius(l.k.radius.md).fill(l.fg.alpha(0.05)).child(text(words).font(l.k.ty.small).color(ink)))
}

fn row_actions(x: &Set, l: &Look) -> El {
    let id = x.id.clone();
    let can_download = x.source != Source::AppleMusic && matches!(x.download_state, Download::None | Download::Failed | Download::Canceled);
    let actions = if x.playable() {
        let (next, end) = (id.clone(), id.clone());
        row().gap(2.0).child(button(l, &theme::PLAY_NEXT, "Play Next", format!("next-{id}"), move |s| s.enqueue(&next, Placement::Next))).child(button(
            l,
            &theme::ADD,
            "Add to Queue",
            format!("add-{id}"),
            move |s| s.enqueue(&end, Placement::End),
        ))
    } else if can_download {
        row().child(
            Button::new("Download")
                .icon(&theme::DOWNLOAD)
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut App| s.download(&id))
                .build(&l.k)
                .key(format!("download-{}", x.id)),
        )
    } else {
        row()
    };
    // One width for every row's actions, so the chips before them line up.
    actions.w(ACTIONS_W).justify_end().group_opacity(0.0, 1.0)
}

fn button(l: &Look, glyph: &'static rune::Icon, label: &str, key: String, press: impl Fn(&mut App) + 'static) -> El {
    IconButton::new(glyph).variant(IconButtonVariant::GhostMuted).label(label).help(label).on_press(press).build(&l.k).key(key).hover_alone()
}
