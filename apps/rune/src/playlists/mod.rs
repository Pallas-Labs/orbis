//! Playlists: the Person's own, and the Collaborative ones others made and they edit (ADR 0010).
//! The sidebar lists them; one opens as a page of its Sets. Play replaces the Listening Queue
//! with its playable Sets, in order or shuffled. Its creator renames and deletes it; its creator
//! and editors add and remove Sets, from the Set's menu anywhere in the app.

mod view;

use rune::TextEdit;

use crate::api;
use crate::dialogs::Dialog;
use crate::load::Load;
use crate::model::{Playlist, PlaylistDetail, Role};
use crate::{App, Screen};

pub use view::screen;

#[derive(Default)]
pub struct State {
    /// Own Playlists, and Collaborative ones the Person edits.
    pub lists: Load<(Vec<Playlist>, Vec<Playlist>)>,
    /// The Playlist open now.
    pub open: Load<PlaylistDetail>,
}

impl State {
    /// Every Playlist the Person may add a Set to, own first.
    pub fn editable(&self) -> Vec<&Playlist> {
        self.lists.data.iter().flat_map(|(own, shared)| own.iter().chain(shared.iter())).collect()
    }

    pub fn name(&self, id: &str) -> Option<&str> {
        self.editable().into_iter().find(|p| p.id == id).map(|p| p.name.as_str())
    }
}

impl App {
    /// Loads the list of Playlists.
    pub fn reload_playlists(&mut self) {
        self.playlists.lists.begin();
        self.spawn(api::playlists, |s, got| {
            if let Some(why) = s.playlists.lists.land(got) {
                s.say(format!("Couldn't load Playlists: {why}"));
            }
        });
    }

    /// Opens a Playlist's page and loads its Sets.
    pub fn open_playlist(&mut self, id: &str) {
        self.screen = Screen::Playlist(id.to_owned());
        if self.playlists.open.data.as_ref().is_some_and(|p| p.id != id) {
            self.playlists.open.data = None;
        }
        self.reload_playlist();
    }

    /// Loads the open Playlist again.
    pub fn reload_playlist(&mut self) {
        let Screen::Playlist(id) = &self.screen else { return };
        let id = id.clone();
        self.playlists.open.begin();
        self.spawn(
            move || api::playlist(&id),
            |s, got| {
                let ours = matches!((&s.screen, &got), (Screen::Playlist(open), Ok(p)) if *open == p.id);
                if ours || got.is_err() {
                    let urls: Vec<String> = got.iter().flat_map(|p| p.sets.iter().filter_map(|x| x.artwork_url.clone())).collect();
                    s.playlists.open.land(got);
                    s.want_artwork(urls.iter().map(String::as_str));
                }
            },
        );
    }

    /// Replaces the Listening Queue with the Playlist's playable Sets and plays the first.
    pub fn play_playlist(&mut self, id: &str, shuffled: bool) {
        let id = id.to_owned();
        self.spawn(
            move || api::play_playlist(&id, shuffled),
            |s, got| match got {
                Ok(queue) => {
                    let first = queue.active().cloned();
                    s.queue.items.land(Ok(queue));
                    match first {
                        Some(set) => s.start_set(set),
                        None => s.say("Nothing in this Playlist can play yet".to_owned()),
                    }
                }
                Err(why) => s.say(format!("Couldn't play the Playlist: {why}")),
            },
        );
    }

    /// Asks for a new Playlist's name; with `add`, that Set goes in it.
    pub fn new_playlist(&mut self, add: Option<String>) {
        self.dialog = Some(Dialog::NewPlaylist { edit: focused(""), add, busy: false, error: None });
    }

    /// Makes the Playlist the dialog names, with its Set, and opens it.
    pub fn create_playlist(&mut self) {
        let Some(Dialog::NewPlaylist { edit, add, busy, error }) = self.dialog.as_mut() else { return };
        let name = edit.text.trim().to_owned();
        if name.is_empty() || *busy {
            return;
        }
        (*busy, *error) = (true, None);
        let add = add.clone();
        self.spawn(
            move || {
                let made = api::create_playlist(&name)?;
                if let Some(set) = &add {
                    api::set_members(&made.id, std::slice::from_ref(set))?;
                }
                Ok::<_, String>(made)
            },
            |s, got| match got {
                Ok(made) => {
                    s.dialog = None;
                    s.say(format!("Made {}", made.name));
                    s.reload_playlists();
                    s.reload_library();
                    s.open_playlist(&made.id);
                }
                Err(why) => s.dialog_failed(why),
            },
        );
    }

    /// Asks for the open Playlist's new name.
    pub fn rename_playlist(&mut self) {
        let Some(p) = self.playlists.open.data.as_ref() else { return };
        self.dialog = Some(Dialog::Rename { id: p.id.clone(), edit: focused(&p.name), busy: false, error: None });
    }

    pub fn save_rename(&mut self) {
        let Some(Dialog::Rename { id, edit, busy, error }) = self.dialog.as_mut() else { return };
        let (id, name) = (id.clone(), edit.text.trim().to_owned());
        if name.is_empty() || *busy {
            return;
        }
        (*busy, *error) = (true, None);
        self.spawn(
            move || api::rename_playlist(&id, &name),
            |s, got| match got {
                Ok(_) => {
                    s.dialog = None;
                    s.reload_playlists();
                    s.reload_playlist();
                }
                Err(why) => s.dialog_failed(why),
            },
        );
    }

    /// Asks before deleting the open Playlist.
    pub fn confirm_delete_playlist(&mut self) {
        let Some(p) = self.playlists.open.data.as_ref().filter(|p| p.role == Role::Creator) else { return };
        self.dialog = Some(Dialog::DeletePlaylist { id: p.id.clone(), name: p.name.clone() });
    }

    pub fn delete_playlist(&mut self, id: &str) {
        let id = id.to_owned();
        self.dialog = None;
        self.spawn(
            move || api::delete_playlist(&id),
            |s, got| match got {
                Ok(gone) => {
                    s.say(format!("Deleted {}", gone.name));
                    if matches!(&s.screen, Screen::Playlist(open) if *open == gone.id) {
                        s.go(Screen::Library);
                    }
                    s.reload_playlists();
                    s.reload_library();
                }
                Err(why) => s.say(format!("Not deleted: {why}")),
            },
        );
    }

    /// Puts a Set in a Playlist, or takes it out when it's there: Orbis's members are read
    /// first, so another editor's change isn't lost.
    pub fn toggle_in_playlist(&mut self, set: &str, playlist: &str) {
        let (set, playlist) = (set.to_owned(), playlist.to_owned());
        let name = self.playlists.name(&playlist).unwrap_or("the Playlist").to_owned();
        self.spawn(
            move || {
                let mut members: Vec<String> = api::playlist(&playlist)?.sets.into_iter().map(|x| x.id).collect();
                let added = !members.contains(&set);
                if added {
                    members.push(set.clone());
                } else {
                    members.retain(|m| *m != set);
                }
                api::set_members(&playlist, &members)?;
                Ok::<_, String>(added)
            },
            move |s, got| match got {
                Ok(added) => {
                    s.say(if added { format!("Added to {name}") } else { format!("Removed from {name}") });
                    s.reload_playlists();
                    s.reload_library();
                    s.reload_playlist();
                }
                Err(why) => s.say(format!("Playlist not changed: {why}")),
            },
        );
    }
}

/// A field holding `text`, focused, with all of it chosen.
pub fn focused(text: &str) -> TextEdit {
    let mut edit = TextEdit::new(text);
    edit.anchor = 0;
    edit.focused = true;
    edit
}
