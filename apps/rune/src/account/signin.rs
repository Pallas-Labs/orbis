//! The sign-in page a signed-out window shows: one column of the three ways in.

use rune::{El, TextStyle, col, el, row, text};
use rune_kit::{Button, ButtonVariant, SegmentedControl, Spinner, TextInput};

use super::Method;
use crate::App;
use crate::api::DEFAULT_URL;
use crate::theme::Look;

/// The sign-in page.
pub fn view(s: &App, l: &Look) -> El {
    let si = &s.account.signin;
    let methods = ["Sign-in Code", "Approve", "Join the Group"];
    let picked = match si.method {
        Method::Code => 0,
        Method::Approve => 1,
        Method::Join => 2,
    };
    let pick = SegmentedControl::new(&methods, Some(picked))
        .label("How to sign in")
        .width(Some(360.0))
        .on_pick(|s: &mut App, i, _| s.sign_in_by([Method::Code, Method::Approve, Method::Join][i]))
        .build(&l.k)
        .key("sign-in-method");
    let body = match si.method {
        Method::Code => by_code(s, l),
        Method::Approve => by_approval(s, l),
        Method::Join => by_passcode(s, l),
    };
    let problem = si.error.clone().map(|why| text(why).key("sign-in-problem").font(l.k.ty.ui).color(l.k.c.danger.fg).wrap());
    let card = col()
        .key("sign-in")
        .w(360.0)
        .gap(20.0)
        .child(col().gap(6.0).child(text("Sign in to Orbis").font(l.display).color(l.fg)).child(text("Use the Group you already listen with.").font(l.k.ty.ui).color(l.muted)))
        .child(pick)
        .child(body)
        .children(problem)
        .child(server(s, l));
    col().key("sign-in-page").w_full().h_full().items_center().pt(96.0).px(24.0).child(card)
}

fn words(l: &Look, t: &str) -> El {
    text(t.to_owned()).font(l.k.ty.ui).color(l.muted).wrap()
}

fn field(l: &Look, label: &str, input: El) -> El {
    col().w_full().gap(6.0).child(text(label.to_owned()).font(l.k.ty.small_medium).color(l.muted)).child(input)
}

fn go(l: &Look, label: &str, key: &str, busy: bool, press: fn(&mut App)) -> El {
    let button = Button::new(if busy { "Signing in…" } else { label }).variant(ButtonVariant::Contrast).disabled(busy).on_press(press).build(&l.k).key(key.to_owned());
    row().w_full().justify_end().child(button)
}

fn by_code(s: &App, l: &Look) -> El {
    let si = &s.account.signin;
    let input = TextInput::new(&si.code)
        .large()
        .placeholder("ABCD EFGH")
        .label("Sign-in Code")
        .text_style(TextStyle { tracking: 1.5, ..l.k.ty.mono })
        .on_edit(|s: &mut App| &mut s.account.signin.code)
        .on_submit(|s: &mut App, _| s.redeem_code())
        .build(&l.k)
        .key("sign-in-code");
    col().w_full().gap(14.0).child(words(l, "On a device that's signed in, open Settings and choose Sign In Another Device. Type the code it shows.")).child(field(l, "Sign-in Code", input)).child(go(
        l,
        "Sign In",
        "sign-in-go",
        si.busy,
        |s| s.redeem_code(),
    ))
}

fn by_approval(s: &App, l: &Look) -> El {
    let si = &s.account.signin;
    let shown = match &si.approval {
        Some(a) => {
            let digits: String = a.code.chars().filter(char::is_ascii_digit).collect();
            let spaced = if digits.len() == 6 { format!("{} {}", &digits[..3], &digits[3..]) } else { a.code.clone() };
            let big = TextStyle { size: 34.0, line_height: 40.0, weight: 600.0, tracking: 4.0, ..l.k.ty.mono };
            col()
                .w_full()
                .py(20.0)
                .gap(10.0)
                .items_center()
                .radius(l.k.radius.lg)
                .fill(l.k.c.layer_01)
                .border(1.0, l.rule)
                .child(text(spaced).key("approval-code").font(big).color(l.fg))
                .child(row().gap(8.0).items_center().child(Spinner::new().size(12.0).build(&l.k)).child(text("Waiting for approval").font(l.k.ty.small).color(l.muted)))
        }
        None if si.busy => row().w_full().py(28.0).center().child(Spinner::new().size(16.0).build(&l.k)),
        None => row().w_full().justify_end().child(Button::new("Show a Code").on_press(|s: &mut App| s.start_approval()).build(&l.k).key("approval-again")),
    };
    col().w_full().gap(14.0).child(words(l, "On a signed-in iPhone, Mac or browser, open Settings, choose Approve a Device, and type this code.")).child(shown)
}

fn by_passcode(s: &App, l: &Look) -> El {
    let si = &s.account.signin;
    let name = TextInput::new(&si.username).placeholder("Your name").label("Name").on_edit(|s: &mut App| &mut s.account.signin.username).build(&l.k).key("join-name");
    let passcode = TextInput::new(&si.passcode)
        .placeholder("ABCD EFGH JKLM")
        .label("Group Passcode")
        .text_style(TextStyle { tracking: 1.0, ..l.k.ty.mono })
        .on_edit(|s: &mut App| &mut s.account.signin.passcode)
        .on_submit(|s: &mut App, _| s.join_group())
        .build(&l.k)
        .key("join-passcode");
    col()
        .w_full()
        .gap(14.0)
        .child(words(l, "New to the Group? The Host shares a Group Passcode or a Join Link; paste either."))
        .child(field(l, "Name the Group sees", name))
        .child(field(l, "Group Passcode", passcode))
        .child(go(l, "Join", "join-go", si.busy, |s| s.join_group()))
}

/// Which Orbis this signs in to, and a way to name another.
fn server(s: &App, l: &Look) -> El {
    let si = &s.account.signin;
    if si.other_server {
        let input = TextInput::new(&si.server).placeholder(DEFAULT_URL).label("Orbis address").on_edit(|s: &mut App| &mut s.account.signin.server).build(&l.k).key("sign-in-server");
        return field(l, "Orbis address", input);
    }
    let host = DEFAULT_URL.split("//").nth(1).and_then(|h| h.split('/').next()).unwrap_or(DEFAULT_URL);
    row()
        .w_full()
        .gap(6.0)
        .items_center()
        .child(text(format!("Signs in to {host}")).font(l.k.ty.small).color(l.faint))
        .child(el().grow(1.0))
        .child(Button::new("Use Another Orbis").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| s.account.signin.other_server = true).build(&l.k).key("sign-in-other"))
}
