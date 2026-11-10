//! The Listening Queue: the person's Sets lined up to play, shared by all their devices. The
//! active Set comes first, then what plays after it. Pressing a Set plays it and keeps the rest
//! of the queue; a Set leaves the queue when it plays out.

use rune::{El, ScrollSpec, col, text};

use crate::api;
use crate::library::{note, set_row};
use crate::load::Load;
use crate::model::Queue;
use crate::theme::Look;
use crate::{App, Screen};

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
            if s.playing.set.is_none() {
                s.playing.set = s.queue.items.data.as_ref().and_then(|q| q.active().cloned());
            }
        });
    }
}

/// The Listening Queue screen.
pub fn view(s: &App, l: &Look) -> El {
    let q = &s.queue.items;
    let body = match &q.data {
        None if q.busy => note(l, "queue-loading", "Loading the Listening Queue…", None),
        None => note(l, "queue-failed", q.error.as_deref().unwrap_or("The Listening Queue isn't loaded"), Some(("Try again", |s: &mut App| s.reload_queue()))),
        Some(queue) if queue.entries.is_empty() => {
            note(l, "queue-empty", "The Listening Queue is empty. Play a Set, or add one from the Library.", Some(("Open Library", |s: &mut App| s.go(Screen::Library))))
        }
        Some(queue) => {
            let at = queue.active_set_id.as_ref().and_then(|a| queue.entries.iter().position(|e| e.id == *a));
            let (earlier, rest) = queue.entries.split_at(at.unwrap_or(0));
            let (active, later) = match at {
                Some(_) => (rest.first(), rest.get(1..).unwrap_or_default()),
                None => (None, rest),
            };
            let section = |key: &str, title: &str| text(title.to_owned()).key(key.to_owned()).font(l.title).color(l.muted).px(8.0).pt(16.0).pb(4.0);
            col()
                .key("queue-sets")
                .w_full()
                .px(8.0)
                .pb(8.0)
                .children(active.map(|_| section("now-section", "Now playing")))
                .children(active.map(|x| set_row(s, x, l, false)))
                .children((!later.is_empty()).then(|| section("next-section", "Up next")))
                .children(later.iter().map(|x| set_row(s, x, l, false)))
                .children((!earlier.is_empty()).then(|| section("earlier-section", "Earlier in the queue")))
                .children(earlier.iter().map(|x| set_row(s, x, l, false)))
        }
    };
    col().key("queue").w_full().h_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(body)
}
