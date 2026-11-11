//! How Orbis looks here: the rune-kit `Kit` seeded with Orbis's own colours
//! (`docs/design/tokens.json`: paper, ink and tint), the roles views name, the sizes the app
//! takes from OpenCode Desktop (rune-kit's reference), and the app's icons.

use rune::{Color, El, Icon, SurfaceFit, TextStyle, Transition, el, oklch, row, text};
use rune_kit::{Kit, PaletteSeed};

use crate::artwork::Artwork;

/// OpenCode Desktop's sizes, in points (`packages/ui`, `packages/app`).
pub mod size {
    /// A control in a bar, a sidebar row, a button.
    pub const CONTROL: f32 = 28.0;
    /// The main search field.
    pub const SEARCH: f32 = 36.0;
    /// A list row's side padding.
    pub const ROW_X: f32 = 12.0;
    /// An Artwork square in a list row.
    pub const THUMB: f32 = 40.0;
    /// The page's side margin.
    pub const PAGE_X: f32 = 24.0;
    /// An empty state's distance from the top.
    pub const EMPTY_TOP: f32 = 52.0;
    /// A toast's width, and its distance from the window's right and bottom edges.
    pub const TOAST_W: f32 = 320.0;
}

/// The kit and the roles the views use, built once per view.
#[derive(Clone)]
pub struct Look {
    pub k: Kit,
    pub fg: Color,
    pub muted: Color,
    pub faint: Color,
    /// Hairlines between sections.
    pub rule: Color,
    pub accent: Color,
    /// A row or title: `ui` at `ui_medium`'s weight.
    pub title: TextStyle,
    /// A page's heading: 15 pt at `ui_medium`'s weight, as OpenCode's dialog titles.
    pub heading: TextStyle,
    /// A Set's name on its own page.
    pub display: TextStyle,
    /// Times and counts in columns, in tabular figures.
    pub figures: TextStyle,
}

impl Look {
    pub fn new(dark: bool) -> Look {
        // Orbis's paper, ink and tint, light and dark (docs/design/tokens.json).
        let seed = if dark {
            PaletteSeed { bg: oklch(0.11, 0.003, 286.0), fg: oklch(0.945, 0.018, 300.0), accent: oklch(0.62, 0.25, 302.0) }
        } else {
            PaletteSeed { bg: oklch(0.995, 0.0, 0.0), fg: oklch(0.22, 0.03, 300.0), accent: oklch(0.54, 0.27, 304.0) }
        };
        let k = Kit::from_palette(seed);
        let medium = k.ty.ui_medium.weight;
        Look {
            fg: k.c.text_base,
            muted: k.c.text_muted,
            faint: k.c.text_faint,
            rule: k.c.border_weak,
            accent: seed.accent,
            title: TextStyle { weight: medium, ..k.ty.ui },
            heading: TextStyle { size: 15.0, line_height: 20.0, weight: medium, tracking: -0.13, ..k.ty.ui },
            display: TextStyle { size: 22.0, line_height: 28.0, weight: 600.0, tracking: -0.3, ..k.ty.ui },
            figures: k.ty.small.features("'tnum' 1"),
            k,
        }
    }

    /// The radius for a square of `side` points: 4 in rows, more as it grows.
    pub fn art_radius(&self, side: f32) -> f32 {
        if side >= 120.0 {
            self.k.radius.xl
        } else if side >= 48.0 {
            self.k.radius.lg
        } else {
            self.k.radius.sm
        }
    }

    /// A Set's square: its Artwork from `art` when it has landed, fading in, over a colour from
    /// its id with its first letter, with a hairline ring so a dark picture keeps its edge.
    pub fn art(&self, art: &Artwork, url: Option<&str>, id: &str, title: &str, side: f32) -> El {
        let radius = self.art_radius(side);
        let tile = self.tile(id, title, side);
        let picture = art.get(url).map(|image| el().key("art").w_full().h_full().radius(radius).pixels_fit(image.pixels(), SurfaceFit::Fill).transition(Transition::opacity()));
        let ring = el().w_full().h_full().radius(radius).border(1.0, self.fg.alpha(0.08));
        el().size(side, side).radius(radius).child(tile.pin(Some(0.0), Some(0.0), None, None)).children(picture.map(|p| p.pin(Some(0.0), Some(0.0), None, None))).child(ring.pin(
            Some(0.0),
            Some(0.0),
            None,
            None,
        ))
    }

