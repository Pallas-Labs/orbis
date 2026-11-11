//! What the person chose to play, told to Orbis in the order they chose it. The player plays a
//! choice at once; Orbis hears one choice at a time (`PUT /queue/active` for a Set,
//! `PUT /queue/playlist` for a Playlist), so its queue ends on the newest choice too. A choice
//! replaced before its turn is never sent.

use crate::App;
use crate::api;

/// A choice that changes what plays.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    Set(String),
    Playlist { id: String, shuffled: bool },
}

/// A choice waiting its turn, with the intent and generation it was made under.
#[derive(Debug)]
pub struct Waiting {
    choice: Choice,
    intent: u64,
    generation: u64,
}

#[derive(Debug, Default)]
pub struct Lane {
    /// A choice is out to Orbis.
    busy: bool,
    /// The newest choice not sent yet.
    next: Option<Waiting>,
}

impl App {
    /// Tells Orbis about `choice` in its turn. `generation` is the Set the player started for it
    /// (unused for a Playlist, whose first Set Orbis names).
    pub(super) fn choose(&mut self, choice: Choice, intent: u64, generation: u64) {
        let waiting = Waiting { choice, intent, generation };
        if self.playing.lane.busy {
            // The choice it replaces is never sent: Orbis never made that Set active, so a
            // completion held for it means nothing to Orbis.
            if let Some(Waiting { choice: Choice::Set(dropped), .. }) = self.playing.lane.next.replace(waiting)
                && self.playing.held.as_ref().is_some_and(|(id, _)| *id == dropped)
            {
                self.playing.held = None;
            }
            return;
        }
        self.send_choice(waiting);
    }

    fn send_choice(&mut self, Waiting { choice, intent, generation }: Waiting) {
        self.playing.lane.busy = true;
        match choice {
            Choice::Set(id) => {
                let asked = id.clone();
                self.spawn(
                    move || api::play(&id),
                    move |s, got| {
                        s.playing.lane.busy = false;
                        match got {
                            // A completion waiting on this activation goes out now, whatever it
                            // answered.
                            _ if s.release_completion(&asked) => {}
                            // The person chose something else since: its own answer brings the
                            // queue.
                            _ if s.playing.intent != intent => {}
                            Ok(queue) => {
                                s.queue.items.land(Ok(queue));
                                s.playing.activated = s.playing.generation == generation;
                                s.presence_retry();
                            }
                            Err(why) => s.fail(generation, why),
                        }
                        s.next_choice();
                    },
                );
            }
            Choice::Playlist { id, shuffled } => self.spawn(
                move || api::play_playlist(&id, shuffled),
                move |s, got| {
                    s.playing.lane.busy = false;
                    match got {
                        _ if s.playing.intent != intent => {}
                        Ok(queue) => {
                            let first = queue.active().cloned();
                            s.queue.items.land(Ok(queue));
                            match first {
                                Some(set) => s.start_set(set),
                                None => s.say("Nothing in this Playlist can play yet".to_owned()),
                            }
                        }
                        Err(why) => s.say(format!("Couldn't play the Playlist: {why}")),
                    }
                    s.next_choice();
                },
            ),
        }
    }

    fn next_choice(&mut self) {
        if let Some(waiting) = self.playing.lane.next.take() {
            self.send_choice(waiting);
        }
    }
}
