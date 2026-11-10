import { BrowserExtension, Toast } from "@raycast/api";

import {
  canonicalSourceUrl,
  finishSave,
  settleCommand,
  startProgressToast,
} from "./orbis-client";

/**
 * `Tab.active` means active in its own window, so each open browser window has one. Only
 * `getContent` without a tab ID reads the focused window, so its `<title>` picks the tab.
 * Returns null when the windows can't be told apart, rather than guessing.
 */
const focusedTab = async (
  active: BrowserExtension.Tab[]
): Promise<BrowserExtension.Tab | null> => {
  if (active.length === 1) {
    return active[0] ?? null;
  }
  let title: string;
  try {
    title = await BrowserExtension.getContent({
      cssSelector: "title",
      format: "text",
    });
  } catch {
    return null;
  }
  const matches = active.filter((tab) => tab.title?.trim() === title.trim());
  const urls = new Set(matches.map((tab) => tab.url));
  return urls.size === 1 ? (matches[0] ?? null) : null;
};

export default async function SaveCurrentTab() {
  const toast = await startProgressToast();
  let tabs: BrowserExtension.Tab[];
  try {
    tabs = await BrowserExtension.getTabs();
  } catch (error) {
    await settleCommand(toast, {
      message:
        error instanceof Error
          ? error.message
          : "Raycast's browser extension didn't answer.",
      style: Toast.Style.Failure,
      title: "Couldn't read the current tab",
    });
    return;
  }
  const active = tabs.filter((tab) => tab.active);
  if (active.length === 0) {
    await settleCommand(toast, {
      message: "Open a browser tab and try again.",
      style: Toast.Style.Failure,
      title: "No active tab",
    });
    return;
  }
  const tab = await focusedTab(active);
  if (!tab) {
    await settleCommand(toast, {
      message: "Click the window with the Set, then try again.",
      style: Toast.Style.Failure,
      title: "Couldn't tell which window is in front",
    });
    return;
  }
  await finishSave(toast, canonicalSourceUrl(tab.url));
}
