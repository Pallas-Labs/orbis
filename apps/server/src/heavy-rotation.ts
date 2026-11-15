/** The seconds of one Set one Person heard on one day in their time zone. */
export interface ListeningDay {
  readonly setId: string;
  /** The day, as `YYYY-MM-DD`. */
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
   * It is also the most a step can count beyond that time.
   */
  slackSeconds: 3,
} as const;

const DAY_MS = 86_400_000;

/** Whether `name` is a time zone this runtime knows, such as `America/Los_Angeles`. */
export const isTimeZone = (name: string): boolean => {
  try {
    // The constructor throws a RangeError for a name it does not know.
    const known = new Intl.DateTimeFormat("en-US", { timeZone: name });
    return known.resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/**
 * The day a moment falls on in a Person's time zone, as `YYYY-MM-DD`. A Person whose client
 * never sent a time zone keeps the UTC day.
 */
export const dayIn = (at: Date, timeZone: string | null): string => {
  if (timeZone === null) {
    return at.toISOString().slice(0, 10);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * The seconds heard between two saved Playback Positions. Only a short step forward that matches
 * the time since the last save is playback, and it counts whole. A seek, a skip while paused, or
 * two devices reporting the same Set credits nothing. `elapsedSeconds` is null when the last save
 * has no time, which credits nothing.
 *
 * The step is the measure, not the time. Positions are whole seconds and the time is not, so a
 * phone's saves 5.3 s apart step 5 s or 6 s; capping each step at the time rounded to a second
 * dropped a second from every longer one, and the steps of a Set played through add up to the
 * seconds played. A step never counts more than one second past the time rounded up, so a client
 * that saves faster than its steps cannot count more than it played.
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
  return Math.min(step, Math.ceil(elapsedSeconds) + 1);
};

/** The first day a range holds, counted back from `today`. */
export const windowStart = (today: string, range: ListeningRange): string =>
  new Date(Date.parse(today) - (LISTENING_RANGES[range].days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** What a Collection asks of the ranking beyond Heavy Rotation's own rule. */
export interface RankingOptions {
  /** With fewer Sets than this, the ranking is empty. Heavy Rotation asks for three. */
  readonly minimumSets?: number;
  /** The least a Set must have been heard over the range, counting only days over the floor. */
  readonly minimumSeconds?: number;
}

/**
 * The Sets in Heavy Rotation over a range, most heard first: listening time in the range, where
 * a day under the floor does not count and a recent day weighs as the range says. `today` is the
 * Person's day, from `dayIn`. Empty when fewer than three Sets qualify, or fewer than
 * `options.minimumSets`.
 */
export const heavyRotation = (
  days: readonly ListeningDay[],
  today: string,
  range: ListeningRange = "month",
  options: RankingOptions = {}
): string[] => {
  const { minimumSeconds = 0, minimumSets = HEAVY_ROTATION.minimumSets } =
    options;
  const { days: windowDays, oldestWeight } = LISTENING_RANGES[range];
  const todayAt = Date.parse(today);
  const scores = new Map<string, number>();
  const heard = new Map<string, number>();
  for (const entry of days) {
    const age = Math.round((todayAt - Date.parse(entry.day)) / DAY_MS);
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