    /// A Set's square with no Artwork: a colour from its id with its first letter on it.
    pub fn tile(&self, id: &str, title: &str, size: f32) -> El {
        let hue = id.bytes().fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b))) % 360;
        let (l, c) = if self.k.dark { (0.34, 0.08) } else { (0.86, 0.06) };
        let letter = title.chars().find(|c| c.is_alphanumeric()).unwrap_or('·').to_uppercase().to_string();
        let style = if size >= 64.0 { TextStyle { size: size * 0.36, line_height: size * 0.44, ..self.k.ty.body_medium } } else { self.k.ty.small_medium };
        row().size(size, size).radius(self.art_radius(size)).fill(oklch(l, c, hue as f32)).center().child(text(letter).font(style).color(self.fg.alpha(0.7)))
    }

    /// A quiet empty or failed state, as OpenCode's: no icon, a title, words under it, and at most
    /// one button.
    pub fn empty(&self, key: &str, title: &str, words: &str, action: Option<El>) -> El {
        rune::col()
            .key(key.to_owned())
            .w_full()
            .pt(size::EMPTY_TOP)
            .px(size::PAGE_X)
            .gap(16.0)
            .items_center()
            .child(
                rune::col()
                    .gap(4.0)
                    .items_center()
                    .max_w(420.0)
                    .child(text(title.to_owned()).font(self.title).color(self.fg).wrap().align(rune::Align::Center))
                    .children((!words.is_empty()).then(|| text(words.to_owned()).font(self.k.ty.ui).color(self.muted).wrap().align(rune::Align::Center))),
            )
            .children(action)
    }

    /// Rows that stand in for a list while it loads: a square and two bars each, breathing.
    pub fn skeleton(&self, key: &str, rows: usize) -> El {
        let fill = self.fg.alpha(0.06);
        let bar = |w: f32, h: f32| el().w(w).h(h).radius(h / 2.0).fill(fill);
        rune::col()
            .key(key.to_owned())
            .role("progressbar")
            .label("Loading")
            .w_full()
            .px(size::PAGE_X - size::ROW_X)
            .gap(1.0)
            .cycle(rune::Cycle { period: 1.8, phase: 0.0, stops: &[(0.0, 1.0), (0.5, 0.55), (1.0, 1.0)], still: 1.0, fps: 30.0 })
            .children((0..rows).map(|i| {
                row()
                    .w_full()
                    .px(size::ROW_X)
                    .py(8.0)
                    .gap(12.0)
                    .items_center()
                    .child(el().size(size::THUMB, size::THUMB).radius(self.k.radius.sm).fill(fill))
                    .child(rune::col().gap(8.0).child(bar(140.0 + (i % 3) as f32 * 60.0, 8.0)).child(bar(90.0 + (i % 2) as f32 * 30.0, 6.0)))
            }))
    }
}

const fn glyph(name: &'static str, body: &'static str) -> Icon {
    Icon { name, view: 16.0, body }
}

