import { isDownloadInFlight, isDownloadSettled } from "@orbis/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { audioState } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import type { Credentials } from "@/lib/orbis";

const POLL_MS = 1500;

/**
 * Polls the Downloads still in flight and returns each one's fraction received.
 * When any of them settles, the page's loaders re-run so the list shows the result.
 */
export const useDownloadProgress = (
  { apiUrl, key }: Credentials,
  sets: readonly SavedSet[]
): ReadonlyMap<string, number> => {
  const router = useRouter();
  const [progress, setProgress] = useState<ReadonlyMap<string, number>>(
    new Map()
  );
  const watched = sets
    .filter((set) => isDownloadInFlight(set.downloadState))
    .map((set) => set.id)
    .join(",");
  useEffect(() => {
    if (watched === "") {
      return;
    }
    const ids = watched.split(",");
    let stopped = false;
    let polling = false;
    const poll = async () => {
      // oxlint-disable-next-line orbis/bounded-concurrency -- one small read for each Download in flight on this page, and the next poll waits for this one.
      const states = await Promise.all(
        ids.map(async (id) => ({
          id,
          result: await audioState({ apiUrl, key }, id),
        }))
      );
      if (stopped) {
        return;
      }
      const next = new Map<string, number>();
      let settled = false;
      for (const { id, result } of states) {
        if (!result.ok) {
          continue;
        }
        const { bytesReceived, bytesTotal, state } = result.value;
        if (isDownloadSettled(state)) {
          settled = true;
        } else if (bytesTotal !== null && bytesTotal > 0) {
          next.set(id, bytesReceived / bytesTotal);
        }
      }
      setProgress(next);
      if (settled) {
        await router.invalidate();
      }
    };
    // A tick while a poll still waits for its answers does nothing, so polls never stack.
    const tick = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        await poll();
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apiUrl, key, router, watched]);
  return progress;
};
