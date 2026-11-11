//! Each Set's Artwork: its provider's image, fetched off the UI thread when a row that shows it
//! comes into view, decoded by Rune's image cache, and kept for the 160 most recently wanted.
//! Until a picture lands, and when a Set has none, its square shows a colour and its first
//! letter (`theme::Look::tile`).
//!
//! Headless renders and the demo draw made-up Artwork: a gradient and an orb, from the Set's id.

use std::collections::{HashMap, VecDeque};

use rune::{Image, ImageCache, Waker};

use crate::App;

/// Pictures kept decoded at once; a list's thumbnails are about 0.7 MB each.
const KEPT: usize = 160;
/// Fetches running at once.
const AT_ONCE: usize = 4;

#[derive(Default)]
pub struct Artwork {
    cache: Option<ImageCache>,
    images: HashMap<String, Image>,
    /// URLs asked for, oldest first, for eviction.
    order: VecDeque<String>,
    /// URLs waiting for a fetch.
    waiting: VecDeque<String>,
    running: usize,
    /// Pictures decoding, which the view draws once they are ready.
    decoding: Vec<String>,
}

impl Artwork {
    /// Starts the cache with the app's waker. Without it (tests), no Artwork draws.
    pub fn start(&mut self, waker: Waker) {
        self.cache = Some(ImageCache::new(waker));
    }

    /// The picture at `url`, once it has decoded.
    pub fn get(&self, url: Option<&str>) -> Option<&Image> {
        self.images.get(url?).filter(|i| i.is_ready() && i.error().is_none())
    }

    /// Another account signs in: fetches still out land in the old session and are dropped,
    /// so they give back their slots now. The pictures stay.
    pub fn new_session(&mut self) {
        self.running = 0;
        self.waiting.clear();
    }

    /// Fetches out now.
    #[cfg(test)]
    pub fn fetching(&self) -> usize {
        self.running
    }

    /// Whether a picture finished decoding since the last call, so the view shows it.
    pub fn poll(&mut self) -> bool {
        let before = self.decoding.len();
        let images = &self.images;
        self.decoding.retain(|url| images.get(url).is_some_and(|i| !i.is_ready()));
        self.decoding.len() != before
    }

    fn keep(&mut self, url: &str, image: Image) {
        if !image.is_ready() {
            self.decoding.push(url.to_owned());
        }
        self.images.insert(url.to_owned(), image);
        while self.images.len() > KEPT {
            let Some(old) = self.order.pop_front() else { break };
            self.images.remove(&old);
        }
    }

    /// Made-up Artwork for `url`, drawn from `seed`, ready before the first frame.
    pub fn demo(&mut self, url: &str, seed: &str, side: u32) {
        let Some(cache) = &self.cache else { return };
        let image = cache.rgba(side, side, made_up(seed, side));
        let _ = image.wait();
        self.order.push_back(url.to_owned());
        self.keep(url, image);
    }
}

impl App {
    /// Fetches the Artwork at each of `urls` not already here or on its way.
    pub fn want_artwork<'a>(&mut self, urls: impl IntoIterator<Item = &'a str>) {
        let art = &mut self.artwork;
        if art.cache.is_none() {
            return;
        }
        for url in urls {
            if url.is_empty() || art.images.contains_key(url) || art.waiting.iter().any(|w| w == url) {
                continue;
            }
            art.order.retain(|o| o != url);
            art.order.push_back(url.to_owned());
            art.waiting.push_back(url.to_owned());
        }
        self.fetch_artwork();
    }

    fn fetch_artwork(&mut self) {
        while self.artwork.running < AT_ONCE {
            let Some(url) = self.artwork.waiting.pop_front() else { return };
            self.artwork.running += 1;
            let asked = url.clone();
            self.spawn(
                move || crate::api::artwork(&asked),
                move |s, got| {
                    s.artwork.running -= 1;
                    if let (Ok(bytes), Some(cache)) = (got, &s.artwork.cache) {
                        let image = cache.load(bytes);
                        s.artwork.keep(&url, image);
                    }
                    s.fetch_artwork();
                },
            );
        }
    }
}

/// A square of made-up Artwork: a diagonal gradient between two hues from `seed`, with a soft
/// orb, as straight-alpha sRGB RGBA.
fn made_up(seed: &str, side: u32) -> Vec<u8> {
    let h = seed.bytes().fold(2166136261u32, |h, b| (h ^ u32::from(b)).wrapping_mul(16777619));
    let hue = |shift: u32| f32::from(((h >> shift) % 360) as u16);
    let (a, b) = (rgb(hue(0), 0.55, 0.42), rgb(hue(9) + 60.0, 0.6, 0.22));
    let orb = rgb(hue(17), 0.45, 0.78);
    let (cx, cy, r) = (0.3 + (h >> 3 & 7) as f32 / 18.0, 0.35 + (h >> 7 & 7) as f32 / 20.0, 0.22 + (h >> 11 & 7) as f32 / 40.0);
    let mut out = Vec::with_capacity((side * side * 4) as usize);
    for y in 0..side {
        for x in 0..side {
            let (u, v) = (x as f32 / side as f32, y as f32 / side as f32);
            let t = ((u + v) / 2.0).clamp(0.0, 1.0);
            let d = ((u - cx).powi(2) + (v - cy).powi(2)).sqrt();
            let glow = (1.0 - ((d - r) / 0.06).clamp(0.0, 1.0)) * 0.85;
            for c in 0..3 {
                let base = a[c] * (1.0 - t) + b[c] * t;
                out.push(((base * (1.0 - glow) + orb[c] * glow) * 255.0) as u8);
            }
            out.push(255);
        }
    }
    out
}

/// HSL to sRGB, each 0..1.
fn rgb(hue: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let h = (hue.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}
