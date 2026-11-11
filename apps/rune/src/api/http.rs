//! The live calls over HTTP. Tests never build this: they answer from [`super::fixture`].

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use super::{As, Failure, Server};

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(40)).timeout_write(Duration::from_secs(20)).build())
}

pub(super) fn send(who: As, url: Option<&str>, method: &str, path: &str, body: Option<Value>) -> Result<Value, Failure> {
    let server = Server::current();
    let base = match (url, &server) {
        (Some(url), _) => url.to_owned(),
        (None, Some(server)) => server.url.clone(),
        (None, None) => return Err(Failure::new(None, "Not signed in")),
    };
    let mut call = agent().request(method, &format!("{base}{path}"));
    if who == As::Device {
        let Some(server) = server else { return Err(Failure::new(None, "Not signed in")) };
        call = call.set("Authorization", &format!("Bearer {}", server.key));
    }
    let answer = match body {
        Some(body) => call.send_json(body),
        None => call.call(),
    };
    match answer {
        Ok(reply) => reply.into_json().map_err(|_| Failure::new(None, "Orbis sent a reply this app couldn't read")),
        Err(ureq::Error::Status(status, reply)) => {
            let message = reply.into_json::<Value>().ok().and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned));
            Err(Failure::new(Some(status), words(status, message, who)))
        }
        Err(ureq::Error::Transport(_)) => Err(Failure::new(None, format!("Couldn't reach Orbis at {base}"))),
    }
}

/// Words for a refused call: what happened, and what to do when there is something.
fn words(status: u16, message: Option<String>, who: As) -> String {
    match (status, message) {
        (401 | 403, _) if who == As::Device => "Orbis didn't accept this device's key. Sign in again in Settings.".to_owned(),
        (429, _) => "Orbis is busy. Try again in a minute.".to_owned(),
        (_, Some(message)) => message,
        (404, None) => "Orbis has no such thing any more".to_owned(),
        (_, None) => format!("Orbis answered {status}"),
    }
}

/// Opens `path` as a stream with the device key, for Server-Sent Events. Its reads wait up to
/// `quiet` for the next bytes.
pub fn stream(path: &str, quiet: Duration) -> Result<Box<dyn std::io::Read + Send>, Failure> {
    let Some(server) = Server::current() else { return Err(Failure::new(None, "Not signed in")) };
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(quiet).build();
    let call = agent.get(&format!("{}{path}", server.url)).set("Authorization", &format!("Bearer {}", server.key)).set("Accept", "text/event-stream");
    match call.call() {
        Ok(reply) => Ok(Box::new(reply.into_reader())),
        Err(ureq::Error::Status(status, _)) => Err(Failure::new(Some(status), words(status, None, As::Device))),
        Err(ureq::Error::Transport(_)) => Err(Failure::new(None, format!("Couldn't reach Orbis at {}", server.url))),
    }
}

/// The bytes at `url`, with no key: a Set's Artwork from its provider. At most `limit` bytes.
pub fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let reply = agent().get(url).call().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    reply.into_reader().take(limit).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
