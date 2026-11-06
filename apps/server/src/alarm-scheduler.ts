/** Where one owner of the alarm keeps its time. Presence's alarm option has this shape. */
export interface AlarmSlot {
  readonly set: (at: number) => Promise<void>;
  readonly cancel: () => Promise<void>;
}

export interface AlarmStorage {
  readonly setAlarm: (at: number) => Promise<void>;
  readonly deleteAlarm: () => Promise<void>;
}

/**
 * Shares the Group's single alarm among its owners. Each owner states only its own next time;
 * the storage holds the earliest of them, so one owner can never move or delete another's wake.
 * When the alarm runs, every owner is asked for its next time again.
 *
 * Every owner states its time when the Group starts, so the scheduler does not read the alarm
 * an earlier instance left: its first write replaces it.
 */
export const makeAlarmScheduler = (storage: AlarmStorage) => {
  const times = new Map<string, number>();
  // Undefined until the first write, so the first write always happens.
  let stored: number | null | undefined;
  let writes: Promise<void> = Promise.resolve();

  const earliest = () =>
    times.size === 0 ? null : Math.min(...times.values());

  const write = async (previous: Promise<void>) => {
    try {
      await previous;
    } catch {
      // The previous caller already received its failure.
    }
    const at = earliest();
    if (at === stored) {
      return;
    }
    await (at === null ? storage.deleteAlarm() : storage.setAlarm(at));
    // Set only after success, so a refused write is tried again on the next sync.
    stored = at;
  };

  /** Writes the earliest time if the storage holds another. Writes run one at a time. */
  const sync = async (): Promise<void> => {
    writes = write(writes);
    return await writes;
  };

  const slot = (owner: string): AlarmSlot => ({
    cancel: async () => {
      times.delete(owner);
      return await sync();
    },
    set: async (at) => {
      times.set(owner, at);
      return await sync();
    },
  });

  /** The alarm has run and the storage holds none. Times it served are dropped. */
  const fired = (now: number) => {
    stored = null;
    for (const [owner, at] of times) {
      if (at <= now) {
        times.delete(owner);
      }
    }
  };

  return { fired, slot, sync };
};
