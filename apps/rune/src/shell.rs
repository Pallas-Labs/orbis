//! The window: the sidebar (the screens, the Playlists, and who in the Group is listening), the
//! toolbar with the screen's title and actions, the screen, the player bar, and over them the
//! open menu, dialog and toast. A signed-out window shows the sign-in page alone.

use rune::{Cx, El, col, el, row, text};
use rune_kit::shell::{PaneMotion, Sidebar, SidebarRow, SidebarSection, SidebarToggle, SplitView, Toolbar};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Toast};

use crate::theme::{self, Look, size};
use crate::{App, Screen, account, dialogs, library, playing, playlists, queue, rows};

/// How far the toast sits above the window's bottom edge: OpenCode's 48, or above the player bar.
fn toast_bottom(bar: bool) -> f32 {
    if bar { 48.0 + 72.0 } else { 48.0 }
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let l = Look::new(cx.system_dark());
    let mut layer = Vec::new();
    if s.signed_out {
        let page = rune_kit::shell::Page::new(account::sign_in(s, &l)).title("Orbis").titlebar_inset(cx.titlebar_inset()).frame_inset(8.0).toolbar_in_panel().build(&l.k);
        toast(s, &l, false, &mut layer);
        return rune_kit::root(page, layer);
    }
    let width = cx.layout_size("main").map(|[w, _]| w);
    let screen = match &s.screen {
        Screen::Library => library::view(s, &l),
        Screen::Playlist(id) => playlists::screen(s, id, &l, &mut layer),
        Screen::Queue => queue::view(s, &l),
        Screen::Playing => playing::screen(s, &l, width),
        Screen::Settings => account::settings(s, &l),
    };
    let bar = if s.screen == Screen::Playing { None } else { playing::bar(s, &l) };
    let has_bar = bar.is_some();
    let main = col().key("main").w_full().h_full().min_h(0.0).child(col().w_full().grow(1.0).min_h(0.0).child(screen)).children(bar.map(|b| b.border_sides([1.0, 0.0, 0.0, 0.0], l.rule)));
    let split = SplitView::new(main)
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, sidebar(s, &l))
        .toolbar(toolbar(s, &l))
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .sidebar_padding(11.0, 3.0)
        .sidebar_toggle(SidebarToggle::new().size(ControlSize::Large).past_lights(16.0).edge(18.0).gap(4.0).in_header())
        .pane_motion(PaneMotion::new().spring(rune::Spring::new(0.3, 0.0)).scale_with_width(480.0, 0.15, 0.3).fade_tail(0.15))
        .reduced_motion(cx.is_reduced_motion())
        .build(&l.k);
    rows::context(s, cx, &l, &mut layer);
    dialogs::view(s, &l, &mut layer);
    toast(s, &l, has_bar, &mut layer);
    rune_kit::root(split, layer)
}

fn toast(s: &App, l: &Look, bar: bool, layer: &mut Vec<El>) {
    if let Some(line) = &s.toast {
        let card = Toast::new("toast", line.clone()).build(&l.k);
        layer.push(col().key("toast-region").role("region").label("Notifications").pin(None, None, Some(32.0), Some(toast_bottom(bar))).w(size::TOAST_W).child(card));
    }
}

/// The screen's title at the toolbar's leading end, and its actions at the trailing end: 28 pt
/// ghost buttons with 16 pt icons, as OpenCode's session header.
fn toolbar(s: &App, l: &Look) -> Toolbar {
    let title = match &s.screen {
        Screen::Library => "Library".to_owned(),
        Screen::Playlist(id) => s.playlists.name(id).unwrap_or("Playlist").to_owned(),
        Screen::Queue => "Listening Queue".to_owned(),
        Screen::Playing => "Now Playing".to_owned(),
        Screen::Settings => "Settings".to_owned(),
    };
    let action = |glyph: &'static rune::Icon, key: &str, label: &str, press: fn(&mut App)| {
        IconButton::new(glyph).variant(IconButtonVariant::GhostMuted).label(label).help(label).on_press(press).build(&l.k).key(key.to_owned())
    };
    let reload = action(&theme::RELOAD, "reload", "Reload (Ctrl+R)", |s| s.go(s.screen.clone()));
    let trailing = match &s.screen {
        Screen::Library => row().gap(4.0).child(action(&theme::PLUS, "save-link", "Save a Link (Ctrl+N)", |s| s.save_link())).child(reload),
        Screen::Playlist(_) | Screen::Queue => row().child(reload),
        Screen::Playing => row().child(action(&theme::QUEUE, "open-queue", "Listening Queue", |s| s.go(Screen::Queue))),
        Screen::Settings => row(),
    };
    Toolbar::new().leading(text(title).key("screen-title").font(l.title).color(l.fg).truncate()).trailing(trailing)
}

