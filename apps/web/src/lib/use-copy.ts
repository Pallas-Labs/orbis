import { useState } from "react";

/** Copies `text` to the clipboard and remembers whether it worked. */
export const useCopy = (text: string) => {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return { copy, copyText };
};
