//! Sound. A live app plays a Set's stream through mpv, which reads Ogg Opus and every other
//! format Retained Audio comes in; Rune's own `Player` has no Linux backend yet. One thread per
//! stream owns the mpv process and its JSON IPC socket, and hands what mpv reports to the app as
//! [`Event`]s. Commands go to it over a channel, so the UI thread never waits on mpv.
//!
//! Headless renders, the demo and tests make no sound: `playing` moves their position on
//! Rune's clock instead.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// What the player reports.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The place in the stream, in seconds, at most once a whole second.
    Time(f64),
    Paused(bool),
    Duration(f64),
    /// The stream played to its end.
    Ended,
    /// It can't play, in words for the person.
    Failed(String),
}

enum Order {
    Pause(bool),
    Seek(f64),
}

/// One stream playing in mpv. Dropping it stops the sound and ends the process.
pub struct Mpv {
    commands: Sender<Order>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Mpv {
    /// Starts `url` at `start` seconds. `report` runs on mpv's thread for
    /// each [`Event`].
    pub fn open(url: String, start: f64, report: impl Fn(Event) + Send + 'static) -> Mpv {
        let (commands, inbox) = channel();
        let child = Arc::new(Mutex::new(None));
        let owner = Arc::clone(&child);
        std::thread::spawn(move || {
            if let Err(why) = run(&url, start, &owner, inbox, &report) {
                report(Event::Failed(why));
            }
        });
        Mpv { commands, child }
    }

    pub fn pause(&self, paused: bool) {
        let _ = self.commands.send(Order::Pause(paused));
    }

    pub fn seek(&self, seconds: f64) {
        let _ = self.commands.send(Order::Seek(seconds));
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let _ = child.kill();
            // Reaping it can take a moment; the UI thread doesn't wait for that.
            std::thread::spawn(move || child.wait());
        }
    }
}

fn socket_path() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
    dir.join(format!("orbis-rune-{}-{}.sock", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// Runs one stream to its end: starts mpv, connects to its socket, sends it commands from
/// `inbox` and reports what it says.
fn run(url: &str, start: f64, child: &Mutex<Option<Child>>, inbox: Receiver<Order>, report: &dyn Fn(Event)) -> Result<(), String> {
    let socket = socket_path();
    let mut mpv = Command::new("mpv");
    mpv.args(["--no-config", "--no-video", "--no-terminal", "--idle=no", "--audio-display=no"])
        .arg(format!("--input-ipc-server={}", socket.display()))
        .arg(format!("--start={start:.1}"))
        .arg("--")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    die_with_parent(&mut mpv);
    let process = mpv.spawn().map_err(|_| "Playing needs mpv, and this computer doesn't have it. Install mpv, then press Play again.".to_owned())?;
    *child.lock().map_err(|_| "The player stopped".to_owned())? = Some(process);

    let deadline = Instant::now() + Duration::from_secs(5);
    let stream = loop {
        match UnixStream::connect(&socket) {
            Ok(stream) => break stream,
            Err(_) if Instant::now() < deadline && child.lock().is_ok_and(|c| c.is_some()) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return Err("mpv didn't start".to_owned()),
        }
    };
    let _ = std::fs::remove_file(&socket);
    let mut writer = stream.try_clone().map_err(|_| "The player stopped".to_owned())?;
    for (id, name) in [(1, "time-pos"), (2, "pause"), (3, "duration")] {
        send(&mut writer, json!(["observe_property", id, name]));
    }
    std::thread::spawn(move || {
        for command in inbox {
            let line = match command {
                Order::Pause(paused) => json!(["set_property", "pause", paused]),
                Order::Seek(seconds) => json!(["seek", seconds, "absolute"]),
            };
            if !send(&mut writer, line) {
                break;
            }
        }
    });

    let mut last_second = f64::NAN;
    let mut finished = false;
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        match (message["event"].as_str(), message["name"].as_str()) {
            (Some("property-change"), Some("time-pos")) => {
                if let Some(t) = message["data"].as_f64().filter(|t| t.floor() != last_second) {
                    last_second = t.floor();
                    report(Event::Time(t));
                }
            }
            (Some("property-change"), Some("pause")) => report(Event::Paused(message["data"].as_bool().unwrap_or(false))),
            (Some("property-change"), Some("duration")) => {
                if let Some(d) = message["data"].as_f64() {
                    report(Event::Duration(d));
                }
            }
            (Some("end-file"), _) => {
                finished = true;
                match message["reason"].as_str() {
                    Some("eof") => report(Event::Ended),
                    Some("error") => report(Event::Failed("The stream wouldn't play. Try again in a minute.".to_owned())),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // The socket closed: mpv quit. When it wasn't asked to, and said nothing first, say so.
    let asked = child.lock().map_or(true, |c| c.is_none());
    if !asked && !finished {
        report(Event::Failed("The player stopped".to_owned()));
    }
    Ok(())
}

fn send(writer: &mut UnixStream, command: Value) -> bool {
    writeln!(writer, "{}", json!({ "command": command })).is_ok()
}

/// mpv ends when the app does, even when the app is killed.
#[cfg(target_os = "linux")]
fn die_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl is async-signal-safe and touches only the child's own attributes.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_parent(_: &mut Command) {}
