import type { PresenceAction } from "@orbis/contracts";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";

import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerSeekBackwardButton,
  AudioPlayerSeekForwardButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
  AudioPlayerVolumeRange,
} from "@/components/ai-elements/audio-player";
import { Button } from "@/components/ui/button";
import { detach } from "@/lib/detach";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import {
  completeSet,
  mayOutlast,
  playPlaylist,
  playSet,
  queueSet,
  readQueue,
  reportPosition,
  sendPresence,
  streamUrl,
} from "@/lib/player";
import { layout } from "@/styles/layout";
import { colors, space, widths } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  audio: { maxWidth: widths.xl, width: "100%" },
  bar: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: space.px,
    bottom: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: space[4],
    paddingBlock: space[3],
    paddingInline: space[6],
    position: "sticky",
  },
  page: {
    display: "flex",
    flexBasis: "0%",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
  },
});

// Report the Playback Position this often while playing, plus on pause and seek.
const REPORT_EVERY_MS = 15_000;
// Renew the 30-second Presence lease this often while audio plays (ADR 0019).
const RENEW_EVERY_MS = 15_000;

type PresenceKind = "play" | "pause" | "stop" | "renew";
type PresenceState = "idle" | "playing" | "paused" | "stopped";

/** Which local states each action leaves, and the state it enters. */
const PRESENCE_MOVES: Record<
  PresenceKind,
  { readonly from: readonly PresenceState[]; readonly to: PresenceState }
> = {
  pause: { from: ["playing"], to: "paused" },
  play: { from: ["idle", "paused"], to: "playing" },
  renew: { from: ["playing"], to: "playing" },
  stop: { from: ["playing", "paused"], to: "stopped" },
};

/** One Presence session per Set the player makes active. */
interface PresenceSession {
  readonly sessionId: string;
  readonly setId: string;
  actionNumber: number;
  ownerGeneration: number | null;
  state: PresenceState;
}

interface Playing {
  /** Bumped for each new source, so the `<audio>` element starts fresh. */
  readonly attempt: number;
  readonly set: SavedSet;
  readonly src: string;
  readonly startAt: number;
}

export interface Player {
  readonly elapsed: number;
  readonly playing: Playing | null;
  readonly playPlaylist: (playlistId: string) => Promise<ApiResult<unknown>>;
  /** Makes `set` the active queue entry and plays it from its saved position. */
  readonly play: (set: SavedSet) => Promise<ApiResult<unknown>>;
  readonly playFrom: (
    set: SavedSet,
    seconds: number
  ) => Promise<ApiResult<unknown>>;
  readonly queue: (
    set: SavedSet,
    placement: "next" | "end"
  ) => Promise<ApiResult<unknown>>;
}

// Outside the signed-in shell there is no player; nothing plays.
// oxlint-disable-next-line typescript/promise-function-async -- a settled stub; `async` without `await` breaks eslint/require-await
const unavailable = (): Promise<ApiResult<unknown>> =>
  Promise.resolve({ failure: "failed", ok: false, status: undefined });

const PlayerContext = createContext<Player>({
  elapsed: 0,
  play: unavailable,
  playFrom: unavailable,
  playPlaylist: unavailable,
  playing: null,
  queue: unavailable,
});

export const usePlayer = (): Player => use(PlayerContext);

/**
 * Plays one Set at a time from Vanta through stream grants and keeps the
 * Listening Queue moving: when a Set ends it completes it and plays the next.
 */