fn sidebar(s: &App, l: &Look) -> El {
    let count = |n: Option<usize>| n.filter(|n| *n > 0).map(|n| n.to_string()).unwrap_or_default();
    let nav = |screen: Screen, title: &str, glyph: &'static rune::Icon, key: &str, detail: String| {
        let selected = s.screen == screen;
        SidebarRow::new(title).icon(glyph).height(size::CONTROL).detail(detail).selected(selected).on_select(move |s: &mut App, _| s.go(screen.clone())).build(&l.k).key(key.to_owned())
    };
    let mut bar = Sidebar::new()
        .label("Orbis")
        .inset(0.0)
        .row_gap(3.0)
        .header_gap(3.0)
        .header(nav(Screen::Library, "Library", &theme::LIBRARY, "nav-library", count(s.library.sets.data.as_ref().map(Vec::len))))
        .header(nav(Screen::Queue, "Listening Queue", &theme::QUEUE, "nav-queue", count(s.queue.items.data.as_ref().map(|q| q.entries.len()))))
        .header(nav(Screen::Playing, "Now Playing", &theme::WAVE, "nav-playing", String::new()))
        .footer(nav(Screen::Settings, "Settings", &theme::SETTINGS, "nav-settings", String::new()));
    let add = IconButton::new(&theme::PLUS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label("New Playlist")
        .help("New Playlist")
        .on_press(|s: &mut App| s.new_playlist(None))
        .build(&l.k)
        .key("new-playlist");
    let lists: Vec<El> = s
        .playlists
        .editable()
        .into_iter()
        .map(|p| {
            let id = p.id.clone();
            let shared = p.creator.as_ref().map(|c| format!("by {}", c.username));
            let row = SidebarRow::new(p.name.clone())
                .icon(&theme::PLAYLIST)
                .height(size::CONTROL)
                .detail(shared.unwrap_or_else(|| count(Some(p.set_count))))
                .selected(s.screen == Screen::Playlist(p.id.clone()))
                .on_select(move |s: &mut App, _| s.open_playlist(&id));
            row.build(&l.k).key(format!("nav-playlist-{}", p.id))
        })
        .collect();
    let empty = lists.is_empty() && s.playlists.lists.data.is_some();
    bar = bar.section(
        SidebarSection::new("Playlists")
            .key("playlists-section")
            .action(add)
            .rows(lists)
            .rows(empty.then(|| text("No Playlists yet").font(l.k.ty.small).color(l.faint).px(8.0).py(6.0).key("playlists-none"))),
    );
    if !s.presence.listening.is_empty() {
        let rows = s.presence.listening.iter().map(|p| {
            let id = p.set.id.clone();
            SidebarRow::new(p.username.clone())
                .avatar(avatar(l, &p.username))
                .subtitle(p.set.title.clone())
                .on_select(move |s: &mut App, _| s.play(&id))
                .build(&l.k)
                .key(format!("listening-{}", p.person_id))
                .help(format!("Play {}", p.set.title))
        });
        bar = bar.section(SidebarSection::new("Listening Now").key("listening-section").rows(rows));
    }
    bar.build(&l.k)
}

/// A Person's 16 pt square with their first letter, as OpenCode's project avatar.
fn avatar(l: &Look, name: &str) -> El {
    let letter = name.chars().next().unwrap_or('?').to_uppercase().to_string();
    let hue = name.bytes().fold(11u32, |h, b| h.wrapping_mul(33).wrapping_add(u32::from(b))) % 360;
    row().size(16.0, 16.0).radius(4.0).fill(rune::oklch(0.6, 0.12, hue as f32)).center().child(text(letter).font(l.k.ty.small_medium).color(rune::Color::WHITE)).child(el().size(0.0, 0.0))
}
