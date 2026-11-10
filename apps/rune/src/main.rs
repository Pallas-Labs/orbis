//! Orbis on the desktop: the person's Library, their Listening Queue and Now Playing, against
//! the Orbis API. It plays a Set's Retained Audio through mpv, keeps the place in it, and moves
//! through the queue as each Set ends.
//!
//! `cargo run` opens the window, online, with the key from `ORBIS_URL` and `ORBIS_KEY` or the
//! config file (`api::Server`). `cargo run -- --snap out.png --scene library --at 1.5` renders
//! a scene headless, on made-up data and a frozen clock.

mod api;
mod audio;
mod clock;
mod demo;
#[cfg(test)]
mod goldens;
mod library;
mod load;
mod model;
mod playing;
mod queue;
mod theme;
mod timers;

use std::time::Duration;

use rune::{AppSpec, Chrome, Cx, El, Icon, Key, KeyEvent, Spring, Tx, col, el, text};
use rune_kit::shell::{self, PaneMotion, PaneState, Sidebar, SidebarRow, SidebarToggle, SplitView, Toolbar};
use rune_kit::{Button, ButtonVariant, ControlSize, Toast, ToastRegion};

use crate::theme::Look;

/// The screens, in the sidebar's order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    Library,
    Queue,
    Playing,
}

impl Screen {
    const ALL: [Screen; 3] = [Screen::Library, Screen::Queue, Screen::Playing];

    fn title(self) -> &'static str {
        match self {
            Screen::Library => "Library",
            Screen::Queue => "Listening Queue",
            Screen::Playing => "Now Playing",
        }
    }

    fn icon(self) -> &'static Icon {
        match self {
            Screen::Library => &theme::LIBRARY,
            Screen::Queue => &theme::QUEUE,
            Screen::Playing => &theme::WAVE,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Screen::Library => "nav-library",
            Screen::Queue => "nav-queue",
            Screen::Playing => "nav-playing",
        }
    }
}

/// Everything the app knows. The view draws it; handlers, landings and `poll` change it.
#[derive(Default)]
pub struct App {
    /// Where work goes: the live service, made-up data, or a test's stand-in.
    pub service: api::Service,
    pub timers: timers::Timers,
    pub screen: Screen,
    pub sidebar: PaneState,
    /// No server and key to sign in with: the app says how to add them.
    pub signed_out: bool,
    pub library: library::State,
    pub queue: queue::State,
    pub playing: playing::State,
    /// A short line that leaves on its own.
    pub toast: Option<String>,
}

impl App {
    fn new() -> App {
        App { sidebar: PaneState::new(220.0).range(160.0, 360.0), ..App::default() }
    }

    /// Opens `screen`, and reloads what it shows.
    pub fn go(&mut self, screen: Screen) {
        self.screen = screen;
        match screen {
            Screen::Library => self.reload_library(),
            Screen::Queue => self.reload_queue(),
            Screen::Playing => {}
        }
    }

    /// Shows `line` for four seconds.
    pub fn say(&mut self, line: String) {
        self.toast = Some(line.clone());
        self.after(Duration::from_secs(4), move |s| {
            if s.toast.as_deref() == Some(line.as_str()) {
                s.toast = None;
            }
        });
    }
}

fn view(s: &App, cx: &mut Cx<App>) -> El {
    let l = Look::new(cx.system_dark());
    let main = if s.signed_out {
        signed_out(&l)
    } else {
        let screen = match s.screen {
            Screen::Library => library::view(s, &l),
            Screen::Queue => queue::view(s, &l),
            Screen::Playing => playing::screen(s, &l),
        };
        let bar = if s.screen == Screen::Playing { None } else { playing::bar(s, &l) };
        col().w_full().h_full().min_h(0.0).child(col().w_full().grow(1.0).min_h(0.0).child(screen)).children(bar.map(|b| b.border_sides([1.0, 0.0, 0.0, 0.0], l.rule)))
    };
    let title = if s.signed_out { "Orbis" } else { s.screen.title() };
    let toolbar = Toolbar::new().title(title).trailing(match s.screen {
        _ if s.signed_out => el(),
        Screen::Playing => el(),
        _ => Button::new("Reload").variant(ButtonVariant::GhostMuted).control_size(ControlSize::Small).help("Reload (Ctrl+R)").on_press(|s: &mut App| s.go(s.screen)).build(&l.k).key("reload"),
    });
    let split = SplitView::new(main.key("main"))
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, sidebar(s, &l))
        .toolbar(toolbar)
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .sidebar_padding(18.0, 10.0)
        .sidebar_toggle(SidebarToggle::new().size(ControlSize::Large).past_lights(16.0).edge(18.0).gap(4.0).in_header())
        .pane_motion(PaneMotion::new().spring(Spring::new(0.3, 0.0)).scale_with_width(480.0, 0.15, 0.3).fade_tail(0.15))
        .reduced_motion(cx.is_reduced_motion())
        .build(&l.k);
    let toast = s.toast.as_ref().map(|line| ToastRegion::new().toast(Toast::new("toast", line.clone()).build(&l.k)).build(&l.k));
    rune_kit::root(split, toast)
}

