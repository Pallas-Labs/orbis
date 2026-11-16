//! The app's wall clock and time zone. Headless renders freeze the clock at one instant in UTC
//! ([`freeze`]), and a test freezes it on its own thread ([`freeze_here`]), so a scene that says
//! "2 min ago" or "Friday" says the same on every run and in every time zone. Read time only
//! through [`now`], and the zone only through [`zone`].

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The instant a frozen clock shows: Friday 15 January 2027, 08:00 UTC.
pub const FROZEN_AT: f64 = 1_800_000_000.0;

static FROZEN: OnceLock<f64> = OnceLock::new();

thread_local! {
    /// A test's frozen clock, on its thread alone: tests run side by side.
    static FROZEN_HERE: Cell<Option<f64>> = const { Cell::new(None) };
    /// A test's time zone, on its thread alone. A test never reads the host's.
    static ZONE_HERE: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Stops the clock at [`FROZEN_AT`] for the rest of the process. Call it before the first [`now`].
pub fn freeze() {
    FROZEN.get_or_init(|| FROZEN_AT);
}

/// Stops the clock at [`FROZEN_AT`] on this thread alone.
#[cfg(test)]
pub fn freeze_here() {
    FROZEN_HERE.set(Some(FROZEN_AT));
}

/// Seconds since 1970, UTC.
#[allow(dead_code)] // Remove once the app shows a time.
pub fn now() -> f64 {
    let frozen = FROZEN_HERE.get().or_else(|| FROZEN.get().copied());
    frozen.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()))
}

/// The system's IANA time zone, such as `Europe/Berlin`, found once; `None` when the system names
/// none, such as a POSIX `TZ` like `UTC+2`. A test sees only the zone it set with [`zone_here`].
pub fn zone() -> Option<String> {
    #[cfg(test)]
    return ZONE_HERE.with_borrow(Clone::clone);
    #[cfg(not(test))]
    {
        static ZONE: OnceLock<Option<String>> = OnceLock::new();
        ZONE.get_or_init(system_zone).clone()
    }
}

/// Sets the zone [`zone`] gives on this thread alone.
#[cfg(test)]
pub fn zone_here(name: Option<&str>) {
    ZONE_HERE.set(name.map(str::to_owned));
}

/// `$TZ` when it is set, else where `/etc/localtime` links.
fn system_zone() -> Option<String> {
    let tz = std::env::var("TZ").ok();
    let link = std::fs::read_link("/etc/localtime").ok();
    iana(tz.as_deref(), link.as_deref())
}

/// The IANA name in `tz`, else in `localtime` (the target of `/etc/localtime`). A set `tz` wins
/// even when it names no IANA zone: the system then keeps time in that rule, not in the link's.
fn iana(tz: Option<&str>, localtime: Option<&Path>) -> Option<String> {
    let name = match tz {
        Some(tz) => tz.strip_prefix(':').unwrap_or(tz).to_owned(),
        None => localtime?.to_str()?.to_owned(),
    };
    // A path names the zone after its last `zoneinfo/`, past a `posix/` or `right/` copy.
    let name = name.rsplit_once("zoneinfo/").map_or(name.as_str(), |(_, after)| after);
    let name = name.strip_prefix("posix/").or_else(|| name.strip_prefix("right/")).unwrap_or(name);
    is_iana(name).then(|| name.to_owned())
}

/// Whether `name` reads as an IANA zone the service keeps: `Area/Location` (or `UTC`), at most 64
/// characters, each part starting with a capital. Rules such as `UTC+2` or `EST5EDT` are not.
fn is_iana(name: &str) -> bool {
    let part = |p: &str| p.starts_with(|c: char| c.is_ascii_uppercase()) && p.chars().all(|c| c.is_ascii_alphanumeric() || "_-+".contains(c));
    name.len() <= 64 && (name == "UTC" || (name.contains('/') && name.split('/').all(part)))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{iana, is_iana, system_zone};

    #[test]
    fn a_tz_with_an_iana_name_gives_that_name() {
        assert_eq!(iana(Some("Europe/Berlin"), None).as_deref(), Some("Europe/Berlin"));
        assert_eq!(iana(Some(":America/New_York"), None).as_deref(), Some("America/New_York"), "glibc's leading colon");
        assert_eq!(iana(Some("/usr/share/zoneinfo/Asia/Tokyo"), None).as_deref(), Some("Asia/Tokyo"), "a path to the zone file");
        assert_eq!(iana(Some("UTC"), None).as_deref(), Some("UTC"));
        assert_eq!(iana(Some("Etc/GMT+2"), None).as_deref(), Some("Etc/GMT+2"));
        assert_eq!(iana(Some("America/Argentina/Buenos_Aires"), None).as_deref(), Some("America/Argentina/Buenos_Aires"));
    }

    #[test]
    fn a_tz_with_no_iana_name_gives_none_and_hides_the_link() {
        let link = Some(Path::new("/usr/share/zoneinfo/Europe/Paris"));
        for tz in ["UTC+2", "EST5EDT", "CET-1CEST,M3.5.0,M10.5.0/3", "", ":", "utc", "Europe/../etc"] {
            assert_eq!(iana(Some(tz), link), None, "TZ={tz:?}");
        }
    }

    #[test]
    fn with_no_tz_the_localtime_link_names_the_zone() {
        let found = |target: &str| iana(None, Some(Path::new(target)));
        assert_eq!(found("/usr/share/zoneinfo/America/Los_Angeles").as_deref(), Some("America/Los_Angeles"), "Linux");
        assert_eq!(found("/var/db/timezone/zoneinfo/Australia/Sydney").as_deref(), Some("Australia/Sydney"), "macOS");
        assert_eq!(found("../usr/share/zoneinfo/Europe/Paris").as_deref(), Some("Europe/Paris"), "a relative link");
        assert_eq!(found("/usr/share/zoneinfo/posix/Europe/Oslo").as_deref(), Some("Europe/Oslo"));
        assert_eq!(found("/usr/share/zoneinfo/right/Europe/Oslo").as_deref(), Some("Europe/Oslo"));
        assert_eq!(found("/etc/zone-of-my-own"), None, "a link outside zoneinfo");
        assert_eq!(iana(None, None), None, "no link: a plain file or no /etc/localtime");
    }

    #[test]
    fn a_name_longer_than_the_service_keeps_gives_none() {
        let long = format!("Area/{}", "L".repeat(60));
        assert!(!is_iana(&long));
        assert_eq!(iana(Some(&long), None), None);
    }

    #[test]
    fn this_host_gives_an_iana_name_or_none() {
        // Whatever this host has, Rune never sends an offset or an empty string.
        if let Some(name) = system_zone() {
            assert!(is_iana(&name), "{name:?}");
        }
    }
}
