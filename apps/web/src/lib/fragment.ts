/**
 * A link's secret rides in its fragment, which the browser never sends to the
 * Worker. Reading it also takes it out of the address bar and this history
 * entry.
 */
export const takeFragment = (): string => {
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname
  );
  return fragment;
};