export const PlayerProvider = ({
  children,
  credentials,
}: {
  readonly children: ReactNode;
  readonly credentials: Credentials;
}) => {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const lastReport = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playIntent = useRef(0);
  const presence = useRef<PresenceSession | null>(null);
  const presenceSent = useRef<Promise<void>>(Promise.resolve());
  // An API without `/presence/actions` answers 404; Position reports still infer Presence.
  const presenceRoute = useRef(true);
  const lastRenew = useRef(0);
  const written = useRef<Promise<unknown>>(Promise.resolve());
  // The Playback Position this player last knew the service held for the loaded Set: the one it
  // loaded, or the last one it saved. A different value on the service came from another device.
  const savedPosition = useRef<{ setId: string; seconds: number } | null>(null);
  // True from a pause until the next play, so that play is a resume that reads the service first.
  const resumable = useRef(false);
  // True while a resume waits for that read. The element stays paused and reports nothing, so its
  // old place cannot overwrite a newer one from another device.
  const holding = useRef(false);
  // Bumped by each resume read and by a seek, so a seek made during the read wins over its answer.
  const resumeRead = useRef(0);
  // The timer that sends a paused place again after a save got no answer (PAL-3192).
  const resend = useRef<number | null>(null);

  // Position saves and the completion go out one at a time, in the order the player made them.
  // A Set that ends pauses first, which saves its last second; that save must not land after
  // the completion, which resets the place to the start. A call resolves with its failure, so
  // one that fails does not stop the next.
  const write = async <Value,>(
    send: () => Promise<ApiResult<Value>>
  ): Promise<ApiResult<Value>> => {
    const previous = written.current;
    const sent = (async () => {
      await previous;
      return await send();
    })();
    written.current = sent;
    return await sent;
  };

  // Saves a Playback Position in write order, and remembers what the service stored for the loaded
  // Set, so a later resume can tell this player's save from another device's.
  //
  // A save that got no answer may still have landed: the request failed, or its answer was lost,
  // and the page cannot tell which. Either way the player does not know what the service holds, so
  // a pause would never reach the other device, or a resume would skip that device's next pause
  // (PAL-3192). While the element stays paused, its place is saved again on the report tick until
  // a save is answered. The resend reads the element's place when it goes and joins the write
  // order, so it never lands after a newer save. A playing element reports on its own tick; an
  // ended one has its completion.
  const save = (setId: string, seconds: number) => {
    void write(async () => {
      const saved = await reportPosition(credentials, setId, seconds);
      if (saved.ok && savedPosition.current?.setId === setId) {
        savedPosition.current = {
          seconds: saved.value.playbackPositionSeconds,
          setId,
        };
      } else if (mayOutlast(saved) && resend.current === null) {
        resend.current = window.setTimeout(() => {
          resend.current = null;
          const audio = audioRef.current;
          if (
            audio !== null &&
            audio.paused &&
            !audio.ended &&
            !holding.current &&
            savedPosition.current?.setId === setId
          ) {
            save(setId, audio.currentTime);
          }
        }, REPORT_EVERY_MS);
      }
      return saved;
    });
  };

  // Actions go out one at a time, so each carries the generation its play returned.
  const act = (kind: PresenceKind) => {
    const session = presence.current;
    const move = PRESENCE_MOVES[kind];
    if (session === null || !move.from.includes(session.state)) {
      return;
    }
    session.state = move.to;
    if (kind === "play") {
      lastRenew.current = Date.now();
    }
    const previous = presenceSent.current;
    presenceSent.current = (async () => {
      await previous;
      const { ownerGeneration } = session;
      const fields = {
        actionId: crypto.randomUUID(),
        actionNumber: session.actionNumber + 1,
        sessionId: session.sessionId,
      };
      let action: PresenceAction | null = null;
      if (kind === "play") {
        action = { ...fields, kind, setId: session.setId };
      } else if (ownerGeneration !== null) {
        action = { ...fields, kind, ownerGeneration };
      }
      if (!presenceRoute.current || action === null) {
        return;
      }
      session.actionNumber = fields.actionNumber;
      const sent = await sendPresence(credentials, action);
      if (sent.ok) {
        session.ownerGeneration = sent.value.session.ownerGeneration;
      } else if (sent.status === 404) {
        presenceRoute.current = false;
      } else if (kind === "play" && session.state === "playing") {
        session.state = "idle";
      }
    })();
  };

  const start = async (
    set: SavedSet,
    attempt: number,
    startAt = set.playbackPositionSeconds,
    intent = playIntent.current
  ): Promise<ApiResult<unknown>> => {
    const src = await streamUrl(credentials, set.id);
    if (intent !== playIntent.current) {
      return { ok: true, value: undefined };
    }
    if (!src.ok) {
      setProblem(FAILURE_MESSAGES[src.failure]);
      return src;
    }
    act("stop");
    presence.current = {
      actionNumber: 0,
      ownerGeneration: null,
      sessionId: crypto.randomUUID(),
      setId: set.id,
      state: "idle",
    };
    lastReport.current = 0;
    savedPosition.current = {
      seconds: set.playbackPositionSeconds,
      setId: set.id,
    };
    resumable.current = false;
    holding.current = false;
    resumeRead.current += 1;
    setProblem(null);
    setElapsed(startAt);
    setPlaying({ attempt, set, src: src.value, startAt });
    return src;
  };

  const activate = async (
    played: Awaited<ReturnType<typeof playSet>>,
    intent: number,
    startAt?: number
  ): Promise<ApiResult<unknown>> => {
    if (intent !== playIntent.current) {
      return { ok: true, value: undefined };
    }
    if (!played.ok) {
      return played;
    }
    const { activeSetId, entries } = played.value.queue;
    const active = entries.find((entry) => entry.id === activeSetId);
    if (!active) {
      setPlaying(null);
      return played;
    }
    // Another Set takes the player, and the `<audio>` element of the one playing goes with no
    // pause event. Its place is saved here, or it would resume up to 15 s early.
    const audio = audioRef.current;
    if (
      playing !== null &&
      playing.set.id !== active.id &&
      audio !== null &&
      !audio.paused
    ) {
      save(playing.set.id, audio.currentTime);
    }
    return await start(active, (playing?.attempt ?? 0) + 1, startAt, intent);
  };

  const play = async (set: SavedSet) => {
    playIntent.current += 1;
    const intent = playIntent.current;
    return await activate(await playSet(credentials, set.id), intent);
  };

  const playFrom = async (set: SavedSet, seconds: number) => {
    playIntent.current += 1;
    const intent = playIntent.current;
    const audio = audioRef.current;
    if (playing?.set.id === set.id && audio !== null && audio.readyState > 0) {
      // An explicit start time wins over the service's position, so this play reads nothing.
      resumable.current = false;
      resumeRead.current += 1;
      audio.currentTime = seconds;
      setElapsed(seconds);
      try {
        await audio.play();
        return { ok: true, value: undefined } as const;
      } catch {
        if (intent !== playIntent.current) {
          return { ok: true, value: undefined } as const;
        }
        setProblem("The audio could not play.");
        return { failure: "failed", ok: false } as const;
      }
    }
    return await activate(await playSet(credentials, set.id), intent, seconds);
  };

  const playFromPlaylist = async (playlistId: string) => {
    playIntent.current += 1;
    const intent = playIntent.current;
    return await activate(await playPlaylist(credentials, playlistId), intent);
  };

  const queue = async (set: SavedSet, placement: "next" | "end") =>
    await queueSet(credentials, set.id, placement);

  const report = (event: SyntheticEvent<HTMLAudioElement>) => {
    const seconds = event.currentTarget.currentTime;
    if (playing !== null && Number.isFinite(seconds)) {
      save(playing.set.id, seconds);
    }
  };

  const seeked = (event: SyntheticEvent<HTMLAudioElement>) => {
    // A seek is the person's choice of place, so a resume read still out must not move it.
    resumeRead.current += 1;
    report(event);
  };

  // Every play after a pause, from any control, comes through here. The element waits, paused,
  // while the player reads the service's position for the Set. When the service holds another
  // value than the one this player last knew, another device saved it later: the player moves
  // there, then plays. A read that fails plays from the element's own place.
  const resume = (event: SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    if (holding.current) {
      // Play again during the read: the read already plays when it answers. Sound now would
      // report the old place before the read, and the read would then find that old place.
      audio.pause();
      return;
    }
    if (playing === null || !resumable.current) {
      return;
    }
    resumable.current = false;
    holding.current = true;
    audio.pause();
    resumeRead.current += 1;
    const read = resumeRead.current;
    const setId = playing.set.id;
    void (async () => {
      // The pause's save goes first, so the read answers after it.
      await written.current;
      const answer = await readQueue(credentials);
      if (audioRef.current !== audio) {
        return;
      }
      const entry = answer.ok
        ? answer.value.queue.entries.find((candidate) => candidate.id === setId)
        : undefined;
      const known = savedPosition.current;
      if (
        read === resumeRead.current &&
        entry !== undefined &&
        known?.setId === setId &&
        entry.playbackPositionSeconds !== known.seconds
      ) {
        savedPosition.current = {
          seconds: entry.playbackPositionSeconds,
          setId,
        };
        audio.currentTime = entry.playbackPositionSeconds;
        setElapsed(entry.playbackPositionSeconds);
      }
      if (holding.current) {
        holding.current = false;
        await audio.play().catch(() => {
          setProblem("The audio could not play.");
        });
      }
    })();
  };

  const reportNowAndThen = (event: SyntheticEvent<HTMLAudioElement>) => {
    if (holding.current) {
      return;
    }
    setElapsed(Math.floor(event.currentTarget.currentTime));
    const now = Date.now();
    if (now - lastReport.current >= REPORT_EVERY_MS) {
      lastReport.current = now;
      report(event);
    }
    if (now - lastRenew.current >= RENEW_EVERY_MS) {
      lastRenew.current = now;
      act("renew");
    }
  };

  const pause = (event: SyntheticEvent<HTMLAudioElement>) => {
    // The resume's own wait is not the person's pause.
    if (holding.current) {
      return;
    }
    resumable.current = true;
    act("pause");
    report(event);
  };

  const finish = async () => {
    act("stop");
    if (playing === null) {
      return;
    }
    // The save of 0 goes after the pause's save of the last second. The completion resets the
    // place only of the active Set, so a Set that is no longer active needs this save.
    const { id } = playing.set;
    const intent = playIntent.current;
    save(id, 0);
    const completed = await write(
      async () => await completeSet(credentials, id)
    );
    // A Set the person chose while the completion was out keeps the player.
    if (intent !== playIntent.current) {
      return;
    }
    if (!completed.ok) {
      setProblem(FAILURE_MESSAGES[completed.failure]);
      return;
    }
    const { activeSetId, entries } = completed.value.queue;
    const next = entries.find((entry) => entry.id === activeSetId);
    if (next) {
      await start(next, playing.attempt + 1);
    } else {
      setPlaying(null);
    }
  };

  const retry = async () => {
    if (playing !== null) {
      await start(playing.set, playing.attempt + 1);
    }
  };

  return (
    <PlayerContext
      value={{
        elapsed,
        play,
        playFrom,
        playPlaylist: playFromPlaylist,
        playing,
        queue,
      }}
    >
      {/* The page fills the shell, so the player bar rests at the bottom. */}
      <div {...stylex.props(styles.page)}>{children}</div>
      {playing === null ? null : (
        <section aria-label="Audio player" {...stylex.props(styles.bar)}>
          <div {...stylex.props(layout.fill)}>
            <p {...stylex.props(type.truncate, type.medium)}>
              {playing.set.title}
            </p>
            <p {...stylex.props(type.truncate, type.sm, type.muted)}>
              {playing.set.creator ?? "Unknown creator"}
            </p>
          </div>
          <AudioPlayer key={playing.attempt} xstyle={styles.audio}>
            <AudioPlayerElement
              autoPlay
              ref={audioRef}
              onEnded={detach(finish)}
              onError={() => {
                setProblem("The audio could not load.");
              }}
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = playing.startAt;
              }}
              onPause={pause}
              onPlay={resume}
              onPlaying={() => {
                act("play");
              }}
              onSeeked={seeked}
              onTimeUpdate={reportNowAndThen}
              src={playing.src}
            />
            <AudioPlayerControlBar>
              <AudioPlayerPlayButton />
              <AudioPlayerSeekBackwardButton seekOffset={15} />
              <AudioPlayerSeekForwardButton seekOffset={30} />
              <AudioPlayerTimeDisplay />
              <AudioPlayerTimeRange />
              <AudioPlayerDurationDisplay />
              <AudioPlayerMuteButton />
              <AudioPlayerVolumeRange />
            </AudioPlayerControlBar>
          </AudioPlayer>
          {problem === null ? null : (
            <div {...stylex.props(layout.rowCenter2)}>
              <p {...stylex.props(type.sm, type.error)} role="alert">
                {problem}
              </p>
              <Button onClick={detach(retry)} size="sm" variant="outline">
                Retry audio
              </Button>
            </div>
          )}
        </section>
      )}
    </PlayerContext>
  );
};
