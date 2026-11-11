//! The Person's account on this device (ADR 0020). A new device signs in one of three ways:
//! typing a Sign-in Code from a signed-in device, showing an Approval Code for a signed-in
//! device to approve, or joining the Group with its Group Passcode. The key it gets is saved in
//! the config file, readable by this user alone. Settings shows the Person's name, Share with
//! Group and Auto Download, their devices, a Sign-in Code for the next one, the playback report,
//! and Sign Out, which removes this device's key from Orbis and from the file.

mod settings;
mod signin;

use rune::TextEdit;

use crate::api::{self, Failure, MeChange, Server};
use crate::dialogs::Dialog;
use crate::load::Load;
use crate::model::{Approval, ApprovalWait, Device, Me, SignInCode, SignedIn};
use crate::playlists::focused;
use crate::{App, Screen};

pub use settings::view as settings;
pub use signin::view as sign_in;

/// How a signed-out device signs in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Method {
    #[default]
    Code,
    Approve,
    Join,
}

#[derive(Default)]
pub struct SignIn {
    pub method: Method,
    pub server: TextEdit,
    /// The server field shows: the person chose another Orbis.
    pub other_server: bool,
    pub code: TextEdit,
    pub username: TextEdit,
    pub passcode: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
    /// The Approval Request this device shows, while it waits.
    pub approval: Option<Approval>,
    /// Counts Approval Requests, so a wait for an old one stops.
    waits: u64,
}

#[derive(Default)]
pub struct State {
    pub signin: SignIn,
    pub me: Load<Me>,
    pub devices: Load<Vec<Device>>,
    /// A Sign-in Code for the Person's next device.
    pub code: Load<SignInCode>,
    pub username: TextEdit,
}

impl State {
    /// The signed-in Person's id, or nothing before `/me` lands.
    pub fn me_id(&self) -> &str {
        self.me.data.as_ref().map_or("", |m| m.id.as_str())
    }
}

/// The letters of a Sign-in Code or Group Passcode in `text`: a link's fragment when it is a link,
/// in capitals, only the alphabet's letters (no 0, O, 1, I or L), at most `len`.
pub fn code_letters(text: &str, len: usize) -> String {
    const ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let text = text.trim();
    let text = text.split_once('#').filter(|_| text.contains("://")).map_or(text, |(_, fragment)| fragment);
    text.to_uppercase().chars().filter(|c| ALPHABET.contains(*c)).take(len).collect()
}

impl App {
    /// The address the sign-in screen signs in to.
    fn sign_in_url(&self) -> String {
        let typed = self.account.signin.server.text.trim().trim_end_matches('/');
        if typed.is_empty() { api::DEFAULT_URL.to_owned() } else { typed.to_owned() }
    }

    /// Picks how to sign in. Approve starts a request at once, so its code shows.
    pub fn sign_in_by(&mut self, method: Method) {
        let si = &mut self.account.signin;
        si.method = method;
        // A request still out for the method left behind no longer holds the form.
        (si.error, si.busy) = (None, false);
        si.waits += 1;
        si.approval = None;
        if method == Method::Approve {
            self.start_approval();
        }
    }

    /// Signs in with the typed Sign-in Code.
    pub fn redeem_code(&mut self) {
        let code = code_letters(&self.account.signin.code.text, 8);
        if code.len() < 8 {
            self.account.signin.error = Some("A Sign-in Code has 8 letters and digits".to_owned());
            return;
        }
        let url = self.sign_in_url();
        self.signing_in(move |url| api::redeem(url, &code), url);
    }

    /// Joins the Group as a new Person.
    pub fn join_group(&mut self) {
        let si = &self.account.signin;
        let (username, passcode) = (si.username.text.trim().to_owned(), code_letters(&si.passcode.text, 12));
        if username.is_empty() {
            self.account.signin.error = Some("Choose a name the Group sees".to_owned());
            return;
        }
        if passcode.len() < 12 {
            self.account.signin.error = Some("A Group Passcode has 12 letters and digits. Ask the Group's Host for it.".to_owned());
            return;
        }
        let url = self.sign_in_url();
        self.signing_in(move |url| api::join(url, &username, &passcode), url);
    }

