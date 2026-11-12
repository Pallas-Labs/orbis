import { isDownloadInFlight } from "@orbis/contracts";
import { ExportIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SOURCE_LABELS, setDetails } from "@/components/library/set-row";
import { Tracklist } from "@/components/library/tracklist";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { usePlayer } from "@/components/player/player";
import { RouteProblem } from "@/components/route-problem";
import { Button, buttonLook } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { detach } from "@/lib/detach";
import { listSets, requestDownload } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import { getTracklist, retryTracklist } from "@/lib/tracklists";
import type { Session } from "@/routes/_app";
import { layout } from "@/styles/layout";
import { colors, radii, space, widths } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  actions: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space[2],
  },
  artwork: {
    aspectRatio: "1 / 1",
    borderRadius: radii.md,
    flexShrink: 0,
    width: { "@media (min-width: 40rem)": space[48], default: space[32] },
  },
  artworkImage: { objectFit: "cover" },
  artworkPlaceholder: { backgroundColor: colors.muted },
  back: { color: colors.primary, textDecorationLine: "underline" },
  header: {
    alignItems: { "@media (min-width: 40rem)": "flex-end", default: null },
    display: "flex",
    flexDirection: { "@media (min-width: 40rem)": "row", default: "column" },
    gap: space[4],
  },
  heading: { textWrap: "pretty" },
  info: {
    alignItems: "flex-start",
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    minWidth: 0,
  },
  libraryLink: { textDecorationLine: "underline", width: "fit-content" },
  main: {
    marginInline: "auto",
    maxWidth: widths.xl3,
    width: "100%",
  },
  page: {
    paddingBottom: space[40],
    paddingInline: space[6],
    paddingTop: space[6],
  },
});

