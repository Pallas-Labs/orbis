/** The seconds of one Set one Person heard on one UTC day. */
export interface ListeningDay {
  readonly setId: string;
  /** The UTC day, as `YYYY-MM-DD`. */
  readonly day: string;
  readonly seconds: number;
}

export const HEAVY_ROTATION = {
  /** A day with less of a Set than this was a skim, and does not count. */
  floorSeconds: 120,
  /** The most Sets the shelf shows. */
  limit: 8,
  /**
   * The longest forward step between two saved Playback Positions that counts as listening.
   * Clients save every five seconds while a Set plays, so a longer step is a seek.
   */
  maxStepSeconds: 60,
  /** With fewer Sets than this, the shelf is hidden. */
  minimumSets: 3,
  /** The weight of the oldest day in the window; today weighs 1. */
  oldestWeight: 0.5,
  /** Today and the 29 days before it. */
  windowDays: 30,
} as const;

const DAY_MS = 86_400_000;

/** The UTC day a moment falls on, as `YYYY-MM-DD`. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The seconds heard between two saved Playback Positions: a short step forward, or nothing. */
export const listenedBetween = (from: number, to: number): number => {
  const step = to - from;
  return step > 0 && step <= HEAVY_ROTATION.maxStepSeconds ? step : 0;
};

/** The first day the window holds. */
export const windowStart = (now: Date): string =>
  utcDay(new Date(now.getTime() - (HEAVY_ROTATION.windowDays - 1) * DAY_MS));

/**
 * The Sets on the Heavy Rotation shelf, most heard first: listening time over the last 30 days,
 * where a day under the floor does not count and a recent day weighs a little more than an old
 * one. Empty when fewer than three Sets qualify.
 */
export const heavyRotation = (
  days: readonly ListeningDay[],
  now: Date
): string[] => {
  const today = Date.parse(utcDay(now));
  const scores = new Map<string, number>();
  for (const entry of days) {
    const age = Math.round((today - Date.parse(entry.day)) / DAY_MS);
    if (
      age < 0 ||
      age >= HEAVY_ROTATION.windowDays ||
      entry.seconds < HEAVY_ROTATION.floorSeconds
    ) {
      continue;
    }
    const weight =
      1 -
      ((1 - HEAVY_ROTATION.oldestWeight) * age) /
        (HEAVY_ROTATION.windowDays - 1);
    scores.set(
      entry.setId,
      (scores.get(entry.setId) ?? 0) + entry.seconds * weight
    );
  }
  if (scores.size < HEAVY_ROTATION.minimumSets) {
    return [];
  }
  const ranked = [...scores];
  ranked.sort(([a, left], [b, right]) => right - left || a.localeCompare(b));
  return ranked.slice(0, HEAVY_ROTATION.limit).map(([setId]) => setId);
};
