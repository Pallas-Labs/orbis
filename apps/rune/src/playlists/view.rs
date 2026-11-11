//! A Playlist's page: its cover (the first four Sets' Artwork), name, who made it, Play and
//! Shuffle, and its Sets in order.

use rune::{El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, IconButton, IconButtonVariant, Menu, MenuItem};

use crate::App;
use crate::model::{PlaylistDetail, Role};
use crate::rows::{Place, set_row};
use crate::theme::{self, Look, size};

/// The open Playlist's page.
pub fn screen(s: &App, id: &str, l: &Look, layer: &mut Vec<El>) -> El {
    let open = &s.playlists.open;
    let body = match &open.data {
        Some(p) if p.id == id => page(s, p, l, layer),
        _ if open.busy => col().w_full().child(head_skeleton(l)).child(l.skeleton("playlist-loading", 6)),
        _ => l.empty(
            "playlist-failed",
            "This Playlist didn't load",
            open.error.as_deref().unwrap_or(""),
            Some(Button::new("Try again").on_press(|s: &mut App| s.reload_playlist()).build(&l.k).key("playlist-retry")),
        ),
    };
    col().key("playlist").w_full().h_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(body.pb(16.0))
}

fn head_skeleton(l: &Look) -> El {
    let fill = l.fg.alpha(0.06);
    row()
        .w_full()
        .px(size::PAGE_X)
        .pt(20.0)
        .pb(16.0)
        .gap(20.0)
        .child(el().size(132.0, 132.0).radius(l.k.radius.xl).fill(fill))
        .child(col().gap(10.0).pt(40.0).child(el().w(220.0).h(14.0).radius(7.0).fill(fill)).child(el().w(140.0).h(8.0).radius(4.0).fill(fill)))
}

fn page(s: &App, p: &PlaylistDetail, l: &Look, layer: &mut Vec<El>) -> El {
    let count = match p.sets.len() {
        1 => "1 Set".to_owned(),
        n => format!("{n} Sets"),
    };
    let by = if p.creator.id == s.account.me_id() { String::new() } else { format!(" · by {}", p.creator.username) };
    let kind = if p.role == Role::Editor || !by.is_empty() { "Collaborative Playlist" } else { "Playlist" };
    let playable = p.sets.iter().any(|x| x.playable());
    let (play, shuffle) = (p.id.clone(), p.id.clone());
    let mut buttons = row()
        .gap(8.0)
        .child(Button::new("Play").icon(&theme::PLAY).variant(ButtonVariant::Contrast).disabled(!playable).on_press(move |s: &mut App| s.play_playlist(&play, false)).build(&l.k).key("playlist-play"))
        .child(
            Button::new("Shuffle")
                .icon(&theme::SHUFFLE)
                .variant(ButtonVariant::Neutral)
                .disabled(!playable)
                .on_press(move |s: &mut App| s.play_playlist(&shuffle, true))
                .build(&l.k)
                .key("playlist-shuffle"),
        );
    if p.role == Role::Creator {
        let more = IconButton::new(&theme::MORE)
            .variant(IconButtonVariant::GhostMuted)
            .label("More for this Playlist")
            .help("More")
            .expanded(s.playlist_menu)
            .on_press(|s: &mut App| s.playlist_menu = !s.playlist_menu)
            .build(&l.k)
            .key("playlist-more");
        let more = if s.playlist_menu {
            Menu::new("playlist-menu")
                .open(true)
                .trigger(more)
                .on_close(|s: &mut App| s.playlist_menu = false)
                .item(MenuItem::new("Rename…").on_select(|s: &mut App| {
                    s.playlist_menu = false;
                    s.rename_playlist();
                }))
                .separator()
                .item(MenuItem::new("Delete Playlist…").icon(&theme::TRASH).danger(true).on_select(|s: &mut App| {
                    s.playlist_menu = false;
                    s.confirm_delete_playlist();
                }))
                .build(&l.k, layer)
        } else {
            more
        };
        buttons = buttons.child(more);
    }
    let about = col()
        .grow(1.0)
        .shrink()
        .gap(4.0)
        .justify_end()
        .child(text(kind).font(l.k.ty.small_medium).color(l.muted))
        .child(text(p.name.clone()).key("playlist-name").font(l.display).color(l.fg).wrap())
        .child(text(format!("{count}{by}")).key("playlist-count").font(l.k.ty.ui).color(l.muted))
        .child(el().h(8.0))
        .child(buttons);
    let head = row().w_full().px(size::PAGE_X).pt(20.0).pb(16.0).gap(20.0).items_end().child(cover(s, p, l)).child(about);
    let place = Place::Playlist(p.id.clone());
    let list = if p.sets.is_empty() {
        l.empty("playlist-empty", "No Sets in this Playlist", "Add one from a Set's menu in the Library: More, then Add to Playlist.", None)
    } else {
        col().key("playlist-sets").w_full().px(size::PAGE_X - size::ROW_X).gap(1.0).children(p.sets.iter().map(|x| set_row(s, x, &place, l)))
    };
    col().w_full().child(head).child(list)
}

/// The first four Sets' Artwork in a square, or one picture when there are fewer.
fn cover(s: &App, p: &PlaylistDetail, l: &Look) -> El {
    const SIDE: f32 = 132.0;
    let radius = l.k.radius.xl;
    if p.sets.len() < 4 {
        return match p.sets.first() {
            Some(x) => l.art(&s.artwork, x.artwork_large_url.as_deref().or(x.artwork_url.as_deref()), &x.id, &x.title, SIDE),
            None => l.tile(&p.id, &p.name, SIDE),
        };
    }
    let half = SIDE / 2.0;
    let quarter = |x: &crate::model::Set| l.art(&s.artwork, x.artwork_url.as_deref(), &x.id, &x.title, half).radius(0.0);
    let pair = |a, b| row().child(quarter(a)).child(quarter(b));
    col().key("playlist-cover").size(SIDE, SIDE).radius(radius).clip_rounded(radius).child(pair(&p.sets[0], &p.sets[1])).child(pair(&p.sets[2], &p.sets[3]))
}
