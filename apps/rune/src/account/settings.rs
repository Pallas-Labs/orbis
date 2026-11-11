//! Settings, in OpenCode's settings cards: the account, devices, the playback report and
//! signing out.

use rune::{El, ScrollSpec, col, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Spinner, Switch, TextInput};

use crate::App;
use crate::api::MeChange;
use crate::dialogs::Dialog;
use crate::model::day;
use crate::theme::{Look, size};

/// The Settings screen.
pub fn view(s: &App, l: &Look) -> El {
    let page = col()
        .key("settings")
        .w_full()
        .max_w(640.0)
        .px(size::PAGE_X)
        .pt(16.0)
        .pb(32.0)
        .gap(24.0)
        .child(section(l, "Account", account(s, l)))
        .child(section(l, "Devices", devices(s, l)))
        .child(section(l, "Playback", playback(s, l)))
        .child(row().w_full().justify_end().child(Button::new("Sign Out…").variant(ButtonVariant::Danger).on_press(|s: &mut App| s.dialog = Some(Dialog::SignOut)).build(&l.k).key("sign-out")));
    col().key("settings-scroll").w_full().h_full().min_h(0.0).items_center().scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(page)
}

/// A titled card of rows, each under a hairline but the first.
fn section(l: &Look, title: &str, rows: Vec<El>) -> El {
    let n = rows.len();
    let card = col()
        .w_full()
        .radius(l.k.radius.lg)
        .fill(l.k.c.layer_01)
        .border(1.0, l.k.c.border_muted)
        .px(20.0)
        .children(rows.into_iter().enumerate().map(|(i, r)| if i + 1 < n { r.border_sides([0.0, 0.0, 1.0, 0.0], l.rule) } else { r }));
    col().w_full().gap(8.0).child(text(title.to_owned()).font(l.title).color(l.muted).px(4.0)).child(card)
}

/// One setting: its name and what it does on the left, its control on the right.
fn setting(l: &Look, key: &str, title: &str, about: &str, control: El) -> El {
    row()
        .key(key.to_owned())
        .w_full()
        .py(16.0)
        .gap(16.0)
        .items_center()
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(text(title.to_owned()).font(l.title).color(l.fg))
                .children((!about.is_empty()).then(|| text(about.to_owned()).font(l.k.ty.ui).color(l.muted).wrap())),
        )
        .child(control)
}

fn account(s: &App, l: &Look) -> Vec<El> {
    let Some(me) = &s.account.me.data else {
        return vec![row().w_full().py(20.0).center().child(Spinner::new().size(16.0).build(&l.k))];
    };
    let name = TextInput::new(&s.account.username)
        .label("Name")
        .width(Some(200.0))
        .on_edit(|s: &mut App| &mut s.account.username)
        .on_submit(|s: &mut App, _| s.save_username())
        .build(&l.k)
        .key("settings-name");
    let (social, auto) = (me.social, me.auto_download);
    vec![
        setting(l, "settings-name-row", "Name", "What the Group sees. Press Return to save.", name),
        setting(
            l,
            "settings-social",
            "Share with Group",
            "The Group sees what you listen to, and you see theirs.",
            Switch::new(social).label("Share with Group").hide_label().on_toggle(move |s: &mut App| s.change_me(MeChange::Social(!social))).build(&l.k).key("social-switch"),
        ),
        setting(
            l,
            "settings-auto",
            "Auto Download",
            "Saving a Set starts its Download, so it's ready to play.",
            Switch::new(auto).label("Auto Download").hide_label().on_toggle(move |s: &mut App| s.change_me(MeChange::AutoDownload(!auto))).build(&l.k).key("auto-switch"),
        ),
    ]
}

fn devices(s: &App, l: &Look) -> Vec<El> {
    let mut rows: Vec<El> = match &s.account.devices.data {
        None => vec![row().w_full().py(20.0).center().child(Spinner::new().size(16.0).build(&l.k))],
        Some(list) => list
            .iter()
            .map(|d| {
                let used = d.last_used_at.as_deref().map_or_else(|| format!("Added {}", day(&d.added_at)), |at| format!("Last used {}", day(at)));
                let control = if d.current {
                    text("This device").font(l.k.ty.small_medium).color(l.muted)
                } else {
                    let id = d.id.clone();
                    Button::new("Sign Out").variant(ButtonVariant::Ghost).control_size(ControlSize::Small).on_press(move |s: &mut App| s.revoke_device(&id)).build(&l.k).key(format!("revoke-{}", d.id))
                };
                setting(l, &format!("device-{}", d.id), &d.label, &used, control)
            })
            .collect(),
    };
    let code = match (&s.account.code.data, s.account.code.busy) {
        (_, true) => Spinner::new().size(14.0).build(&l.k),
        (Some(c), false) => col()
            .items_end()
            .gap(2.0)
            .child(text(spaced(&c.code)).key("sign-in-code-shown").font(rune::TextStyle { tracking: 2.0, ..l.heading.mono() }).color(l.fg))
            .child(text("Works once, for a few minutes").font(l.k.ty.small).color(l.faint)),
        (None, false) => Button::new("Show a Code").control_size(ControlSize::Small).on_press(|s: &mut App| s.new_sign_in_code()).build(&l.k).key("new-sign-in-code"),
    };
    rows.push(setting(l, "settings-new-device", "Sign In Another Device", "Type this code on the new device's sign-in page.", code));
    rows.push(setting(
        l,
        "settings-approve",
        "Approve a Device",
        "A new device can show a code instead. Type it here to let it in.",
        Button::new("Approve…").control_size(ControlSize::Small).on_press(|s: &mut App| s.approve_device()).build(&l.k).key("approve-device"),
    ));
    rows
}

/// `ABCDEFGH` as `ABCD EFGH`.
fn spaced(code: &str) -> String {
    let letters: Vec<char> = code.chars().collect();
    letters.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

fn playback(s: &App, l: &Look) -> Vec<El> {
    let d = &s.diagnostics;
    let count = d.entries().count();
    let about = format!(
        "What the player did lately, as JSON, for a bug report. It names Sets by id only. {count} entries{}.",
        if d.unsent() > 0 { format!(", {} waiting to send", d.unsent()) } else { String::new() }
    );
    let copy = Button::new("Copy Report")
        .control_size(ControlSize::Small)
        .disabled(count == 0)
        .on_press_tx(|s: &mut App, tx| {
            let report = s.diagnostics.report(s.playing.snapshot());
            tx.copy(report);
            s.say("Copied the playback report".to_owned());
        })
        .build(&l.k)
        .key("copy-report");
    vec![setting(l, "settings-report", "Playback Report", &about, copy)]
}
