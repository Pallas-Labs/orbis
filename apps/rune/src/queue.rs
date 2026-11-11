//! The Listening Queue: the person's Sets lined up to play, shared by all their devices. The
//! active Set comes first, then what plays after it. Pressing a Set plays it and keeps the rest
//! of the queue; a Set leaves the queue when it plays out. Another device's change arrives on
//! the live event stream and shows at once.

use rune::{El, ScrollSpec, col, text};
use rune_kit::Button;

use crate::load::Load;
use crate::model::Queue;
use crate::rows::{Place, set_row};
use crate::theme::{Look, size};
use crate::{App, Screen, api};

#[derive(Default)]
pub struct State {
    pub items: Load<Queue>,
}

impl App {
    /// Loads the queue, as other devices may have changed it.
    pub fn reload_queue(&mut self) {
        self.queue.items.begin();
        self.spawn(api::queue, |s, got| {
            if let Some(why) = s.queue.items.land(got) {
                s.say(format!("Couldn't load the Listening Queue: {why}"));
            }
            s.queue_landed();
        });
    }

    /// The queue changed: an idle player shows its active Set, and its rows ask for Artwork.
    pub fn queue_landed(&mut self) {
        let active = self.queue.items.data.as_ref().and_then(|q| q.active().cloned());
        let loaded = self.playing.set.as_ref().map(|x| x.id.clone());
        match (active, loaded) {
            (Some(active), None) => self.show_set(active),
            // Orbis's active Set changed (another device): an idle player follows it, and one
            // paused or stopped on the old Set asks Orbis again before it plays.
            (Some(active), Some(loaded)) if active.id != loaded => {
                if self.playing.status == crate::playing::Status::Idle {
                    self.show_set(active);
                } else {
                    self.playing.unconfirm();
                }
            }
            (None, Some(_)) => self.playing.unconfirm(),
            _ => {}
        }
        // Thumbnails for the rows; the large picture only for the Set the player shows.
        let large = self.playing.set.as_ref().and_then(|x| x.artwork_large_url.clone());
        let urls: Vec<String> = self.queue.items.data.iter().flat_map(|q| q.entries.iter()).filter_map(|x| x.artwork_url.clone()).chain(large).collect();
        self.want_artwork(urls.iter().map(String::as_str));
    }
}

/// The Listening Queue screen.
pub fn view(s: &App, l: &Look) -> El {
    let q = &s.queue.items;
    let body = match &q.data {
        None if q.busy => l.skeleton("queue-loading", 5),
        None => l.empty(
            "queue-failed",
            "The Listening Queue didn't load",
            q.error.as_deref().unwrap_or(""),
            Some(Button::new("Try again").on_press(|s: &mut App| s.reload_queue()).build(&l.k).key("queue-retry")),
        ),
        Some(queue) if queue.entries.is_empty() => l.empty(
            "queue-empty",
            "The Listening Queue is empty",
            "Play a Set or a Playlist, or add a Set with Play Next or Add to Queue.",
            Some(Button::new("Open Library").on_press(|s: &mut App| s.go(Screen::Library)).build(&l.k).key("queue-open-library")),
        ),
        Some(queue) => {
            let at = queue.active_set_id.as_ref().and_then(|a| queue.entries.iter().position(|e| e.id == *a));
            let (earlier, rest) = queue.entries.split_at(at.unwrap_or(0));
            let (active, later) = match at {
                Some(_) => (rest.first(), rest.get(1..).unwrap_or_default()),
                None => (None, rest),
            };
            let section = |key: &str, title: String| text(title).key(key.to_owned()).font(l.title).color(l.muted).px(size::ROW_X).pt(16.0).pb(6.0);
            let rows = |sets: &[crate::model::Set]| sets.iter().map(|x| set_row(s, x, &Place::Queue, l)).collect::<Vec<_>>();
            col()
                .key("queue-sets")
                .w_full()
                .px(size::PAGE_X - size::ROW_X)
                .gap(1.0)
                .children(active.map(|_| section("now-section", "Now Playing".to_owned())))
                .children(active.map(|x| set_row(s, x, &Place::Queue, l)))
                .children((!later.is_empty()).then(|| section("next-section", format!("Up Next · {}", later.len()))))
                .children(rows(later))
                .children((!earlier.is_empty()).then(|| section("earlier-section", "Earlier in the Queue".to_owned())))
                .children(rows(earlier))
        }
    };
    col().key("queue").w_full().h_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(body.pb(16.0))
}
