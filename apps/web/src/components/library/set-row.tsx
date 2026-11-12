import { isDownloadInFlight } from "@orbis/contracts";
import { DotsThreeIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { AddToPlaylistDialog } from "@/components/library/add-to-playlist-dialog";
import { usePlayer } from "@/components/player/player";
import { Problem } from "@/components/problem";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detach } from "@/lib/detach";
import { formText } from "@/lib/form";
import {
  cancelDownload,
  removeSet,
  renameSet,
  requestDownload,
  updateTags,
} from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import type { Playlist } from "@/lib/playlists";
import { layout } from "@/styles/layout";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  artwork: {
    borderRadius: radii.md,
    flexShrink: 0,
    height: space[16],
    width: space[16],
  },
  artworkImage: { objectFit: "cover" },
  artworkPlaceholder: { backgroundColor: colors.muted },
  badges: { display: "flex", flexWrap: "wrap", gap: space[1] },
  row: {
    alignItems: "flex-start",
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: space.px,
    display: "flex",
    gap: space[4],
    paddingBlock: space[4],
  },
  title: {
    textDecorationLine: {
      ":hover": { "@media (hover: hover)": "underline", default: null },
      default: null,
    },
  },
});

type Dialogs = "rename" | "tags" | "playlists" | "remove";

export const SOURCE_LABELS = {
  "apple-music": "Apple Music",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
} as const;

export const duration = (seconds: number | null): string | null => {
  if (seconds === null) {
    return null;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

/** The line under a Set's title: creator, source, and length. */
export const setDetails = (set: SavedSet): string =>
  [
    set.creator ?? "Unknown creator",
    SOURCE_LABELS[set.source],
    duration(set.durationSeconds),
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** Apple Music audio is licensed to each listener, so Orbis never keeps it (ADR 0021). */
export const canDownload = (set: SavedSet): boolean =>
  set.source !== "apple-music" &&
  ["none", "failed", "canceled"].includes(set.downloadState);

export const DownloadBadge = ({
  progress,
  set,
}: {
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  switch (set.downloadState) {
    case "ready": {
      return <Badge variant="secondary">Audio kept</Badge>;
    }
    case "queued": {
      return <Badge variant="outline">Waiting to download</Badge>;
    }
    case "downloading": {
      return (
        <Badge variant="outline">
          {progress === undefined
            ? "Downloading"
            : `Downloading ${Math.round(progress * 100)}%`}
        </Badge>
      );
    }
    case "failed": {
      return <Badge variant="destructive">Download failed</Badge>;
    }
    case "canceled":
    case "none": {
      return null;
    }
    // no default
  }
};

/** Tags as the Person types them: comma separated, trimmed, without repeats. */
const parseTags = (text: string): string[] => [
  ...new Set(
    text
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "")
  ),
];

const TextDialog = ({
  label,
  onClose,
  onSave,
  title,
  value,
}: {
  readonly label: string;
  readonly onClose: () => void;
  readonly onSave: (text: string) => Promise<ApiResult<unknown>>;
  readonly title: string;
  readonly value: string;
}) => {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const result = await onSave(
      formText(new FormData(event.currentTarget), "value")
    );
    setPending(false);
    if (result.ok) {
      onClose();
      return;
    }
    setProblem(FAILURE_MESSAGES[result.failure]);
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <form {...stylex.props(layout.stack4)} onSubmit={detach(save)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div {...stylex.props(layout.stack2)}>
            <Label htmlFor="set-dialog-value">{label}</Label>
            <Input defaultValue={value} id="set-dialog-value" name="value" />
          </div>
          <Problem message={problem} />
          <DialogFooter>
            <Button disabled={pending} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const SetRow = ({
  credentials,
  playlists,
  progress,
  set,
}: {
  readonly credentials: Credentials;
  readonly playlists: readonly Playlist[];
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  const router = useRouter();
  const player = usePlayer();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = async (result: ApiResult<unknown>, limited?: string) => {
    if (result.ok) {
      setProblem(null);
      await router.invalidate();
      return;
    }
    setProblem(
      result.failure === "limited" && limited !== undefined
        ? limited
        : FAILURE_MESSAGES[result.failure]
    );
  };
  const close = async () => {
    setDialog(null);
    await router.invalidate();
  };
  const downloadable = canDownload(set);
  const inFlight = isDownloadInFlight(set.downloadState);
  return (
    <li {...stylex.props(styles.row)}>
      {set.artworkUrl === null ? (
        <div {...stylex.props(styles.artwork, styles.artworkPlaceholder)} />
      ) : (
        <img
          alt=""
          {...stylex.props(styles.artwork, styles.artworkImage)}
          src={set.artworkUrl}
        />
      )}
      <div {...stylex.props(layout.stack1, layout.fill)}>
        <h2 {...stylex.props(type.truncate, type.medium)}>
          <Link
            {...stylex.props(styles.title, layout.focusOutline)}
            params={{ id: set.id }}
            to="/sets/$id"
          >
            {set.title}
          </Link>
        </h2>
        <p {...stylex.props(type.sm, type.muted)}>{setDetails(set)}</p>
        <div {...stylex.props(styles.badges)}>
          <DownloadBadge progress={progress} set={set} />
          {set.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <Problem message={problem} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`Actions for ${set.title}`}
              size="icon"
              variant="ghost"
            />
          }
        >
          <Icon glyph={DotsThreeIcon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {set.downloadState === "ready" ? (
            <>
              <DropdownMenuItem
                onClick={detach(async () => {
                  await settle(await player.play(set));
                })}
              >
                Play
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={detach(async () => {
                  await settle(await player.queue(set, "next"));
                })}
              >
                Play next
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={detach(async () => {
                  await settle(await player.queue(set, "end"));
                })}
              >
                Add to queue
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {downloadable ? (
            <DropdownMenuItem
              onClick={detach(async () => {
                await settle(
                  await requestDownload(credentials, set.id),
                  "The Download queue is full. Try again later."
                );
              })}
            >
              Download
            </DropdownMenuItem>
          ) : null}
          {inFlight ? (
            <DropdownMenuItem
              onClick={detach(async () => {
                await settle(await cancelDownload(credentials, set.id));
              })}
            >
              Cancel Download
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => {
              setDialog("rename");
            }}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDialog("tags");
            }}
          >
            Edit Tags…
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDialog("playlists");
            }}
          >
            Add to Playlist…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setDialog("remove");
            }}
            variant="destructive"
          >
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "rename" ? (
        <TextDialog
          label="Title"
          onClose={detach(close)}
          onSave={async (text) =>
            await renameSet(credentials, set.id, text.trim())
          }
          title={`Rename ${set.title}`}
          value={set.title}
        />
      ) : null}
      {dialog === "tags" ? (
        <TextDialog
          label="Tags, separated by commas"
          onClose={detach(close)}
          onSave={async (text) =>
            await updateTags(credentials, set.id, parseTags(text))
          }
          title={`Tags for ${set.title}`}
          value={set.tags.join(", ")}
        />
      ) : null}
      {dialog === "playlists" ? (
        <AddToPlaylistDialog
          credentials={credentials}
          onClose={detach(close)}
          playlists={playlists}
          set={set}
        />
      ) : null}
      <AlertDialog
        onOpenChange={(open) => {
          setDialog(open ? "remove" : null);
        }}
        open={dialog === "remove"}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {set.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves your Library. Other People who saved it keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <Button
              onClick={detach(async () => {
                setDialog(null);
                await settle(await removeSet(credentials, set.id));
              })}
              variant="destructive"
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
};