    fn signing_in(&mut self, call: impl FnOnce(&str) -> Result<SignedIn, Failure> + Send + 'static, url: String) {
        let si = &mut self.account.signin;
        if si.busy {
            return;
        }
        (si.busy, si.error) = (true, None);
        self.spawn(
            move || call(&url).map(|signed| (url, signed)),
            |s, got| {
                s.account.signin.busy = false;
                match got {
                    Ok((url, signed)) => s.signed_in(url, signed),
                    Err(failure) => s.account.signin.error = Some(sign_in_words(&failure)),
                }
            },
        );
    }

    /// Starts an Approval Request and waits for a signed-in device to approve it.
    pub fn start_approval(&mut self) {
        let url = self.sign_in_url();
        let si = &mut self.account.signin;
        si.waits += 1;
        let waits = si.waits;
        (si.busy, si.error) = (true, None);
        self.spawn(
            move || api::start_approval(&url).map(|a| (url, a)),
            move |s, got| {
                let si = &mut s.account.signin;
                if si.waits != waits {
                    return;
                }
                si.busy = false;
                match got {
                    Ok((url, approval)) => {
                        let secret = approval.secret.clone();
                        si.approval = Some(approval);
                        s.wait_approval(url, secret, waits);
                    }
                    Err(failure) => si.error = Some(sign_in_words(&failure)),
                }
            },
        );
    }

    fn wait_approval(&mut self, url: String, secret: String, waits: u64) {
        self.spawn(
            move || (api::wait_approval(&url, &secret), url, secret),
            move |s, (got, url, secret)| {
                if s.account.signin.waits != waits || !s.signed_out {
                    return;
                }
                match got {
                    Ok(ApprovalWait::Pending) => s.wait_approval(url, secret, waits),
                    Ok(ApprovalWait::Approved { key, person }) => s.signed_in(url, SignedIn { key, person }),
                    // Expired: show a new code, as the Apple TV does.
                    Err(f) if f.status == Some(404) => s.start_approval(),
                    Err(f) => {
                        s.account.signin.error = Some(sign_in_words(&f));
                        s.account.signin.approval = None;
                    }
                }
            },
        );
    }

    /// A key came back: save it, and open the Library.
    fn signed_in(&mut self, url: String, signed: SignedIn) {
        let server = Server { url, key: signed.key };
        if let Err(why) = server.save() {
            self.say(why);
        }
        server.connect();
        self.session += 1;
        self.signed_out = false;
        self.account.signin = SignIn::default();
        self.say(format!("Signed in as {}", signed.person.username));
        self.go_live();
    }

    /// Loads everything a signed-in window shows, and opens the event stream.
    pub fn go_live(&mut self) {
        self.screen = Screen::Library;
        self.reload_library();
        self.reload_queue();
        self.reload_playlists();
        self.reload_me();
        self.listen();
    }

    pub fn reload_me(&mut self) {
        self.account.me.begin();
        self.spawn(api::me, |s, got| {
            s.account.me.land(got);
            if let Some(me) = &s.account.me.data {
                s.account.username = TextEdit::new(me.username.clone());
            }
        });
    }

    /// Opens Settings and loads the devices.
    pub fn open_settings(&mut self) {
        self.screen = Screen::Settings;
        self.reload_me();
        self.account.devices.begin();
        self.spawn(api::devices, |s, got| drop(s.account.devices.land(got)));
    }

    /// Changes one of the Person's settings here at once, then on Orbis.
    pub fn change_me(&mut self, change: MeChange) {
        if let Some(me) = self.account.me.data.as_mut() {
            match &change {
                MeChange::AutoDownload(on) => me.auto_download = *on,
                MeChange::Social(on) => me.social = *on,
                MeChange::Username(name) => me.username = name.trim().to_owned(),
            }
        }
        self.spawn(
            move || api::update_me(&change),
            |s, got| match got {
                Ok(me) => {
                    s.account.username = TextEdit::new(me.username.clone());
                    s.account.me.data = Some(me);
                }
                Err(why) => {
                    s.say(format!("Not saved: {why}"));
                    s.reload_me();
                }
            },
        );
    }

