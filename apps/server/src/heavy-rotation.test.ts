// The Heavy Rotation rule on its own, before any database or HTTP.
//
// Ways it could fail:
// - It ranks by how many days a Set was played instead of how long it was heard,
//   so five skims beat one full Set.
// - A day under the floor still counts, or a day at the floor does not.
// - A day 30 or more days old still counts, or the 30th day back (day 29) is
//   dropped.
// - Recent days weigh nothing extra, or so much that a long Set three weeks
//   ago loses to a short one today.
// - It shows a shelf for one or two Sets, or more Sets than the shelf holds.
// - Two Sets with equal time come back in a different order on each call.
import { expect, test } from "bun:test";

import { HEAVY_ROTATION, heavyRotation } from "./heavy-rotation.js";
import type { ListeningDay } from "./heavy-rotation.js";

const NOW = new Date("2026-11-10T18:00:00.000Z");
const HOUR = 3600;

/** The UTC day `age` days before NOW. */
const daysAgo = (age: number) =>
  new Date(NOW.getTime() - age * 86_400_000).toISOString().slice(0, 10);

const day = (setId: string, age: number, seconds: number): ListeningDay => ({
  day: daysAgo(age),
  seconds,
  setId,
});

/** Three Sets heard for an hour today, to fill the shelf past its minimum. */
const filler = ["x", "y", "z"].map((id) => day(id, 0, HOUR));

test("ranks by listening time, not by how many days a Set was played", () => {
  const ranked = heavyRotation(
    [
      day("full", 3, 3 * HOUR),
      ...[1, 2, 3, 4, 5].map((age) => day("skims", age, 180)),
      day("middle", 2, 2 * HOUR),
      day("short", 1, HOUR / 2),
    ],
    NOW
  );
  expect(ranked).toEqual(["full", "middle", "short", "skims"]);
});

test("a day under the floor does not count, a day at the floor does", () => {
  const ranked = heavyRotation(
    [
      ...filler,
      day("under", 0, HEAVY_ROTATION.floorSeconds - 1),
      day("at", 0, HEAVY_ROTATION.floorSeconds),
    ],
    NOW
  );
  expect(ranked).toEqual(["x", "y", "z", "at"]);
});

test("only the last 30 days count, today being the first", () => {
  const ranked = heavyRotation(
    [
      ...filler,
      day("day 29", 29, HOUR),
      day("day 30", 30, 10 * HOUR),
      day("tomorrow", -1, 10 * HOUR),
    ],
    NOW
  );
  expect(ranked).toEqual(["x", "y", "z", "day 29"]);
});

test("recent days weigh a little more", () => {
  const ranked = heavyRotation(
    [
      day("older, same time", 10, HOUR),
      day("newer, same time", 1, HOUR),
      day("three weeks ago, long", 21, 3 * HOUR),
      day("today, short", 0, 1.5 * HOUR),
    ],
    NOW
  );
  expect(ranked).toEqual([
    "three weeks ago, long",
    "today, short",
    "newer, same time",
    "older, same time",
  ]);
});

test("time on several days adds up for one Set", () => {
  const ranked = heavyRotation(
    [
      day("a", 0, HOUR),
      day("b", 0, HOUR + 60),
      day("c", 0, 30 * 60),
      day("a", 1, 30 * 60),
    ],
    NOW
  );
  expect(ranked).toEqual(["a", "b", "c"]);
});

test("the shelf is empty until three Sets qualify", () => {
  expect(heavyRotation([], NOW)).toEqual([]);
  expect(
    heavyRotation([day("a", 0, HOUR), day("b", 0, 2 * HOUR)], NOW)
  ).toEqual([]);
  expect(
    heavyRotation(
      [
        day("a", 0, HOUR),
        day("b", 0, 2 * HOUR),
        day("skim", 0, 60),
        day("old", 40, HOUR),
      ],
      NOW
    )
  ).toEqual([]);
  expect(
    heavyRotation(
      [day("a", 0, HOUR), day("b", 0, 2 * HOUR), day("c", 0, 3 * HOUR)],
      NOW
    )
  ).toEqual(["c", "b", "a"]);
});

test("the shelf holds at most its limit, and equal time orders by id", () => {
  const ids = Array.from({ length: HEAVY_ROTATION.limit + 2 }, (_, index) =>
    String.fromCodePoint(106 - index)
  );
  const ranked = heavyRotation(
    ids.map((id) => day(id, 0, HOUR)),
    NOW
  );
  const expected = [...ids];
  expected.sort();
  expect(ranked).toEqual(expected.slice(0, HEAVY_ROTATION.limit));
});
