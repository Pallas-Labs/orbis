import * as stylex from "@stylexjs/stylex";

import { Button } from "@/components/ui/button";
import { layout } from "@/styles/layout";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  artwork: {
    borderRadius: radii.sm,
    flexShrink: 0,
    height: space[11],
    width: space[11],
  },
  artworkImage: { objectFit: "cover" },
  artworkPlaceholder: { backgroundColor: colors.muted },
  cue: {
    alignItems: "center",
    display: "flex",
    gap: space[3],
    minHeight: space[11],
    paddingBlock: space[1],
    paddingInline: space[2],
  },
  cueButton: {
    backgroundColor: {
      ":hover": { "@media (hover: hover)": colors.accent, default: null },
      default: null,
    },
    borderRadius: radii.md,
    boxShadow: {
      ":focus-visible": `0 0 0 2px ${colors.ring}`,
      default: null,
    },
    outlineStyle: { ":focus-visible": "none", default: null },
    textAlign: "start",
    width: "100%",
  },
  current: {
    backgroundColor: colors.accent,
    color: colors.accentForeground,
  },
  heading: {
    alignItems: "center",
    display: "flex",
    gap: space[3],
    justifyContent: "space-between",
  },
  line: { display: "block" },
  time: { flexShrink: 0, textAlign: "end", width: space[12] },
});

export interface Cue {
  readonly position: number;
  readonly startSeconds: number | null;
  readonly artist: string;
  readonly title: string;
  readonly artworkUrl: string | null;
}

const timeLabel = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return hours === 0
    ? `${minutes}:${remainder}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`;
};

export const Tracklist = ({
  cues,
  currentSeconds,
  onRefresh,
  onSeek,
  refreshing,
  state,
}: {
  readonly cues: readonly Cue[];
  readonly currentSeconds: number | null;
  /** Asks Versos to scan the Set again. */
  readonly onRefresh: () => void;
  /** Absent when this page cannot play the Set, so no Cue is a button. */
  readonly onSeek?: ((seconds: number) => void) | undefined;
  readonly refreshing: boolean;
  readonly state: "pending" | "ready" | "none" | "failed";
}) => {
  const refresh =
    state === "pending" ? null : (
      <Button
        disabled={refreshing}
        onClick={onRefresh}
        size="sm"
        variant="outline"
      >
        Refresh tracklist
      </Button>
    );
  if (cues.length === 0) {
    if (state === "pending") {
      return <p role="status">Finding tracklist…</p>;
    }
    return (
      <section aria-label="Tracklist" {...stylex.props(layout.rowCenter3)}>
        <p {...stylex.props(type.sm, type.muted)}>
          {state === "failed"
            ? "Tracklist unavailable."
            : "No tracklist found."}
        </p>
        {refresh}
      </section>
    );
  }

  let currentPosition: number | null = null;
  if (currentSeconds !== null) {
    for (const cue of cues) {
      if (cue.startSeconds !== null && cue.startSeconds <= currentSeconds) {
        currentPosition = cue.position;
      }
    }
  }

  return (
    <section
      aria-labelledby="tracklist-heading"
      {...stylex.props(layout.stack4)}
    >
      <div {...stylex.props(styles.heading)}>
        <h2 {...stylex.props(type.lg, type.medium)} id="tracklist-heading">
          Tracklist
        </h2>
        {refresh}
      </div>
      {state === "pending" ? <p role="status">Finding tracklist…</p> : null}
      <ol aria-label="Tracklist" {...stylex.props(layout.stack1)}>
        {cues.map((cue) => {
          const active = cue.position === currentPosition;
          const { artworkUrl, startSeconds } = cue;
          const artwork =
            artworkUrl !== null && artworkUrl !== "" ? (
              <img
                alt=""
                {...stylex.props(styles.artwork, styles.artworkImage)}
                src={artworkUrl}
              />
            ) : (
              <span
                aria-hidden
                {...stylex.props(styles.artwork, styles.artworkPlaceholder)}
              />
            );
          const details = (
            <>
              <span
                {...stylex.props(
                  type.sm,
                  type.muted,
                  type.tabular,
                  styles.time
                )}
              >
                {startSeconds === null ? "--:--" : timeLabel(startSeconds)}
              </span>
              {artwork}
              <span {...stylex.props(layout.fill)}>
                <span
                  {...stylex.props(styles.line, type.truncate, type.medium)}
                >
                  {cue.title}
                </span>
                <span
                  {...stylex.props(
                    styles.line,
                    type.truncate,
                    type.sm,
                    type.muted
                  )}
                >
                  {cue.artist}
                </span>
              </span>
            </>
          );
          return (
            <li key={cue.position}>
              {startSeconds === null || onSeek === undefined ? (
                <div {...stylex.props(styles.cue)}>{details}</div>
              ) : (
                <button
                  aria-current={active ? "true" : undefined}
                  aria-label={`${cue.title}, ${cue.artist}, starts at ${timeLabel(startSeconds)}`}
                  {...stylex.props(
                    styles.cue,
                    styles.cueButton,
                    active && styles.current
                  )}
                  onClick={() => {
                    onSeek(startSeconds);
                  }}
                  type="button"
                >
                  {details}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
