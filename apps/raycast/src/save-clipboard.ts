import { Clipboard, Toast } from "@raycast/api";

import {
  extractSourceUrl,
  finishSave,
  settleCommand,
  startProgressToast,
} from "./orbis-client";

export default async function SaveClipboard() {
  const toast = await startProgressToast();
  const text = await Clipboard.readText();
  if (text === undefined || text.trim() === "") {
    await settleCommand(toast, {
      message: "Copy a YouTube or SoundCloud link first.",
      style: Toast.Style.Failure,
      title: "No link on the clipboard",
    });
    return;
  }
  await finishSave(toast, extractSourceUrl(text));
}
