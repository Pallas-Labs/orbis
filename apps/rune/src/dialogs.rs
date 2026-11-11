//! The app's dialogs, one open at a time: Save a Link, a Set's Tags, a Playlist's name, the
//! confirmations before something is deleted, approving a device, and signing out. Each is the
//! kit's `Dialog` with OpenCode's footer: Cancel and the action, at the end.

use rune::{Cursor, El, TextEdit, col, el, icon, row, text};
use rune_kit::{Button, ButtonVariant, Dialog as Panel, TextInput};

use crate::App;
use crate::theme::Look;

/// The open dialog and what it holds.
#[derive(Debug)]
pub enum Dialog {
    SaveLink { edit: TextEdit, busy: bool, error: Option<String> },
    Tags { set: String, title: String, tags: Vec<String>, edit: TextEdit, busy: bool, error: Option<String> },
    NewPlaylist { edit: TextEdit, add: Option<String>, busy: bool, error: Option<String> },
    Rename { id: String, edit: TextEdit, busy: bool, error: Option<String> },
    DeletePlaylist { id: String, name: String },
    RemoveSet { id: String, title: String },
    Approve { edit: TextEdit, busy: bool, error: Option<String> },
    SignOut,
}

impl App {
    /// The dialog's call failed: it stays open and says why.
    pub fn dialog_failed(&mut self, why: String) {
        match self.dialog.as_mut() {
            Some(
                Dialog::SaveLink { busy, error, .. }
                | Dialog::Tags { busy, error, .. }
                | Dialog::NewPlaylist { busy, error, .. }
                | Dialog::Rename { busy, error, .. }
                | Dialog::Approve { busy, error, .. },
            ) => {
                (*busy, *error) = (false, Some(why));
            }
            _ => self.say(why),
        }
    }
}

fn edit_of(s: &mut App) -> &mut TextEdit {
    match s.dialog.as_mut() {
        Some(Dialog::SaveLink { edit, .. } | Dialog::Tags { edit, .. } | Dialog::NewPlaylist { edit, .. } | Dialog::Rename { edit, .. } | Dialog::Approve { edit, .. }) => edit,
        // The field is gone with its dialog; a late edit lands in a scratch field.
        _ => {
            s.spare_edit = TextEdit::new("");
            &mut s.spare_edit
        }
    }
}

/// A dialog's width, as OpenCode's.
const WIDTH: f32 = 440.0;

/// Cancel and the action, at the dialog's end.
fn footer(l: &Look, action: &str, key: &str, busy: bool, danger: bool, press: impl Fn(&mut App) + 'static) -> El {
    let cancel = Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.dialog = None).build(&l.k).key("dialog-cancel");
    let variant = if danger { ButtonVariant::Danger } else { ButtonVariant::Contrast };
    let go = Button::new(action).variant(variant).disabled(busy).on_press(press).build(&l.k).key(key.to_owned());
    row().w_full().px(16.0).pb(16.0).pt(4.0).gap(8.0).justify_end().child(cancel).child(go)
}

/// Words in a dialog's body, which wrap.
fn words(l: &Look, t: &str) -> El {
    text(t.to_owned()).font(l.k.ty.ui).color(l.muted).wrap()
}

fn problem(l: &Look, error: &Option<String>) -> Option<El> {
    error.clone().map(|why| text(why).key("dialog-problem").font(l.k.ty.ui).color(l.k.c.danger.fg).wrap())
}

fn field(l: &Look, edit: &TextEdit, placeholder: &str, label: &str, submit: fn(&mut App)) -> El {
    TextInput::new(edit).width(None).placeholder(placeholder).label(label).on_edit(edit_of).on_submit(move |s: &mut App, _| submit(s)).build(&l.k).key("dialog-field")
}

