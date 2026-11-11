/** The seconds of one Set one Person heard on one UTC day. */
export interface ListeningDay {
  readonly setId: string;
  /** The UTC day, as `YYYY-MM-DD`. */
  readonly day: string;
  readonly seconds: number;
}

/**
 * The ranges Heavy Rotation can cover. Each has its length in days, today included, and the
 * weight of its oldest day; today weighs 1 and the weight falls in a straight line between.
 *
 * The weight answers a different question in each range. Thirty days asks what this Person is
 * into now, so a Set heard today counts twice what one heard a month ago does. A year asks what
 * they played most this year, so January counts as much as November, as a year-end list does.
 * Three months sits between them. A year at the month's slope would make a Set heard in January
 * count half of one heard today, and the collection would read as the last few months.
 */
export const LISTENING_RANGES = {
  month: { days: 30, oldestWeight: 0.5 },
  quarter: { days: 90, oldestWeight: 0.75 },
  year: { days: 365, oldestWeight: 1 },
} as const;

export type ListeningRange = keyof typeof LISTENING_RANGES;

export const HEAVY_ROTATION = {
  /** A day with less of a Set than this was a skim, and does not count. */
  floorSeconds: 120,
  /** The most Sets the collection holds. */
  limit: 50,
  /**
   * The longest forward step between two saved Playback Positions that counts as listening.
   * Clients save every five seconds while a Set plays, so a longer step is a seek.
   */
  maxStepSeconds: 60,
  /** With fewer Sets than this, the collection is empty and Home hides its shelf. */
  minimumSets: 3,
  /**
   * How far a step may differ from the time since the last save and still count as playback.
   * It absorbs the client's timer and the network; a seek or two devices moves much further.
   */
  slackSeconds: 3,
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

/** The first day a range holds. */
export const windowStart = (now: Date, range: ListeningRange): string =>
  utcDay(new Date(now.getTime() - (LISTENING_RANGES[range].days - 1) * DAY_MS));

/** What a Collection asks of the ranking beyond Heavy Rotation's own rule. */
export interface RankingOptions {
  /** With fewer Sets than this, the ranking is empty. Heavy Rotation asks for three. */
  readonly minimumSets?: number;
  /** The least a Set must have been heard over the range, counting only days over the floor. */
  readonly minimumSeconds?: number;
}

/**
 * The Sets in Heavy Rotation over a range, most heard first: listening time in the range, where
 * a day under the floor does not count and a recent day weighs as the range says. Empty when
 * fewer than three Sets qualify, or fewer than `options.minimumSets`.
 */
export const heavyRotation = (
  days: readonly ListeningDay[],
  now: Date,
  range: ListeningRange = "month",
  options: RankingOptions = {}
): string[] => {
  const { minimumSeconds = 0, minimumSets = HEAVY_ROTATION.minimumSets } =
    options;
  const { days: windowDays, oldestWeight } = LISTENING_RANGES[range];
  const today = Date.parse(utcDay(now));
  const scores = new Map<string, number>();
  const heard = new Map<string, number>();
  for (const entry of days) {
    const age = Math.round((today - Date.parse(entry.day)) / DAY_MS);
    if (
      age < 0 ||
      age >= windowDays ||
      entry.seconds < HEAVY_ROTATION.floorSeconds
    ) {
      continue;
    }
    const weight = 1 - ((1 - oldestWeight) * age) / (windowDays - 1);
    scores.set(
      entry.setId,
      (scores.get(entry.setId) ?? 0) + entry.seconds * weight
    );
    heard.set(entry.setId, (heard.get(entry.setId) ?? 0) + entry.seconds);
  }
  const ranked = [...scores].filter(
    ([setId]) => (heard.get(setId) ?? 0) >= minimumSeconds
  );
  if (ranked.length < minimumSets) {
    return [];
  }
  ranked.sort(([a, left], [b, right]) => right - left || a.localeCompare(b));
  return ranked.slice(0, HEAVY_ROTATION.limit).map(([setId]) => setId);
};
