import { afterAll, beforeEach, expect, test } from "bun:test";

import { httpStatus, mockFetch, resetRequests } from "./http";
import {
  finalToast,
  installRaycastApi,
  raycast,
  resetRaycast,
  useVicinae,
} from "./raycast-api";

/*
 * Vicinae runs this extension through its own `@raycast/api`. How a command can fail there:
 * - Vicinae's root search has no status bar, so a toast from a command that ends there is
 *   never seen. Such a command shows its outcome as a HUD, which also closes the window.
 * - Vicinae resends a toast only when its style or title changes, so a message set last is
 *   dropped.
 * - A HUD after a failed Sign In would close the form and lose the typed code.
 * - Raycast must keep its toast and show no HUD.
 */

installRaycastApi();

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { SIGN_IN_HINT, settleToast, startToast } =
  await import("../orbis-client");
const { Toast } = await import("@raycast/api");
const saveClipboardModule = await import("../save-clipboard");
const saveClipboard = saveClipboardModule.default;
const saveCurrentTabModule = await import("../save-current-tab");
const saveCurrentTab = saveCurrentTabModule.default;

beforeEach(() => {
  resetRaycast();
  resetRequests();
  useVicinae();
  mockFetch(() => httpStatus(201));
});

test("In Vicinae, Save Clipboard shows the saved Set as a HUD", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";

  await saveClipboard();

  expect(raycast.huds).toEqual([
    "Set saved: https://www.youtube.com/watch?v=abcdefghijk",
  ]);
  expect(finalToast()).toMatchObject({
    message: "https://www.youtube.com/watch?v=abcdefghijk",
    style: "success",
    title: "Set saved",
  });
});

test("In Vicinae, Save Clipboard asks to sign in through a HUD", async () => {
  raycast.preferences = { serviceUrl: "https://orbis.test" };
  raycast.clipboard = "https://youtu.be/abcdefghijk";

  await saveClipboard();

  expect(raycast.huds).toEqual([`Couldn't save this set: ${SIGN_IN_HINT}`]);
  expect(finalToast()).toMatchObject({
    message: SIGN_IN_HINT,
    style: "failure",
  });
});

test("In Vicinae, Save Current Tab shows the saved Set as a HUD", async () => {
  raycast.tabs = [
    { active: true, url: "https://soundcloud.com/artist/track?ref=share" },
  ];

  await saveCurrentTab();

  expect(raycast.huds).toEqual([
    "Set saved: https://soundcloud.com/artist/track",
  ]);
});

test("In Vicinae, Save Current Tab refuses to guess between browser windows", async () => {
  raycast.tabs = [
    { active: true, title: "One", url: "https://youtu.be/abcdefghijk" },
    { active: true, title: "Two", url: "https://youtu.be/bcdefghijkl" },
  ];

  await saveCurrentTab();

  expect(raycast.huds).toEqual([
    "Couldn't tell which window is in front: Click the window with the Set, then try again.",
  ]);
});

test("In Vicinae, a Sign In failure stays on the form with its message", async () => {
  const toast = await startToast("Signing in…");

  await settleToast(
    toast,
    {
      message: "That code is not valid. Get a new one.",
      style: Toast.Style.Failure,
      title: "Couldn't sign in",
    },
    { endsAtRoot: false }
  );

  expect(raycast.huds).toEqual([]);
  expect(finalToast()).toEqual({
    message: "That code is not valid. Get a new one.",
    style: "failure",
    title: "Couldn't sign in",
  });
});

test("In Raycast, Save Clipboard keeps its toast and shows no HUD", async () => {
  resetRaycast();
  raycast.clipboard = "https://youtu.be/abcdefghijk";

  await saveClipboard();

  expect(raycast.huds).toEqual([]);
  expect(finalToast()).toMatchObject({ style: "success", title: "Set saved" });
});
