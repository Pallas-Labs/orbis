const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export const formatDate = (iso: string): string =>
  dateFormat.format(new Date(iso));

/** When a key was last used, such as "Last used Oct 10, 2026". */
export const lastUsedText = (iso: string | null): string =>
  iso === null ? "Never used" : `Last used ${formatDate(iso)}`;

const ageFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** How long ago something short-lived happened, such as "12 seconds ago". */
export const ageText = (iso: string, now: number = Date.now()): string => {
  const seconds = Math.max(1, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 60
    ? ageFormat.format(-seconds, "second")
    : ageFormat.format(-Math.floor(seconds / 60), "minute");
};