const AudioAction = ({
  download,
  play,
  progress,
  set,
}: {
  readonly download: () => Promise<void>;
  readonly play: (seconds: number) => Promise<void>;
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  // Web cannot play Apple Music (ADR 0021), and Orbis never keeps its audio.
  if (set.source === "apple-music") {
    return (
      <a
        {...stylex.props(buttonLook())}
        href={set.url}
        rel="noreferrer"
        target="_blank"
      >
        Open in Apple Music
      </a>
    );
  }
  if (set.downloadState === "ready") {
    return (
      <Button
        onClick={detach(async () => {
          await play(set.playbackPositionSeconds);
        })}
      >
        Play
      </Button>
    );
  }
  if (isDownloadInFlight(set.downloadState)) {
    return (
      <p {...stylex.props(type.sm, type.muted)}>
        {progress === undefined
          ? "Keeping audio…"
          : `Keeping audio ${Math.round(progress * 100)}%`}
      </p>
    );
  }
  return (
    <Button onClick={detach(download)} variant="outline">
      Keep audio to play
    </Button>
  );
};

const ShareMenu = ({
  onCopy,
  set,
}: {
  readonly onCopy: (link: string, url: string) => Promise<void>;
  readonly set: SavedSet;
}) => {
  const sourceLink = `${SOURCE_LABELS[set.source]} link`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <Icon data-icon="inline-start" glyph={ExportIcon} />
        Share
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={detach(async () => {
            await onCopy("Orbis link", `${window.location.origin}/s/${set.id}`);
          })}
        >
          Copy Orbis link
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={detach(async () => {
            await onCopy(sourceLink, set.url);
          })}
        >
          Copy {sourceLink}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const SetPage = ({
  session,
  set,
  tracklist,
}: {
  readonly session: Session;
  readonly set: SavedSet | null;
  readonly tracklist: Awaited<ReturnType<typeof getTracklist>> | null;
}) => {
  const router = useRouter();
  const player = usePlayer();
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const downloadProgress = useDownloadProgress(
    session,
    set === null ? [] : [set]
  );
  const tracklistState = tracklist?.ok === true ? tracklist.value.state : null;

  useEffect(() => {
    if (tracklistState !== "pending") {
      return;
    }
    const timer = setInterval(() => {
      void router.invalidate();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [router, tracklistState]);

  if (set === null) {
    return (
      <main {...stylex.props(layout.main)}>
        <h1 {...stylex.props(type.title)}>Set not found</h1>
        <Link {...stylex.props(styles.back, layout.focusOutline)} to="/">
          Back to Library
        </Link>
      </main>
    );
  }

  const play = async (seconds: number) => {
    if (set.downloadState !== "ready") {
      setProblem("Keep audio to play this Set.");
      return;
    }
    const result = await player.playFrom(set, seconds);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
  };
  const download = async () => {
    const result = await requestDownload(session, set.id);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
    if (result.ok) {
      await router.invalidate();
    }
  };
  const copy = async (link: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(link);
      setProblem(null);
    } catch {
      setCopied(null);
      setProblem(`Could not copy the ${link}.`);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    const result = await retryTracklist(session, set.id);
    setRefreshing(false);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
    if (result.ok) {
      await router.invalidate();
    }
  };

  let tracklistContent = null;
  if (tracklist?.ok === false) {
    tracklistContent = (
      <div {...stylex.props(layout.rowCenter3)}>
        <p role="alert">{FAILURE_MESSAGES[tracklist.failure]}</p>
        <Button
          onClick={detach(async () => {
            await router.invalidate();
          })}
          size="sm"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  } else if (tracklist?.ok === true) {
    tracklistContent = (
      <Tracklist
        cues={tracklist.value.cues}
        currentSeconds={
          player.playing?.set.id === set.id ? player.elapsed : null
        }
        onRefresh={() => {
          void refresh();
        }}
        onSeek={
          set.source === "apple-music"
            ? undefined
            : (seconds) => {
                void play(seconds);
              }
        }
        refreshing={refreshing}
        state={tracklist.value.state}
      />
    );
  }

  return (
    <main {...stylex.props(styles.main, layout.stack6, styles.page)}>
      <Link
        {...stylex.props(
          type.sm,
          type.muted,
          styles.libraryLink,
          layout.focusOutline
        )}
        to="/"
      >
        Library
      </Link>
      <header {...stylex.props(styles.header)}>
        {(set.artworkLargeUrl ?? set.artworkUrl ?? "") === "" ? (
          <div
            aria-hidden
            {...stylex.props(styles.artwork, styles.artworkPlaceholder)}
          />
        ) : (
          <img
            alt=""
            {...stylex.props(styles.artwork, styles.artworkImage)}
            src={set.artworkLargeUrl ?? set.artworkUrl ?? ""}
          />
        )}
        <div {...stylex.props(styles.info)}>
          <div>
            <h1 {...stylex.props(type.title, styles.heading)}>{set.title}</h1>
            <p {...stylex.props(type.muted)}>{setDetails(set)}</p>
          </div>
          <div {...stylex.props(styles.actions)}>
            <AudioAction
              download={download}
              play={play}
              progress={downloadProgress.get(set.id)}
              set={set}
            />
            <ShareMenu onCopy={copy} set={set} />
            {copied === null ? null : (
              <p {...stylex.props(type.sm, type.muted)} role="status">
                Copied the {copied}
              </p>
            )}
          </div>
        </div>
      </header>
      {problem === null ? null : <p role="alert">{problem}</p>}
      {tracklistContent}
    </main>
  );
};

export const Route = createFileRoute("/_app/sets/$id")({
  component: () => (
    <SetPage
      session={Route.useRouteContext().session}
      set={Route.useLoaderData().set}
      tracklist={Route.useLoaderData().tracklist}
    />
  ),
  errorComponent: RouteProblem,
  loader: async ({ context, params }) => {
    const sets = await listSets(context.session, {});
    if (!sets.ok) {
      throw new Error(FAILURE_MESSAGES[sets.failure]);
    }
    const set = sets.value.sets.find((saved) => saved.id === params.id) ?? null;
    return {
      set,
      tracklist:
        set === null ? null : await getTracklist(context.session, set.id),
    };
  },
});
