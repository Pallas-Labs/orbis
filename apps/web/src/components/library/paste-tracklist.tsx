import type { Tracklist } from "@orbis/contracts";
import { useState } from "react";

import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Credentials } from "@/lib/orbis";
import { pasteTracklist } from "@/lib/tracklists";
import { useApiCall } from "@/lib/use-api-call";

const PasteTracklistDialog = ({
  credentials,
  onClose,
  setId,
}: {
  readonly credentials: Credentials;
  readonly onClose: () => void;
  readonly setId: string;
}) => {
  const [text, setText] = useState("");
  const { busy, change, problem, refuse } = useApiCall();
  const save = async () => {
    if (
      (await change(() => pasteTracklist(credentials, setId, text))) !== null
    ) {
      onClose();
    }
  };
  return (
    <Dialog onOpenChange={(open) => (open || busy ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste tracklist</DialogTitle>
          <DialogDescription id="paste-tracklist-help">
            One track per line, such as 12:15 Artist - Title. It replaces this
            Set&apos;s Tracklist.
          </DialogDescription>
        </DialogHeader>
        <textarea
          aria-describedby="paste-tracklist-help"
          aria-label="Tracklist text"
          className="bg-input/50 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 min-h-48 w-full rounded-xl border border-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:ring-3"
          onChange={(event) => {
            setText(event.target.value);
            refuse(null);
          }}
          placeholder={"12:15 PLAX - Cursed\n1:02:05 Jeno - Oldskool"}
          value={text}
        />
        <Problem message={problem} />
        <DialogFooter>
          <Button disabled={busy || text.trim() === ""} onClick={save}>
            Save tracklist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The "Paste tracklist" action. It is absent while a Tracklist is still being read. */
export const PasteTracklist = ({
  credentials,
  setId,
  state,
}: {
  readonly credentials: Credentials;
  readonly setId: string;
  /** Null when the Tracklist did not load. */
  readonly state: Tracklist["state"] | null;
}) => {
  const [open, setOpen] = useState(false);
  if (state === null || state === "pending") {
    return null;
  }
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline">
        Paste tracklist
      </Button>
      {open ? (
        <PasteTracklistDialog
          credentials={credentials}
          onClose={() => setOpen(false)}
          setId={setId}
        />
      ) : null}
    </>
  );
};