fn sidebar(s: &App, l: &Look) -> El {
    let count = |n: Option<usize>| n.map(|n| n.to_string()).unwrap_or_default();
    let detail = |screen| match screen {
        Screen::Library => count(s.library.sets.data.as_ref().map(Vec::len)),
        Screen::Queue => count(s.queue.items.data.as_ref().map(|q| q.entries.len())),
        Screen::Playing => String::new(),
    };
    Screen::ALL
        .iter()
        .fold(Sidebar::new().label("Orbis").inset(0.0).row_gap(2.0), |bar, &screen| {
            bar.child(
                SidebarRow::new(screen.title())
                    .icon(screen.icon())
                    .height(32.0)
                    .detail(detail(screen))
                    .selected(s.screen == screen)
                    .on_select(move |s: &mut App, _| s.go(screen))
                    .build(&l.k)
                    .key(screen.key()),
            )
        })
        .build(&l.k)
}

fn signed_out(l: &Look) -> El {
    // The home folder shows as ~, so a screenshot names no one.
    let path = api::Server::config_path().display().to_string();
    let path = std::env::var("HOME").ok().filter(|h| !h.is_empty()).and_then(|h| path.strip_prefix(&h).map(|rest| format!("~{rest}"))).unwrap_or(path);
    col()
        .key("signed-out")
        .w_full()
        .h_full()
        .center()
        .gap(10.0)
        .px(32.0)
        .child(text("Connect to Orbis").font(l.title).color(l.fg))
        .child(text("Set ORBIS_URL and ORBIS_KEY, or write the API's address and a device key to").font(l.k.ty.ui).color(l.muted).wrap())
        .child(text(path).key("config-path").font(l.k.ty.mono).color(l.fg).wrap())
        .child(text(r#"{ "url": "https://…", "key": "…" }"#).font(l.k.ty.mono).color(l.muted).wrap())
        .child(text("Then open the app again.").font(l.k.ty.ui).color(l.muted))
}

fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let (ran, next) = timers::run(s, clock);
    if let Some(wait) = next {
        tx.wake_after(wait);
    }
    let moved = playing::poll(s, clock, tx);
    ran || moved
}

/// Space plays and pauses; Ctrl+1, 2 and 3 open the screens; Ctrl+R reloads.
fn on_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    if ev.key == Key::Text(" ".to_owned()) && !ev.mods.cmd {
        s.toggle();
        return true;
    }
    if ev.is_command('r') {
        s.go(s.screen);
        return true;
    }
    for (digit, screen) in ['1', '2', '3'].into_iter().zip(Screen::ALL) {
        if ev.is_command(digit) {
            s.go(screen);
            return true;
        }
    }
    false
}

/// The app as headless renders and the goldens start it: made-up data, nothing sent.
fn demo_app() -> App {
    let mut s = App::new();
    demo::fill(&mut s);
    s
}

fn main() {
    rune::prewarm_gpu();
    let args: Vec<String> = std::env::args().collect();
    // Online only for a plain launch or a native window. Every other flag and every scene
    // renders made-up data on a frozen clock, so a render is the same on every run.
    let headless = args.iter().skip(1).any(|a| a.starts_with("--") && a != "--native");
    if headless {
        clock::freeze();
    }
    rune::set_app_id("orbis-rune");
    let spec = AppSpec { scenes: demo::SCENES, poll: Some(poll), on_key: Some(on_key), ..AppSpec::new("Orbis", (1120.0, 760.0), App::new, view) };
    let app = rune::App::new(spec).chrome(Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true }).on_close(|s, _| s.close());
    let handle = app.handle();
    app.init(move || {
        if headless || std::env::var_os("ORBIS_RUNE_DEMO").is_some() {
            return demo_app();
        }
        let Some(server) = api::Server::from_env_or_file() else { return App { signed_out: true, ..App::new() } };
        server.connect();
        let mut s = App { service: api::Service::Live(handle), ..App::new() };
        s.reload_library();
        s.reload_queue();
        s
    })
    .run();
}