    /// Saves the typed name, when it changed.
    pub fn save_username(&mut self) {
        let name = self.account.username.text.trim().to_owned();
        let same = self.account.me.data.as_ref().is_some_and(|m| m.username == name);
        if !name.is_empty() && !same {
            self.change_me(MeChange::Username(name));
        }
    }

    /// Signs another device out.
    pub fn revoke_device(&mut self, id: &str) {
        if let Some(list) = self.account.devices.data.as_mut() {
            list.retain(|d| d.id != id);
        }
        let id = id.to_owned();
        self.spawn(
            move || api::revoke_device(&id),
            |s, got| match got {
                Ok(gone) => s.say(format!("Signed out {}", gone.label)),
                Err(why) => {
                    s.say(format!("Not signed out: {why}"));
                    s.open_settings();
                }
            },
        );
    }

    /// A Sign-in Code for the Person's next device.
    pub fn new_sign_in_code(&mut self) {
        self.account.code.begin();
        self.spawn(api::sign_in_code, |s, got| {
            if let Some(why) = s.account.code.land(got) {
                s.say(format!("No code: {why}"));
            }
        });
    }

    /// Asks for the Approval Code another device shows.
    pub fn approve_device(&mut self) {
        self.dialog = Some(Dialog::Approve { edit: focused(""), busy: false, error: None });
    }

    pub fn approve_now(&mut self) {
        let Some(Dialog::Approve { edit, busy, error }) = self.dialog.as_mut() else { return };
        let code: String = edit.text.chars().filter(char::is_ascii_digit).collect();
        if code.is_empty() || *busy {
            return;
        }
        (*busy, *error) = (true, None);
        self.spawn(
            move || api::approve(&code),
            |s, got| match got {
                Ok(()) => {
                    s.dialog = None;
                    s.say("Approved. That device is signing in.".to_owned());
                    s.open_settings();
                }
                Err(why) => s.dialog_failed(why),
            },
        );
    }

    /// Signs this device out: Orbis forgets its key, and so does the config file.
    pub fn sign_out(&mut self) {
        self.dialog = None;
        self.spawn(
            || {
                let current = api::devices()?.into_iter().find(|d| d.current);
                if let Some(device) = current {
                    api::revoke_device(&device.id)?;
                }
                Ok::<_, String>(())
            },
            |s, got| {
                if let Err(why) = got {
                    s.say(format!("Orbis didn't hear the sign-out ({why}); this device forgot its key anyway."));
                }
                s.forget_account();
            },
        );
        if !self.online() {
            self.forget_account();
        }
    }

    pub(crate) fn forget_account(&mut self) {
        api::events::stop();
        Server::forget();
        self.close();
        let service = std::mem::take(&mut self.service);
        let (artwork, mut diagnostics) = (std::mem::take(&mut self.artwork), std::mem::take(&mut self.diagnostics));
        diagnostics.new_account();
        let mut artwork = artwork;
        artwork.new_session();
        let session = self.session + 1;
        *self = App { service, artwork, diagnostics, session, signed_out: true, ..App::new() };
    }
}

/// Words for a refused sign-in.
fn sign_in_words(f: &Failure) -> String {
    match f.status {
        Some(404) => "That code didn't work: it may have expired. Make a new one on your other device.".to_owned(),
        Some(403) => "Orbis didn't accept that Group Passcode. Joining may be closed; ask the Group's Host.".to_owned(),
        Some(409) => "Someone in the Group already has that name. Choose another.".to_owned(),
        Some(429) => "Too many tries. Wait a minute, then try again.".to_owned(),
        _ => f.message.clone(),
    }
}