pub static PLAY: Icon = glyph("orbis-play", r#"<path d="M5 3.2V12.8L12.8 8Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>"#);
pub static PAUSE: Icon = glyph("orbis-pause", r#"<rect x="4" y="3" width="2.8" height="10" rx="0.8" fill="currentColor"/><rect x="9.2" y="3" width="2.8" height="10" rx="0.8" fill="currentColor"/>"#);
pub static NEXT: Icon = glyph(
    "orbis-next",
    r#"<path d="M3.5 3.5V12.5L10 8Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><rect x="10.8" y="3.5" width="1.7" height="9" rx="0.6" fill="currentColor"/>"#,
);
pub static BACK: Icon = glyph(
    "orbis-back",
    r#"<path d="M4.2 6.2A4.6 4.6 0 1 1 3.6 9.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M3.6 3.4V6.6H6.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
);
pub static AHEAD: Icon = glyph(
    "orbis-ahead",
    r#"<path d="M11.8 6.2A4.6 4.6 0 1 0 12.4 9.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M12.4 3.4V6.6H9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
);
pub static LIBRARY: Icon = glyph(
    "orbis-library",
    r#"<rect x="2.5" y="5.5" width="11" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4 3.6H12M5.5 1.9H10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
);
pub static QUEUE: Icon =
    glyph("orbis-queue", r#"<path d="M2.5 4H13.5M2.5 8H13.5M2.5 12H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M11 10.2V13.8L13.8 12Z" fill="currentColor"/>"#);
pub static WAVE: Icon = glyph("orbis-wave", r#"<path d="M2.5 7V9M5 5V11M7.5 2.5V13.5M10 5.5V10.5M12.5 6.5V9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>"#);
pub static PLAY_NEXT: Icon = glyph(
    "orbis-play-next",
    r#"<path d="M2.5 8H9.5M2.5 12H9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M2.5 2.4V5.6L5.2 4Z" fill="currentColor"/><path d="M7.5 4H13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
);
pub static ADD: Icon = glyph(
    "orbis-add",
    r#"<path d="M2.5 4H10.5M2.5 8H7.5M2.5 12H7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12 7.5V13.5M9 10.5H15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
);
pub static DOWNLOAD: Icon = glyph(
    "orbis-download",
    r#"<path d="M8 2.5V10M4.8 7L8 10.2L11.2 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 13.3H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
);
pub static SEARCH: Icon = glyph(
    "orbis-search",
    r#"<circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M10.2 10.2L13 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
);
pub static RELOAD: Icon = glyph(
    "orbis-reload",
    r#"<path d="M12.6 6.4A4.9 4.9 0 1 0 12.8 9.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M13 3.4V6.6H9.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
);
pub static PLUS: Icon = glyph("orbis-plus", r#"<path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#);
pub static PLAYLIST: Icon = glyph(
    "orbis-playlist",
    r#"<path d="M2.5 4H10.5M2.5 7.5H10.5M2.5 11H7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12.5 4.5V11.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="11" cy="11.6" r="1.7" stroke="currentColor" stroke-width="1.2" fill="none"/>"#,
);
pub static SHUFFLE: Icon = glyph(
    "orbis-shuffle",
    r#"<path d="M2.5 4.5H4.6C6 4.5 6.9 5.2 7.6 6.4L8.4 7.6C9.1 8.8 10 9.5 11.4 9.5H13.5M2.5 9.5H4.6C5.4 9.5 6 9.3 6.5 8.8M9.5 5.2C10 4.7 10.6 4.5 11.4 4.5H13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M12 3L13.6 4.5L12 6M12 8L13.6 9.5L12 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
);
pub static SETTINGS: Icon = glyph(
    "orbis-settings",
    r#"<path d="M3 5H13M3 11H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="5" r="1.6" fill="currentColor"/><circle cx="10.5" cy="11" r="1.6" fill="currentColor"/>"#,
);
pub static TAG: Icon = glyph(
    "orbis-tag",
    r#"<path d="M2.8 7.6V3.4C2.8 3.1 3.1 2.8 3.4 2.8H7.6L13.2 8.4L8.4 13.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><circle cx="5.6" cy="5.6" r="1" fill="currentColor"/>"#,
);
pub static MORE: Icon =
    glyph("orbis-more", r#"<circle cx="3.8" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.2" cy="8" r="1.1" fill="currentColor"/>"#);
pub static TRASH: Icon =
    glyph("orbis-trash", r#"<path d="M3 4.5H13M6.5 4.5V3H9.5V4.5M4.5 4.5L5.1 13H10.9L11.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#);
