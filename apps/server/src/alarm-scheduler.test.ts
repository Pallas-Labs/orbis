import { expect, test } from "bun:test";

import { makeAlarmScheduler } from "./alarm-scheduler.js";

// Written before the scheduler: each is a way sharing one alarm could fail that a test rules out.
// - a later import heartbeat replaces an earlier presence deadline, so expiry runs late
// - presence cancelling deletes the alarm while an import still needs its heartbeat
// - an import finishing deletes the presence deadline
// - after the alarm runs, the scheduler believes it is still set and never sets the next one
// - a time the alarm already served is set again in the past, so the alarm runs in a loop
// - a failed write is remembered as written and never tried again
// - an alarm left by an earlier instance survives when no owner needs it

const storage = () => {
  const calls: (number | "delete")[] = [];
  let failNext = false;
  return {
    calls,
    deleteAlarm: () => {
      calls.push("delete");
      return Promise.resolve();
    },
    failNextWrite: () => {
      failNext = true;
    },
    setAlarm: (at: number) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("storage refused"));
      }
      calls.push(at);
      return Promise.resolve();
    },
  };
};

test("the alarm holds the earliest owner's time and survives either owner leaving", async () => {
  const store = storage();
  const scheduler = makeAlarmScheduler(store);
  const presence = scheduler.slot("presence");
  const imports = scheduler.slot("imports");

  await presence.set(1000);
  await imports.set(30_000);
  await imports.set(31_000);
  expect(store.calls).toEqual([1000]);

  await presence.cancel();
  expect(store.calls).toEqual([1000, 31_000]);
  await presence.set(5000);
  await imports.cancel();
  expect(store.calls).toEqual([1000, 31_000, 5000]);
  await presence.cancel();
  expect(store.calls).toEqual([1000, 31_000, 5000, "delete"]);
});

test("after the alarm runs, owners that still need it get it back, and served times are dropped", async () => {
  const store = storage();
  const scheduler = makeAlarmScheduler(store);
  const presence = scheduler.slot("presence");
  const imports = scheduler.slot("imports");
  await imports.set(30_000);
  await presence.set(45_000);

  scheduler.fired(30_000);
  await scheduler.sync();
  expect(store.calls).toEqual([30_000, 45_000]);

  scheduler.fired(45_000);
  await scheduler.sync();
  expect(store.calls).toEqual([30_000, 45_000]);
});

test("an alarm the storage refused is written again on the next change", async () => {
  const store = storage();
  const scheduler = makeAlarmScheduler(store);
  const presence = scheduler.slot("presence");
  store.failNextWrite();
  await expect(presence.set(1000)).rejects.toThrow("storage refused");
  await presence.set(1000);
  expect(store.calls).toEqual([1000]);
});

test("a new instance clears an alarm it inherited when no owner needs one", async () => {
  const store = storage();
  const scheduler = makeAlarmScheduler(store);
  await scheduler.slot("presence").cancel();
  await scheduler.slot("imports").cancel();
  expect(store.calls).toEqual(["delete"]);
});
