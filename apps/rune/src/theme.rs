//! How Orbis looks here: the rune-kit `Kit` seeded with Orbis's own colours
//! (`docs/design/tokens.json`: paper, ink and tint), the roles views name, and the app's icons.

use rune::{Color, El, Icon, TextStyle, oklch, row, text};
use rune_kit::{Kit, PaletteSeed};

/// The kit and the roles the views use, built once per view.
pub struct Look {
    pub k: Kit,
    pub fg: Color,
    pub muted: Color,
    pub faint: Color,
    /// Hairlines between rows.
    pub rule: Color,
    pub accent: Color,
    /// A row or title: `ui` at `ui_medium`'s weight.
    pub title: TextStyle,
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
        Look {
            fg: k.c.text_base,
            muted: k.c.text_muted,
            faint: k.c.text_faint,
            rule: k.c.border_weak,
            accent: seed.accent,
            title: TextStyle { weight: k.ty.ui_medium.weight, ..k.ty.ui },
            figures: k.ty.small.features("'tnum' 1"),
            k,
        }
    }

    /// A Set's square: no artwork yet, so a colour from its id with its first letter on it.
    pub fn tile(&self, id: &str, title: &str, size: f32) -> El {
        let hue = id.bytes().fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b))) % 360;
        let (l, c) = if self.k.dark { (0.42, 0.11) } else { (0.78, 0.09) };
        let letter = title.chars().find(|c| c.is_alphanumeric()).unwrap_or('·').to_uppercase().to_string();
        let style = if size >= 64.0 { TextStyle { size: size * 0.36, line_height: size * 0.44, ..self.k.ty.body_medium } } else { self.k.ty.small_medium };
        row().size(size, size).radius(if size >= 64.0 { self.k.radius.xl } else { self.k.radius.sm }).fill(oklch(l, c, hue as f32)).center().child(text(letter).font(style).color(self.fg.alpha(0.85)))
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