/// The open dialog, mounted into `layer`.
pub fn view(s: &App, l: &Look, layer: &mut Vec<El>) {
    let Some(dialog) = &s.dialog else { return };
    // The kit's panel takes its width from its children; a strut holds it at OpenCode's 440.
    let panel = |title: &str| Panel::new("dialog", title).open(true).fit().width(WIDTH).on_close(|s: &mut App| s.dialog = None).child(el().w(WIDTH).h(0.0));
    let body = |children: Vec<El>| col().w_full().px(16.0).pb(12.0).gap(10.0).children(children);
    match dialog {
        Dialog::SaveLink { edit, busy, error } => panel("Save a Link")
            .description("A YouTube or SoundCloud video, or an Apple Music album.")
            .child(body([Some(field(l, edit, "https://…", "Link", App::save_link_now)), problem(l, error)].into_iter().flatten().collect()))
            .child(footer(l, if *busy { "Saving…" } else { "Save" }, "dialog-save", *busy || edit.text.trim().is_empty(), false, App::save_link_now))
            .build(&l.k, layer),
        Dialog::Tags { title, tags, edit, busy, error, .. } => {
            let suggestions: Vec<String> = s.library.tags().into_iter().map(|(t, _)| t).filter(|t| !tags.contains(t)).take(8).collect();
            let chips = row().w_full().flex_wrap().gap(6.0).children(tags.iter().map(|t| chip(l, t, true))).children(suggestions.iter().map(|t| chip(l, t, false)));
            let input = TextInput::new(edit).width(None).placeholder("Add a Tag").label("New Tag").on_edit(edit_of).on_submit(|s: &mut App, _| s.add_typed_tag()).build(&l.k).key("dialog-field");
            panel("Tags")
                .description("Press Return to add a Tag.")
                .child(body([Some(words(l, &format!("For {title}"))), Some(chips), Some(input), problem(l, error)].into_iter().flatten().collect()))
                .child(footer(l, if *busy { "Saving…" } else { "Save" }, "dialog-save", *busy, false, App::save_tags))
                .build(&l.k, layer)
        }
        Dialog::NewPlaylist { edit, busy, error, add } => panel("New Playlist")
            .description(if add.is_some() { "The Set goes in it." } else { "Add Sets from their menus." })
            .child(body([Some(field(l, edit, "Name", "Playlist name", App::create_playlist)), problem(l, error)].into_iter().flatten().collect()))
            .child(footer(l, "Make", "dialog-save", *busy || edit.text.trim().is_empty(), false, App::create_playlist))
            .build(&l.k, layer),
        Dialog::Rename { edit, busy, error, .. } => panel("Rename Playlist")
            .child(body([Some(field(l, edit, "Name", "Playlist name", App::save_rename)), problem(l, error)].into_iter().flatten().collect()))
            .child(footer(l, "Rename", "dialog-save", *busy || edit.text.trim().is_empty(), false, App::save_rename))
            .build(&l.k, layer),
        Dialog::DeletePlaylist { id, name } => {
            let id = id.clone();
            panel(&format!("Delete {name}?"))
                .description("Its Sets stay in the Library. This can't be undone.")
                .child(footer(l, "Delete", "dialog-save", false, true, move |s| s.delete_playlist(&id)))
                .build(&l.k, layer)
        }
        Dialog::RemoveSet { id, title } => {
            let id = id.clone();
            panel(&format!("Remove {title}?"))
                .description("It leaves your Library and Playlists.")
                .child(body(vec![words(l, "Its audio stays on Vanta while anyone else keeps the Set.")]))
                .child(footer(l, "Remove", "dialog-save", false, true, move |s| s.remove_set(&id)))
                .build(&l.k, layer)
        }
        Dialog::Approve { edit, busy, error } => panel("Approve a Device")
            .description("Type the six digits the new device shows.")
            .child(body([Some(field(l, edit, "123 456", "Approval Code", App::approve_now)), problem(l, error)].into_iter().flatten().collect()))
            .child(footer(l, "Approve", "dialog-save", *busy || edit.text.trim().is_empty(), false, App::approve_now))
            .build(&l.k, layer),
        Dialog::SignOut => panel("Sign out of Orbis?")
            .description("Your Library stays as it is.")
            .child(body(vec![words(l, "Orbis forgets this device's key, and so does this computer. Sign in again with a Sign-in Code.")]))
            .child(footer(l, "Sign Out", "dialog-save", false, true, App::sign_out))
            .build(&l.k, layer),
    }
}

/// A Tag in the Tags dialog: one the Set has, with a cross that takes it off, or a suggestion
/// that puts it on.
fn chip(l: &Look, tag: &str, on: bool) -> El {
    let name = tag.to_owned();
    row()
        .key(format!("dialog-tag-{tag}"))
        .role("button")
        .label(if on { format!("Remove Tag {tag}") } else { format!("Add Tag {tag}") })
        .focusable(true)
        .cursor(Cursor::Pointer)
        .press_scale(0.96)
        .h(24.0)
        .px(8.0)
        .gap(6.0)
        .items_center()
        .radius(l.k.radius.md)
        .fill(if on { l.accent.alpha(0.16) } else { l.fg.alpha(0.05) })
        .hover(l.fg.alpha(0.04))
        .on_press(move |s: &mut App| {
            if let Some(Dialog::Tags { tags, .. }) = s.dialog.as_mut() {
                if tags.contains(&name) {
                    tags.retain(|t| *t != name);
                } else if tags.len() < 20 {
                    tags.push(name.clone());
                }
            }
        })
        .child(text(tag.to_owned()).font(l.k.ty.small_medium).color(if on { l.accent } else { l.muted }))
        .child(icon(if on { l.k.glyph.close } else { &crate::theme::PLUS }, 12.0).color(if on { l.accent } else { l.faint }))
}
