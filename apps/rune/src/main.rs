//! Orbis on the desktop: the person's Library, Playlists, Listening Queue and Now Playing, and
//! their account, against the Orbis API. It plays a Set's Retained Audio through mpv, keeps the
//! place in it, moves through the queue as each Set ends, tells the Group what it plays, and
//! follows Orbis's live events so changes from other devices show at once.
//!
//! `cargo run` opens the window, online: with `ORBIS_URL` and `ORBIS_KEY`, the saved key, or the
//! sign-in page. `cargo run -- --snap out.png --scene library --at 1.5` renders a scene headless,
//! on made-up data and a frozen clock.

mod account;
mod api;
mod artwork;
mod audio;
mod clock;
mod demo;
mod diagnostics;
mod dialogs;
#[cfg(test)]
mod goldens;
mod library;
mod load;
mod model;
mod playing;
mod playlists;
mod queue;
mod rows;
mod shell;
#[cfg(test)]
mod tests;
mod theme;
mod timers;

use std::time::Duration;

use rune::{AppSpec, Chrome, KeyEvent, TextEdit, Tx, Waker};
use rune_kit::shell::PaneState;

/// The screens. The sidebar lists them, and the Playlists under them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    Library,
    /// One Playlist's page, by id.
    Playlist(String),
    Queue,
    Playing,
    Settings,
}

/// Everything the app knows. The view draws it; handlers, landings and `poll` change it.
#[derive(Default)]
pub struct App {
    /// Where work goes: the live service, made-up data, or a test's stand-in.
    pub service: api::Service,
    pub timers: timers::Timers,
    pub screen: Screen,
    pub sidebar: PaneState,
    /// No key: the window shows the sign-in page.
    pub signed_out: bool,
    pub account: account::State,
    pub library: library::State,
    pub playlists: playlists::State,
    pub queue: queue::State,
    pub playing: playing::State,
    pub presence: playing::presence::State,
    pub diagnostics: diagnostics::State,
    pub artwork: artwork::Artwork,
    /// The open dialog, and the Set or Playlist menu.
    pub dialog: Option<dialogs::Dialog>,
    pub menu: Option<rows::SetMenu>,
    pub playlist_menu: bool,
    /// Where a field's late edits land once its dialog closed.
    pub spare_edit: TextEdit,
    /// Counts sign-ins and sign-outs. A call's answer lands only in the session that made it,
    /// so one account's late answer never reaches the next.
    pub session: u64,
    /// The event stream dropped, so what it carries is reloaded when it comes back.
    pub live_lost: bool,
    /// A short line that leaves on its own.
    pub toast: Option<String>,
}

impl App {
    fn new() -> App {
        App { sidebar: PaneState::new(240.0).range(160.0, 400.0), ..App::default() }
    }

    /// Opens `screen`, and reloads what it shows.
    pub fn go(&mut self, screen: Screen) {
        self.menu = None;
        match screen.clone() {
            Screen::Library => self.reload_library(),
            Screen::Playlist(id) => return self.open_playlist(&id),
            Screen::Queue => self.reload_queue(),
            Screen::Playing => {}
            Screen::Settings => return self.open_settings(),
        }
        self.screen = screen;
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

    /// Starts reading Orbis's live events, for a live, signed-in window.
    fn listen(&mut self) {
        #[cfg(not(test))]
        if let api::Service::Live(handle) = &self.service {
            let handle = handle.clone();
            api::events::start(move |event| handle.update(move |s: &mut App, _| s.heard_live(event)));
        }
    }

    /// One live event from Orbis.
    pub fn heard_live(&mut self, event: api::events::Event) {
        use api::events::{Event, Topic};
        match event {
            Event::Queue { queue } => {
                if self.queue.items.data.as_ref() != Some(&queue) {
                    self.queue.items.land(Ok(queue));
                    self.queue_landed();
                }
                self.presence_retry();
            }
            Event::Presence { presence } => {
                let me = self.account.me_id().to_owned();
                self.presence.listening = presence.into_iter().filter(|p| p.person_id != me).collect();
                let urls: Vec<String> = self.presence.listening.iter().filter_map(|p| p.set.artwork_url.clone()).collect();
                self.want_artwork(urls.iter().map(String::as_str));
            }
            Event::Changed { topic: Topic::Library | Topic::Set } => self.reload_library(),
            Event::Changed { topic: Topic::Playlist } => {
                self.reload_playlists();
                self.reload_playlist();
            }
            Event::PlaylistImport { import } if import["state"]["kind"] != "running" => self.reload_playlists(),
            Event::Connected(true) if self.live_lost => {
                self.live_lost = false;
                self.reload_library();
                self.reload_queue();
                self.reload_playlists();
                self.reload_playlist();
            }
            Event::Connected(false) => self.live_lost = true,
            Event::Changed { topic: Topic::ListenHistory } | Event::PlaylistImport { .. } | Event::Heartbeat | Event::Connected(true) => {}
        }
    }
}

fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let (ran, next) = timers::run(s, clock);
    if let Some(wait) = next {
        tx.wake_after(wait);
    }
    let moved = playing::poll(s, clock, tx);
    let pictures = s.artwork.poll();
    ran || moved || pictures
}

/// Space plays and pauses; Ctrl+1 to 4 open the screens; Ctrl+N saves a link; Ctrl+R reloads;
/// Ctrl+, opens Settings.
fn on_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    if s.signed_out {
        return false;
    }
    if rune_kit::shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    if ev.key == rune::Key::Text(" ".to_owned()) && !ev.mods.cmd {
        s.toggle();
        return true;
    }
    if ev.is_command('r') {
        s.go(s.screen.clone());
        return true;
    }
    if ev.is_command('n') {
        s.save_link();
        return true;
    }
    if ev.is_command(',') {
        s.go(Screen::Settings);
        return true;
    }
    for (digit, screen) in ['1', '2', '3', '4'].into_iter().zip([Screen::Library, Screen::Queue, Screen::Playing, Screen::Settings]) {
        if ev.is_command(digit) {
            s.go(screen);
            return true;
        }
    }
    false
}

/// Once, with the window's waker: the Artwork cache starts, and the demo draws its made-up
/// Artwork.
fn setup(s: &mut App, waker: Waker) {
    s.artwork.start(waker);
    if !s.online() {
        demo::artwork(s);
    }
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
    let spec = AppSpec { scenes: demo::SCENES, poll: Some(poll), on_key: Some(on_key), setup: Some(setup), ..AppSpec::new("Orbis", (1180.0, 780.0), App::new, shell::view) };
    let app = rune::App::new(spec).chrome(Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true }).on_close(|s, _| s.close());
    let handle = app.handle();
    app.init(move || {
        if headless || std::env::var_os("ORBIS_RUNE_DEMO").is_some() {
            return demo_app();
        }
        let mut s = App { service: api::Service::Live(handle), ..App::new() };
        match api::Server::from_env_or_file() {
            Some(server) => {
                server.connect();
                s.go_live();
            }
            None => s.signed_out = true,
        }
        s
    })
    .run();
}
