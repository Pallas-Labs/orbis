import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
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
import { detach } from "@/lib/detach";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import { replaceSetPlaylists } from "@/lib/playlists";
import type { Playlist } from "@/lib/playlists";
import { layout } from "@/styles/layout";
import { type } from "@/styles/type";

const styles = stylex.create({
  link: { textDecorationLine: "underline" },
});

export const AddToPlaylistDialog = ({
  credentials,
  onClose,
  playlists,
  set,
}: {
  readonly credentials: Credentials;
  readonly onClose: () => void;
  readonly playlists: readonly Playlist[];
  readonly set: SavedSet;
}) => {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    new Set(set.playlistIds)
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(chosen);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setChosen(next);
  };
  const save = async () => {
    setPending(true);
    const result = await replaceSetPlaylists(
      credentials,
      set.id,
      playlists
        .filter((playlist) => chosen.has(playlist.id))
        .map((playlist) => playlist.id)
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
        <DialogHeader>
          <DialogTitle>Add {set.title} to Playlists</DialogTitle>
          <DialogDescription>
            {playlists.length === 0
              ? "You have no Playlists yet."
              : "It goes at the end of each Playlist you add it to. Clear a box to take it out."}
          </DialogDescription>
        </DialogHeader>
        {playlists.length === 0 ? (
          <Link
            {...stylex.props(type.sm, styles.link, layout.focusOutline)}
            to="/playlists"
          >
            Create a Playlist
          </Link>
        ) : (
          <ul aria-label="Your Playlists" {...stylex.props(layout.stack3)}>
            {playlists.map((playlist) => (
              <li key={playlist.id}>
                <label {...stylex.props(type.sm, layout.rowCenter3)}>
                  <Checkbox
                    checked={chosen.has(playlist.id)}
                    onCheckedChange={(checked) => {
                      toggle(playlist.id, checked);
                    }}
                  />
                  {playlist.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <Problem message={problem} />
        {playlists.length === 0 ? null : (
          <DialogFooter>
            <Button disabled={pending} onClick={detach(save)}>
              Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
