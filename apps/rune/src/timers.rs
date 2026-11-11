//! Things the app does later: a toast leaving, an Undo running out, a poll's next turn.
//! `App::after` keeps each one in the app on Rune's clock, and `poll` runs it when it is due
//! and asks Rune to wake the window for the next. Nothing sleeps on a thread, so headless
//! renders and tests run them as the real app does.

use std::time::Duration;

use crate::App;

type Later = Box<dyn FnOnce(&mut App)>;

#[derive(Default)]
pub struct Timers {
    /// Rune's clock at the last `poll`, in seconds.
    now: f64,
    due: Vec<(f64, Later)>,
}

impl Timers {
    /// Rune's clock at the last `poll`, in seconds.
    pub fn now(&self) -> f64 {
        self.now
    }
}

impl App {
    /// Runs `then` once `wait` has passed.
    pub fn after(&mut self, wait: Duration, then: impl FnOnce(&mut App) + 'static) {
        let at = self.timers.now + wait.as_secs_f64();
        self.timers.due.push((at, Box::new(then)));
    }
}

/// Runs, earliest first, everything due at `clock`, and what that adds which is due too.
/// Returns whether anything ran, and how long until the next one.
pub fn run(s: &mut App, clock: f64) -> (bool, Option<Duration>) {
    s.timers.now = clock;
    let mut ran = false;
    while let Some(i) = s.timers.due.iter().enumerate().filter(|(_, (at, _))| *at <= clock).min_by(|a, b| a.1.0.total_cmp(&b.1.0)).map(|(i, _)| i) {
        let (_, then) = s.timers.due.remove(i);
        then(s);
        ran = true;
    }
    let next = s.timers.due.iter().map(|(at, _)| *at).min_by(f64::total_cmp).map(|at| Duration::from_secs_f64((at - clock).max(0.0)));
    (ran, next)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::App;

    #[test]
    fn a_toast_leaves_after_four_seconds() {
        let mut s = App::default();
        super::run(&mut s, 10.0);
        s.say("Saved".to_owned());
        let (ran, next) = super::run(&mut s, 13.9);
        assert!(!ran && s.toast.is_some());
        assert!(next.is_some_and(|d| d < Duration::from_millis(101)), "{next:?}");
        assert!(super::run(&mut s, 14.0).0);
        assert!(s.toast.is_none());
    }
}
