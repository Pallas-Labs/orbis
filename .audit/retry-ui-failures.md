# Playback retry UI failures

Write the journeys before the production retry fix. Both journeys use a Set whose database says its audio is ready while its retained file is absent. The seed then restores that file without changing the player.

- Detail Play can call resume on a failed AVPlayerItem. It changes the apparent playback state without replacing the failed item, so elapsed time never advances.
- Now Playing Play uses the same resume path and can leave the failed item installed after the file becomes available.
- A test that only checks the Pause label can pass while playback remains stopped. Require elapsed time to advance twice after retry.
- A missing fixture or an unavailable service can masquerade as the expected playback failure. Require the ready audio metadata before launch and restore the retained file through the seed service before retry.
- Failed assertions can lose the useful screen and timeline. Attach JSON and a screenshot after the failure and after the retry, including the elapsed observations and error presence.
- The two journeys must use separate Sets and source URLs so parallel workers do not mutate the same fixture.
