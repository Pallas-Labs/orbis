/**
 * Wraps an async event handler so the event gets the `void` it expects. Each handler shows its
 * own failure as a problem on the page, so nothing waits for the promise.
 */
export const detach =
  <Args extends unknown[], Result>(
    handler: (...args: Args) => Promise<Result>
  ) =>
  (...args: Args): void => {
    void handler(...args);
  };
