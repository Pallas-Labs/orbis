//! A Set as a row, the same in the Library, the Listening Queue and a Playlist: its Artwork,
//! title, creator, length and, when it can't play, why. Pressing it plays it. Under the pointer
//! or keyboard focus it shows Play Next, Add to Queue and its menu; a right-click opens the same
//! menu where the pointer is. The menu ([`menu`]) holds everything a Set can do from that place.

use rune::{Cursor, El, PointerPress, col, el, icon, row, text};
use rune_kit::{IconButton, IconButtonVariant, Menu, MenuItem};

use crate::App;
use crate::api::Placement;
use crate::model::{Download, Set, Source, clock_time};
use crate::theme::{self, Look, size};

/// Where a Set's row is, for what its menu offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    Library,
    Queue,
    /// In this Playlist, which the Person may edit.
    Playlist(String),
}

/// An open Set menu: whose, from where, and at the pointer for a right-click.
#[derive(Clone, Debug, PartialEq)]
pub struct SetMenu {
    pub id: String,
    pub place: Place,
    pub at: Option<PointerPress>,
    /// Add to Playlist's list shows.
    pub sub: bool,
}

/// One Set as a row.
pub fn set_row(s: &App, x: &Set, place: &Place, l: &Look) -> El {
    let playing = s.playing.set.as_ref().is_some_and(|p| p.id == x.id);
    let ink = if playing { l.accent } else { l.fg };
    let title =
        row().w_full().gap(6.0).items_center().children(playing.then(|| icon(&theme::WAVE, 12.0).color(l.accent))).child(text(x.title.clone()).font(l.title).color(ink).truncate().grow(1.0).shrink());
    let detail = [x.creator.clone(), (!x.tags.is_empty()).then(|| x.tags.join(", "))].into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let words = col().grow(1.0).shrink().gap(2.0).child(title).children((!detail.is_empty()).then(|| text(detail).font(l.k.ty.small).color(l.muted).truncate()));
    let trailing = match chip(x, l) {
        Some(chip) => chip,
        None => text(x.duration_seconds.map(clock_time).unwrap_or_default()).font(l.figures).color(l.muted),
    };
    let id = x.id.clone();
    let menu_place = place.clone();
    let mut r = row()
        .key(format!("set-{}", x.id))
        .role("button")
        .label(format!("Play {}", x.title))
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover_group_focus()
        .w_full()
        .gap(12.0)
        .px(size::ROW_X)
        .py(8.0)
        .radius(l.k.radius.md)
        .items_center()
        .hover(l.k.c.hover)
        .on_press(move |s: &mut App| s.play(&id))
        .on_secondary_press({
            let id = x.id.clone();
            move |s: &mut App, at, _| s.menu = Some(SetMenu { id: id.clone(), place: menu_place.clone(), at: Some(at), sub: false })
        })
        .child(l.art(&s.artwork, x.artwork_url.as_deref(), &x.id, &x.title, size::THUMB))
        .child(words)
        .child(trailing)
        .child(actions(s, x, place, l));
    if playing {
        r = r.fill(l.accent.alpha(0.08));
    }
    if let Some(why) = x.unplayable_reason() {
        r = r.help(why);
    }
    r
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

/// Play Next, Add to Queue and the menu button: always laid out, shown under the pointer.
fn actions(s: &App, x: &Set, place: &Place, l: &Look) -> El {
    let open = s.menu.as_ref().filter(|m| m.id == x.id && m.place == *place && m.at.is_none());
    let (id, menu_place) = (x.id.clone(), place.clone());
    let more = IconButton::new(&theme::MORE)
        .variant(IconButtonVariant::GhostMuted)
        .label(format!("More for {}", x.title))
        .help("More")
        .expanded(open.is_some())
        .on_press(move |s: &mut App| {
            let shut = s.menu.as_ref().is_some_and(|m| m.id == id && m.place == menu_place);
            s.menu = (!shut).then(|| SetMenu { id: id.clone(), place: menu_place.clone(), at: None, sub: false });
        })
        .build(&l.k)
        .key(format!("more-{}", x.id))
        .hover_alone();
    let quick = x.playable() && *place != Place::Queue;
    let (next, end) = (x.id.clone(), x.id.clone());
    row()
        .gap(2.0)
        .w(if quick { 3.0 * size::CONTROL + 4.0 } else { size::CONTROL })
        .justify_end()
        .children(quick.then(|| button(l, &theme::PLAY_NEXT, "Play Next", format!("next-{}", x.id), move |s| s.enqueue(&next, Placement::Next))))
        .children(quick.then(|| button(l, &theme::ADD, "Add to Queue", format!("add-{}", x.id), move |s| s.enqueue(&end, Placement::End))))
        .child(more)
        .group_opacity(if open.is_some() { 1.0 } else { 0.0 }, 1.0)
}

fn button(l: &Look, glyph: &'static rune::Icon, label: &str, key: String, press: impl Fn(&mut App) + 'static) -> El {
    IconButton::new(glyph).variant(IconButtonVariant::GhostMuted).label(label).help(label).on_press(press).build(&l.k).key(key).hover_alone()
}

/// The menu for `x` from `m.place`: what a Set can do there.
pub fn menu(s: &App, x: &Set, m: &SetMenu) -> Menu {
    let key = format!("menu-{}", x.id);
    let mut menu = Menu::new(key).open(true).min_width(200.0).on_close(|s: &mut App| s.menu = None);
    let close = |f: fn(&mut App, &str)| {
        let id = x.id.clone();
        move |s: &mut App| {
            s.menu = None;
            f(s, &id);
        }
    };
    if x.playable() {
        menu = menu.item(MenuItem::new("Play").icon(&theme::PLAY).on_select(close(|s, id| s.play(id))));
        if m.place != Place::Queue {
            menu = menu
                .item(MenuItem::new("Play Next").icon(&theme::PLAY_NEXT).on_select(close(|s, id| s.enqueue(id, Placement::Next))))
                .item(MenuItem::new("Add to Queue").icon(&theme::ADD).on_select(close(|s, id| s.enqueue(id, Placement::End))));
        }
        menu = menu.separator();
    } else if x.source != Source::AppleMusic && matches!(x.download_state, Download::None | Download::Failed | Download::Canceled) {
        menu = menu.item(MenuItem::new("Download").icon(&theme::DOWNLOAD).on_select(close(|s, id| s.download(id)))).separator();
    }
    let own = s.playlists.editable();
    let mut list: Vec<rune_kit::MenuEntry> = own
        .iter()
        .map(|p| {
            let (set, playlist, inside) = (x.id.clone(), p.id.clone(), x.playlist_ids.contains(&p.id));
            rune_kit::MenuEntry::item(MenuItem::new(p.name.clone()).checked(inside).on_select(move |s: &mut App| {
                s.menu = None;
                s.toggle_in_playlist(&set, &playlist);
            }))
        })
        .collect();
    if !list.is_empty() {
        list.push(rune_kit::MenuEntry::Separator);
    }
    list.push(rune_kit::MenuEntry::item(MenuItem::new("New Playlist…").icon(&theme::PLUS).on_select(close(|s, id| s.new_playlist(Some(id.to_owned()))))));
    let sub = m.sub;
    menu = menu.item(MenuItem::new("Add to Playlist").icon(&theme::PLAYLIST).submenu(list, sub).on_select(|s: &mut App| {
        if let Some(m) = s.menu.as_mut() {
            m.sub = !m.sub;
        }
    }));
    if m.place == Place::Library {
        menu = menu.item(MenuItem::new("Edit Tags…").icon(&theme::TAG).on_select(close(|s, id| s.edit_tags(id))));
    }
    match &m.place {
        Place::Playlist(pid) => {
            let (set, playlist) = (x.id.clone(), pid.clone());
            menu.separator().item(MenuItem::new("Remove from Playlist").icon(&theme::TRASH).on_select(move |s: &mut App| {
                s.menu = None;
                s.toggle_in_playlist(&set, &playlist);
            }))
        }
        Place::Library => menu.separator().item(MenuItem::new("Remove from Library").icon(&theme::TRASH).danger(true).on_select(close(|s, id| s.confirm_remove(id)))),
        Place::Queue => menu,
    }
}

/// The open Set menu, mounted over everything: where the pointer was for a right-click, else
/// under the row's More button.
pub fn context(s: &App, cx: &mut rune::Cx<App>, l: &Look, layer: &mut Vec<El>) {
    let Some(m) = s.menu.as_ref() else { return };
    let Some(x) = s.find_set(&m.id) else { return };
    let at = m.at.map(|p| (p.x, p.y)).or_else(|| cx.window_layout_with(&format!("more-{}", m.id), |r| (r[0], r[1] + r[3] + 4.0)));
    let Some((x0, y0)) = at else { return };
    let built = menu(s, &x, m).at(x0, y0).trigger(el().key("menu-anchor").size(0.0, 0.0)).build(&l.k, layer);
    layer.push(built);
}
