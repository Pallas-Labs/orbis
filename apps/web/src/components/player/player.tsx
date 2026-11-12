import type { PresenceAction } from "@orbis/contracts";
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
  playPlaylist,
  playSet,
  queueSet,
  reportPosition,
  sendPresence,
  streamUrl,
} from "@/lib/player";

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
      const { id } = playing.set;
      const seconds = audio.currentTime;
      void write(async () => await reportPosition(credentials, id, seconds));
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
      const { id } = playing.set;
      void write(async () => await reportPosition(credentials, id, seconds));
    }
  };

  const reportNowAndThen = (event: SyntheticEvent<HTMLAudioElement>) => {
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
    act("pause");
    report(event);
  };

  const finish = async () => {
    act("stop");
    if (playing === null) {
      return;
    }
    // The completion resets the Playback Position on the server, so no save of 0 goes first.
    const { id } = playing.set;
    const completed = await write(
      async () => await completeSet(credentials, id)
    );
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
      <div className="flex flex-1 flex-col">{children}</div>
      {playing === null ? null : (
        <section
          aria-label="Audio player"
          className="bg-background sticky bottom-0 flex flex-wrap items-center gap-4 border-t px-6 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{playing.set.title}</p>
            <p className="text-muted-foreground truncate text-sm">
              {playing.set.creator ?? "Unknown creator"}
            </p>
          </div>
          <AudioPlayer className="w-full max-w-xl" key={playing.attempt}>
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
              onPlaying={() => {
                act("play");
              }}
              onSeeked={report}
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
            <div className="flex items-center gap-2">
              <p className="text-destructive text-sm" role="alert">
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
