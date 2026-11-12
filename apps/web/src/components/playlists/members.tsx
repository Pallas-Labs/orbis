import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { detach } from "@/lib/detach";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import { replaceMembers } from "@/lib/playlists";
import type { PlaylistDetail } from "@/lib/playlists";
import { layout } from "@/styles/layout";
import { space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  candidates: { maxHeight: space[80], overflowY: "auto" },
  header: {
    alignItems: "center",
    display: "flex",
    gap: space[4],
    justifyContent: "space-between",
  },
  position: { textAlign: "right", width: space[6] },
  row: {
    alignItems: "center",
    display: "flex",
    gap: space[3],
    paddingBlock: space[3],
  },
});

const pickerHint = (emptyLibrary: boolean, candidates: number) => {
  if (emptyLibrary) {
    return "Your Library has no Sets. Save a Set in your Library first.";
  }
  return candidates === 0
    ? "Every Set in your Library is already in this Playlist."
    : "Choose Sets from your Library. They go at the end, in the order you choose them.";
};

const AddSetsDialog = ({
  candidates,
  emptyLibrary,
  onAdd,
  onClose,
  pending,
  playlistName,
}: {
  readonly candidates: readonly SavedSet[];
  readonly emptyLibrary: boolean;
  readonly onAdd: (setIds: readonly string[]) => Promise<void>;
  readonly onClose: () => void;
  readonly pending: boolean;
  readonly playlistName: string;
}) => {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const toggle = (id: string, checked: boolean) => {
    setChosen(
      checked ? [...chosen, id] : chosen.filter((picked) => picked !== id)
    );
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
        <DialogHeader>
          <DialogTitle>Add Sets to {playlistName}</DialogTitle>
          <DialogDescription>
            {pickerHint(emptyLibrary, candidates.length)}
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? null : (
          <ul
            aria-label="Sets in your Library"
            {...stylex.props(layout.stack3, styles.candidates)}
          >
            {candidates.map((set) => (
              <li key={set.id}>
                <label {...stylex.props(layout.rowCenter3, type.sm)}>
                  <Checkbox
                    checked={chosen.includes(set.id)}
                    onCheckedChange={(checked) => {
                      toggle(set.id, checked);
                    }}
                  />
                  <span {...stylex.props(type.truncate)}>{set.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            disabled={pending || chosen.length === 0}
            onClick={detach(async () => {
              await onAdd(chosen);
            })}
          >
            {chosen.length > 1 ? `Add ${chosen.length} Sets` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const Members = ({
  credentials,
  library,
  playlist,
}: {
  readonly credentials: Credentials;
  readonly library: readonly SavedSet[];
  readonly playlist: PlaylistDetail;
}) => {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = playlist.sets.map((set) => set.id);
  const change = async (setIds: readonly string[]) => {
    setPending(true);
    const result = await replaceMembers(credentials, playlist.id, setIds);
    if (result.ok) {
      setProblem(null);
      setAdding(false);
      await router.invalidate();
    } else {
      setProblem(
        result.status === 404
          ? "You can no longer change this Playlist."
          : FAILURE_MESSAGES[result.failure]
      );
    }
    setPending(false);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [id] = next.splice(index, 1);
    if (id !== undefined) {
      next.splice(index + by, 0, id);
      void change(next);
    }
  };
  const members = new Set(ids);
  return (
    <section aria-labelledby="members-heading" {...stylex.props(layout.stack4)}>
      <div {...stylex.props(styles.header)}>
        <h2 {...stylex.props(type.lg, type.medium)} id="members-heading">
          Sets
        </h2>
        <Button
          onClick={() => {
            setAdding(true);
          }}
          variant="outline"
        >
          Add Sets…
        </Button>
      </div>
      <Problem message={problem} />
      {playlist.sets.length === 0 ? (
        <p {...stylex.props(type.muted, type.sm)}>
          This Playlist has no Sets yet.
        </p>
      ) : (
        <ol aria-label="Sets in this Playlist">
          {playlist.sets.map((set, index) => (
            <li {...stylex.props(styles.row, layout.divided)} key={set.id}>
              <span
                {...stylex.props(
                  type.muted,
                  styles.position,
                  type.sm,
                  type.tabular
                )}
              >
                {index + 1}
              </span>
              <span {...stylex.props(layout.fill, type.truncate, type.medium)}>
                {set.title}
              </span>
              <Button
                aria-label={`Move ${set.title} up`}
                disabled={pending || index === 0}
                onClick={() => {
                  move(index, -1);
                }}
                size="icon"
                variant="ghost"
              >
                <Icon glyph={ArrowUpIcon} />
              </Button>
              <Button
                aria-label={`Move ${set.title} down`}
                disabled={pending || index === playlist.sets.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
                size="icon"
                variant="ghost"
              >
                <Icon glyph={ArrowDownIcon} />
              </Button>
              <Button
                aria-label={`Remove ${set.title} from ${playlist.name}`}
                disabled={pending}
                onClick={detach(async () => {
                  await change(ids.filter((id) => id !== set.id));
                })}
                size="sm"
                variant="outline"
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}
      {adding ? (
        <AddSetsDialog
          candidates={library.filter((set) => !members.has(set.id))}
          emptyLibrary={library.length === 0}
          onAdd={async (setIds) => {
            await change([...ids, ...setIds]);
          }}
          onClose={() => {
            setAdding(false);
          }}
          pending={pending}
          playlistName={playlist.name}
        />
      ) : null}
    </section>
  );
};
