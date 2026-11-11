//! The Library: every Set the person saved, newest first. A search filters by title, creator
//! and Tag as they type, and Tag pills narrow it to one Tag. A link pasted into Save a Link
//! becomes a Set, and Orbis starts its Download when Auto Download is on. A Set's menu edits its
//! Tags and removes it.

mod view;

use std::time::Duration;

use rune::TextEdit;

use crate::App;
use crate::api::{self, Placement};
use crate::dialogs::Dialog;
use crate::load::Load;
use crate::model::{Download, Set};
use crate::playlists::focused;

pub use view::view;

/// How long a Library with a Download running waits before it reloads.
const RECHECK: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct State {
    pub sets: Load<Vec<Set>>,
    pub query: TextEdit,
    /// The Tag the list is narrowed to.
    pub tag: Option<String>,
    /// A reload is due already, so another isn't set.
    recheck: bool,
}

impl State {
    /// The Sets the search and Tag let through, in the Library's order.
    pub fn shown(&self) -> Vec<&Set> {
        let words: Vec<String> = self.query.text.split_whitespace().map(str::to_lowercase).collect();
        let fits = |x: &Set| {
            let hay = format!("{} {} {}", x.title, x.creator.as_deref().unwrap_or(""), x.tags.join(" ")).to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str())) && self.tag.as_ref().is_none_or(|t| x.tags.contains(t))
        };
        self.sets.data.iter().flatten().filter(|x| fits(x)).collect()
    }

    /// Every Tag in the Library, most used first, then by name.
    pub fn tags(&self) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for tag in self.sets.data.iter().flatten().flat_map(|x| x.tags.iter()) {
            match counts.iter_mut().find(|(t, _)| t == tag) {
                Some((_, n)) => *n += 1,
                None => counts.push((tag.clone(), 1)),
            }
        }
        counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        counts
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
            s.refresh_copies();
            let downloading = s.library.sets.data.iter().flatten().any(|x| matches!(x.download_state, Download::Queued | Download::Downloading));
            if downloading && !s.library.recheck {
                s.library.recheck = true;
                s.after(RECHECK, |s| {
                    s.library.recheck = false;
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
        // Any Set the person can see, saved or only in a Collaborative Playlist.
        let Some(mut set) = self.find_set(id) else { return };
        set.download_state = Download::Queued;
        self.replace_set(&set);
        let id = id.to_owned();
        self.spawn(
            move || api::download(&id),
            |s, got| match got {
                Ok(set) => {
                    s.replace_set(&set);
                    s.reload_library();
                    s.reload_playlist();
                }
                Err(why) => {
                    s.reload_library();
                    s.say(format!("Download not started: {why}"));
                }
            },
        );
    }

    /// Opens Save a Link.
    pub fn save_link(&mut self) {
        self.dialog = Some(Dialog::SaveLink { edit: focused(""), busy: false, error: None });
    }

    /// Saves the link the dialog holds.
    pub fn save_link_now(&mut self) {
        let Some(Dialog::SaveLink { edit, busy, error }) = self.dialog.as_mut() else { return };
        let url = edit.text.trim().to_owned();
        if url.is_empty() || *busy {
            return;
        }
        (*busy, *error) = (true, None);
        self.spawn(
            move || api::save(&url),
            |s, got| match got {
                Ok((set, download)) => {
                    s.dialog = None;
                    s.say(download.said(&set.title));
                    s.library.query = TextEdit::new("");
                    s.library.tag = None;
                    s.reload_library();
                }
                Err(why) => s.dialog_failed(why),
            },
        );
    }

    /// Opens a Set's Tags to edit.
    pub fn edit_tags(&mut self, id: &str) {
        let Some(set) = self.find_set(id) else { return };
        self.dialog = Some(Dialog::Tags { set: set.id, title: set.title, tags: set.tags, edit: focused(""), busy: false, error: None });
    }

    /// Adds the Tag typed in the Tags dialog, as Orbis keeps them: trimmed, lower case, at most 40
    /// characters and 20 Tags.
    pub fn add_typed_tag(&mut self) {
        let Some(Dialog::Tags { tags, edit, error, .. }) = self.dialog.as_mut() else { return };
        let tag: String = edit.text.trim().to_lowercase().chars().take(40).collect();
        *edit = focused("");
        if tag.is_empty() || tags.contains(&tag) {
            return;
        }
        if tags.len() >= 20 {
            *error = Some("A Set holds at most 20 Tags".to_owned());
            return;
        }
        tags.push(tag);
    }

    /// Saves the Tags dialog's Tags.
    pub fn save_tags(&mut self) {
        self.add_typed_tag();
        let Some(Dialog::Tags { set, tags, busy, error, .. }) = self.dialog.as_mut() else { return };
        if *busy {
            return;
        }
        (*busy, *error) = (true, None);
        let (id, tags) = (set.clone(), tags.clone());
        self.spawn(
            move || api::set_tags(&id, &tags),
            |s, got| match got {
                Ok(set) => {
                    s.dialog = None;
                    s.replace_set(&set);
                }
                Err(why) => s.dialog_failed(why),
            },
        );
    }

    /// Asks before taking a Set out of the Library.
    pub fn confirm_remove(&mut self, id: &str) {
        let Some(set) = self.find_set(id) else { return };
        self.dialog = Some(Dialog::RemoveSet { id: set.id, title: set.title });
    }

    /// Takes a Set out of the Library at once, and tells Orbis.
    pub fn remove_set(&mut self, id: &str) {
        self.dialog = None;
        if let Some(sets) = self.library.sets.data.as_mut() {
            sets.retain(|x| x.id != id);
        }
        let id = id.to_owned();
        self.spawn(
            move || api::remove(&id),
            |s, got| match got {
                Ok(gone) => s.say(format!("Removed {}", gone.title)),
                Err(why) => {
                    s.say(format!("Not removed: {why}"));
                    s.reload_library();
                }
            },
        );
    }
}
