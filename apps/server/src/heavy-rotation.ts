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
  /**
   * How far a step may differ from the time since the last save and still count as playback.
   * It absorbs the client's timer and the network; a seek or two devices moves much further.
   */
  slackSeconds: 3,
  /** Today and the 29 days before it. */
  windowDays: 30,
} as const;

const DAY_MS = 86_400_000;

/** The UTC day a moment falls on, as `YYYY-MM-DD`. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * The seconds heard between two saved Playback Positions. Only a short step forward that matches
 * the time since the last save is playback, and it never counts more than that time. A seek,
 * a skip while paused, or two devices reporting the same Set credits nothing. `elapsedSeconds` is
 * null when the last save has no time, which credits nothing.
 */
export const listenedBetween = (
  from: number,
  to: number,
  elapsedSeconds: number | null
): number => {
  const step = to - from;
  if (
    elapsedSeconds === null ||
    step <= 0 ||
    step > HEAVY_ROTATION.maxStepSeconds ||
    Math.abs(step - elapsedSeconds) > HEAVY_ROTATION.slackSeconds
  ) {
    return 0;
  }
  return Math.max(Math.min(step, Math.round(elapsedSeconds)), 0);
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
