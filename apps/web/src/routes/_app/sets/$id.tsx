import { ExportIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SOURCE_LABELS, setDetails } from "@/components/library/set-row";
import { Tracklist } from "@/components/library/tracklist";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { usePlayer } from "@/components/player/player";
import { RouteProblem } from "@/components/route-problem";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { detach } from "@/lib/detach";
import { listSets, requestDownload } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import { getTracklist, retryTracklist } from "@/lib/tracklists";
import type { Session } from "@/routes/_app";

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
        className={buttonVariants()}
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
      <Button onClick={detach(() => play(set.playbackPositionSeconds))}>
        Play
      </Button>
    );
  }
  if (set.downloadState === "queued" || set.downloadState === "downloading") {
    return (
      <p className="text-muted-foreground text-sm">
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
        <ExportIcon data-icon="inline-start" />
        Share
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={detach(() =>
            onCopy("Orbis link", `${window.location.origin}/s/${set.id}`)
          )}
        >
          Copy Orbis link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={detach(() => onCopy(sourceLink, set.url))}>
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
    return () => clearInterval(timer);
  }, [router, tracklistState]);

  if (set === null) {
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <h1 className="text-2xl font-medium">Set not found</h1>
        <Link className="text-primary underline" to="/">
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
      <div className="flex items-center gap-3">
        <p role="alert">{FAILURE_MESSAGES[tracklist.failure]}</p>
        <Button
          onClick={detach(() => router.invalidate())}
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
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-6 pb-40">
      <Link className="text-muted-foreground w-fit text-sm underline" to="/">
        Library
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end">
        {(set.artworkLargeUrl ?? set.artworkUrl) ? (
          <img
            alt=""
            className="aspect-square w-32 shrink-0 rounded-md object-cover sm:w-48"
            src={set.artworkLargeUrl ?? set.artworkUrl ?? ""}
          />
        ) : (
          <div
            aria-hidden
            className="bg-muted aspect-square w-32 shrink-0 rounded-md sm:w-48"
          />
        )}
        <div className="flex min-w-0 flex-col items-start gap-3">
          <div>
            <h1 className="text-2xl font-medium text-pretty">{set.title}</h1>
            <p className="text-muted-foreground">{setDetails(set)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AudioAction
              download={download}
              play={play}
              progress={downloadProgress.get(set.id)}
              set={set}
            />
            <ShareMenu onCopy={copy} set={set} />
            {copied === null ? null : (
              <p className="text-muted-foreground text-sm" role="status">
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
