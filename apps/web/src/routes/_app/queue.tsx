import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useLiveEvents } from "@/components/live-events";
import { usePlayer } from "@/components/player/player";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { detach } from "@/lib/detach";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import { layout } from "@/styles/layout";
import { space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  entry: { alignItems: "center", display: "flex", gap: space[4] },
  title: { flexBasis: "0%", flexGrow: 1, flexShrink: 1 },
});

const Queue = () => {
  const { queue, reconnecting } = useLiveEvents();
  const player = usePlayer();
  const [problem, setProblem] = useState<string | null>(null);
  const active = queue?.entries.find((set) => set.id === queue.activeSetId);
  const upcoming =
    queue?.entries.filter((set) => set.id !== queue.activeSetId) ?? [];
  return (
    <main {...stylex.props(layout.stack6, layout.main)}>
      <h1 {...stylex.props(type.title)}>Listening Queue</h1>
      {reconnecting ? (
        <p {...stylex.props(type.muted, type.sm)} role="status">
          Reconnecting…
        </p>
      ) : null}
      <section aria-label="Listening queue" {...stylex.props(layout.stack4)}>
        {queue === null ? (
          <p {...stylex.props(type.muted)}>Loading…</p>
        ) : (
          <>
            <p>
              {active === undefined
                ? "Nothing playing"
                : `Now: ${active.title}`}
            </p>
            {queue.entries.length === 0 ? (
              <p {...stylex.props(type.muted)}>Your queue is empty.</p>
            ) : (
              <ol {...stylex.props(layout.stack2)}>
                {upcoming.map((set) => (
                  <li {...stylex.props(styles.entry)} key={set.id}>
                    <span {...stylex.props(styles.title, type.truncate)}>
                      {set.title}
                    </span>
                    <Button
                      aria-label={`Play ${set.title}`}
                      onClick={detach(async () => {
                        const played = await player.play(set);
                        setProblem(
                          played.ok ? null : FAILURE_MESSAGES[played.failure]
                        );
                      })}
                      size="sm"
                      variant="outline"
                    >
                      Play
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
      <Problem message={problem} />
    </main>
  );
};

export const Route = createFileRoute("/_app/queue")({ component: Queue });
