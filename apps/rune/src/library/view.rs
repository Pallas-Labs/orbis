//! The Library screen: a search field and Tag pills over the Sets, one row each.

use std::borrow::Cow;
use std::rc::Rc;

use rune::{Cursor, El, GrowthSpec, ScrollFade, ScrollSpec, col, el, icon, row, text};
use rune_kit::{Button, TextInput};

use crate::App;
use crate::rows::{Place, set_row};
use crate::theme::{self, Look, size};

/// A Library row's height: 8 above, the 40 pt square, 8 below.
const ROW_H: f32 = 56.0;

/// The Library screen.
pub fn view(s: &App, l: &Look) -> El {
    let lib = &s.library;
    let head = col().w_full().px(size::PAGE_X).pt(12.0).pb(8.0).gap(10.0).child(search(s, l)).children(pills(s, l));
    let body = match &lib.sets.data {
        None if lib.sets.busy => l.skeleton("library-loading", 8),
        None => l.empty(
            "library-failed",
            "The Library didn't load",
            lib.sets.error.as_deref().unwrap_or(""),
            Some(Button::new("Try again").on_press(|s: &mut App| s.reload_library()).build(&l.k).key("library-retry")),
        ),
        Some(all) if all.is_empty() => l.empty(
            "library-empty",
            "No Sets yet",
            "Save a YouTube, SoundCloud or Apple Music link, and it shows here.",
            Some(Button::new("Save a Link").icon(&theme::PLUS).on_press(|s: &mut App| s.save_link()).build(&l.k).key("library-save")),
        ),
        Some(_) if lib.shown().is_empty() => l.empty("library-no-match", "No Set matches", "Try fewer words, or another Tag.", None),
        Some(_) => return col().key("library").w_full().h_full().min_h(0.0).child(head).child(list(s, l)),
    };
    col().key("library").w_full().h_full().min_h(0.0).child(head).child(body)
}

/// The search field, as OpenCode's Home search: 36 pt, no border, a quiet fill that firms up on
/// hover and focus.
fn search(s: &App, l: &Look) -> El {
    let lib = &s.library;
    let count = lib.sets.data.as_ref().map(|all| match lib.shown().len() {
        n if n == all.len() && n == 1 => "1 Set".to_owned(),
        n if n == all.len() => format!("{n} Sets"),
        n => format!("{n} of {}", all.len()),
    });
    let field = TextInput::new(&lib.query).plain().placeholder("Search the Library").label("Search the Library").on_edit(|s: &mut App| &mut s.library.query).build(&l.k).key("search");
    row()
        .key("search-box")
        .w_full()
        .h(size::SEARCH)
        .pl(12.0)
        .pr(8.0)
        .gap(8.0)
        .items_center()
        .radius(l.k.radius.md)
        .fill(l.k.c.layer_02.alpha(0.6))
        .hover(l.fg.alpha(0.03))
        .cursor(Cursor::Text)
        .child(icon(&theme::SEARCH, 16.0).color(l.k.c.icon_muted))
        .child(el().grow(1.0).shrink().child(field))
        .children(count.map(|c| text(c).key("library-count").font(l.figures).color(l.faint)))
}

/// The Library's Tags as pills on one line that scrolls when it outgrows the pane. The chosen
/// one takes the accent and a cross that clears it.
fn pills(s: &App, l: &Look) -> Option<El> {
    let tags = s.library.tags();
    if tags.is_empty() {
        return None;
    }
    let chosen = s.library.tag.clone();
    let pill = |tag: &str, n: usize| {
        let on = chosen.as_deref() == Some(tag);
        let name = tag.to_owned();
        row()
            .key(format!("tag-{tag}"))
            .role("button")
            .label(format!("Tag {tag}"))
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .press_scale(0.96)
            .h(24.0)
            .px(8.0)
            .gap(6.0)
            .items_center()
            .radius(l.k.radius.md)
            .fill(if on { l.accent.alpha(0.16) } else { l.fg.alpha(0.05) })
            .hover(if on { l.accent.alpha(0.06) } else { l.fg.alpha(0.04) })
            .help(format!("{n} Sets"))
            .on_press(move |s: &mut App| s.library.tag = if s.library.tag.as_deref() == Some(name.as_str()) { None } else { Some(name.clone()) })
            .child(text(tag.to_owned()).font(l.k.ty.small_medium).color(if on { l.accent } else { l.muted }))
            .children(on.then(|| icon(l.k.glyph.close, 12.0).color(l.accent)))
    };
    let line = row().gap(6.0).children(tags.iter().map(|(t, n)| pill(t, *n)));
    Some(row().key("tags").w_full().scroll_x().scroll_fade(ScrollFade::strength(16.0).linear().full_at(0.1)).child(line))
}

/// The Sets the search lets through, built only near the viewport. Rows coming into view ask
/// for their Artwork.
fn list(s: &App, l: &Look) -> El {
    let look = l.clone();
    // The search runs once per view; the rows' closures share its answer.
    let ids: Rc<Vec<String>> = Rc::new(s.library.shown().iter().map(|x| x.id.clone()).collect());
    let (keys, built, seen) = (Rc::clone(&ids), Rc::clone(&ids), Rc::clone(&ids));
    let rows = col()
        .key("sets")
        .w_full()
        .px(size::PAGE_X - size::ROW_X)
        .growth(GrowthSpec::default())
        .virtual_rows(
            ids.len(),
            ROW_H,
            move |_: &App, i| keys.get(i).map_or(Cow::Borrowed(""), |id| Cow::Owned(format!("row-{id}"))),
            move |s: &App, i| match built.get(i).and_then(|id| s.library.sets.data.iter().flatten().find(|x| x.id == *id)) {
                Some(x) => el().key(format!("row-{}", x.id)).w_full().pb(1.0).child(set_row(s, x, &Place::Library, &look)),
                None => el(),
            },
        )
        .virtual_rows_version(ids.join("\n"))
        .on_visible_rows(move |s: &mut App, range| {
            let near = seen.iter().skip(range.start.saturating_sub(8)).take(range.len() + 16);
            let urls: Vec<String> = near.filter_map(|id| s.library.sets.data.iter().flatten().find(|x| x.id == *id)?.artwork_url.clone()).collect();
            s.want_artwork(urls.iter().map(String::as_str));
            false
        });
    col().key("library-scroll").w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(rows).pb(8.0)
}
