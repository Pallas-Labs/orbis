//! The write queue: position saves and completions go to Orbis one at a time, in the order the
//! player made them, and a save that got no answer goes again.

use std::time::Duration;

use super::{SAVE_EVERY, Status, Write};
use crate::App;
use crate::api;

impl App {
    pub(super) fn write(&mut self, write: Write) {
        self.playing.writes.push_back(write);
        self.next_write();
    }

    /// Sends the oldest waiting write, when none is out.
    pub(super) fn next_write(&mut self) {
        if self.playing.writing {
            return;
        }
        let Some(write) = self.playing.writes.pop_front() else { return };
        self.playing.writing = true;
        match write {
            Write::Save(id, seconds) => self.spawn(
                move || (api::save_position(&id, seconds), id),
                |s, (got, id)| {
                    s.playing.writing = false;
                    match got {
                        Ok(set) => s.replace_set(&set),
                        Err(f) if may_outlast(&f) => s.resend_place(id),
                        Err(_) => {}
                    }
                    s.next_write();
                },
            ),
            Write::Complete(id, generation) => self.send_completion(id, generation),
        }
    }

    /// A save of `id`'s place got no answer, a 429 or a 5xx. It may have landed or not, and either
    /// way the place Orbis holds is unknown here: a pause would not reach the other device, or a
    /// resume here would skip that device's next pause (PAL-3192, `apps/server/models/README.md`
    /// finding 2). After [`SAVE_EVERY`], while `id` is still loaded and not playing, its place then
    /// goes again through the write queue, so it never lands after a newer write. A newer failure
    /// takes over the wait. A playing Set saves on its own tick. Nothing goes after sign-out.
    fn resend_place(&mut self, id: String) {
        self.playing.resends += 1;
        let (session, resend) = (self.session, self.playing.resends);
        self.after(Duration::from_secs_f64(SAVE_EVERY), move |s| {
            let p = &mut s.playing;
            let loaded = p.set.as_ref().is_some_and(|x| x.id == id);
            if s.session != session || p.resends != resend || !loaded || matches!(p.status, Status::Playing | Status::Idle | Status::Loading) {
                return;
            }
            p.saved = p.position;
            let seconds = p.position;
            s.write(Write::Save(id, seconds));
        });
    }
}

/// Whether a write that failed this way may still land, or land if sent again: no answer, a 429
/// or a 5xx. A 4xx says sending it again cannot help.
pub(super) fn may_outlast(f: &api::Failure) -> bool {
    f.status.is_none_or(|status| status == 429 || status >= 500)
}
