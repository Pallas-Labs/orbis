**Reviewer model:** Opus 5.5 (`claude-opus-5-5`). This was a read-only review. I made no edits and ran no builds, tests, SSH or PR actions.

**Source pin:** The working tree matches `/home/parth/.cache/orbis-playback-evidence/2026-10-18/logging/source-manifest.sha256`. I checked the hashes of AudioPlayer, PlaybackDiagnostics, AppModel, SettingsView, the 3 native test files and PlaybackReportUITests.

## Source verdict

**Acceptable, with 2 Medium usefulness issues to fix before calling the report useful in production.** I found no High issue and no privacy defect. The parent owns runtime acceptance, and nothing below depends on it.

These parts check out:

- **Privacy:** Report fields hold only enums, booleans, counts and finite numbers. `Finite` turns NaN and ±Infinity into `null` (`PlaybackDiagnostics.swift:7-31`). No Set id, title, URL, token, SDK description or error comment can reach the report. Unified-log errors now print only `domain=… code=…` (`AudioPlayer.swift:1180-1193`).
- **Isolation:** `AudioPlayer` is `@MainActor` (line 29) and solely owns the non-Sendable recorder. Each callback that records something reaches the main actor through `.main`-queue `assumeIsolated` or a `Task { @MainActor }` with a generation guard.
  - The route-change handler (1392-1412) now enters `assumeIsolated` for every route reason. This is safe because it registers with `queue: .main`.
- **Stale completions:**
  - The session-end task checks `diagnosticsEpoch` (`AudioPlayer.swift:813-820`).
  - Sign-out increases `playGeneration`, clears the pending activation, then calls `stop()` and then `resetDiagnostics()` (`AppModel.swift:468-473`). A late cancelled or failed result therefore cannot write into the cleared report.
  - Superseded and accepted are each recorded once per generation.
- **Command origin:** next/previous Cue is recorded before it delegates to seek. When there are no Cues, the remote fallback records `nextCue`/`previousCue` from `systemRemote`, then an internal skip (`AudioPlayer.swift:1316-1336`). AppModel's internal pauses (913, 1103) are marked `internalOperation`. The calls at 900-901 and 1004-1005 keep the `.app` origin, which is correct because they come from the person's taps.
- **Detection:** The discontinuity threshold (|gap| > 0.75 s across 0.5 s ticks, line 1113) catches the 1–2 s jumps and repeats the user reported.

## Findings

**Medium 1: a full report keeps about 128 entries, not 256, and the docs say 256.**

- `PlaybackDiagnostics.swift:318-321` removes half of the remaining entries each time the encoded report is too large.
- Line 334 encodes with `.prettyPrinted`, and every entry carries a full snapshot of about 17 keys, plus access metrics and up to 8 ranges.
- By my hand count (not run), one entry is about 1.2–1.7 KB. 256 entries come to about 300–430 KB, which is over the 256 KiB cap. One halving then leaves 128 entries, even when about 200 would fit.
- `docs/development.md:123` says "holds the newest 256 entries".
- The test (`PlaybackDiagnosticsTests.swift:15-35`) uses a 4 KiB cap, empty snapshots and `evictedCount > 44`, so it cannot catch this.
- Fix: drop `.prettyPrinted`, which likely makes 256 entries fit, and trim by measured size or binary search on the count instead of halving. Then either reword the doc or add a realistic test with 256 full snapshots at the real cap.

**Medium 2: periodic samples push incidents out of the history.**

- During steady playback, `recordPeriodicSnapshotIfNeeded` (`AudioPlayer.swift:1091-1096`) adds about 12 entries a minute. 256 entries hold about 21 minutes, and about 10 minutes after Medium 1's halving.
- If the person copies the report more than about 10 minutes after a jump, sample entries can have already pushed the jump out.
- Fix: evict sample entries before other events, merge runs of samples, or sample every 15–30 s while there is no waiting state.

**Low**

1. **Error codes lose detail.**
   - `NormalizedError` (`PlaybackDiagnostics.swift:61-63`) drops `NSUnderlyingErrorKey`. For AVFoundation −11800/−11819 errors, the underlying code is the useful part. Add one underlying domain/code pair; it is still a fixed scalar.
   - The `Item failed` log line (`AudioPlayer.swift:839-843`) falls back to the error-log HTTP status only when `item.error` is nil. The old code added that status in all cases. The separate `.error` event from the new error-log entry (1040-1050) mostly makes up for this.
2. **Some activations have no outcome entry.** At `AppModel.swift:939`, `1126` and `1187`, the `!Task.isCancelled` guard returns early while the generation is still current. The report then shows `began` with no `cancelled` entry.
3. **The Copy button stays "Copied".** It never changes back while the sheet is open (`SettingsView.swift:100-105`). A second copy gives no visible or haptic feedback, so the person cannot tell whether a newer report was copied.
4. **Two audit notes overclaim.** `.audit/playback-logging-failures.md:8` and `.audit/playback-logging-design.md:27` still say samples happen "including while waiting". The code cannot do this, because the periodic observer does not fire while media time is still. `docs/development.md` is already correct.
5. **Two kinds of jump can go unmarked.**
   - Waiting clears `timelineSample`, so a jump across a stall is not flagged as a discontinuity.
   - `timeJumped.seekID` is set only while `isSeeking` (1065-1067). A jump notice that arrives after the seek finishes looks unrelated to the seek, so readers must match it with the nearby `seekResult` by hand.
6. **Small extra work.** Every record calls `item.accessLog()` and copies the ranges (`diagnosticSnapshot`). The cost is small and is not a blocker.

## Test coverage gaps

All 6 checks planned in the failures doc exist. None of the following is tested:

- Remote origin, or the Cue and no-Cue fallback command events.
- The superseded, cancelled or failed activation outcomes. Only begin, intent change and accepted are checked (`PlaybackReliabilityTests.swift:327-335`).
- Clearing the report on sign-out.
- The byte cap at realistic size (Medium 1).
- Discontinuity recording.

The privacy test seeds an `NSError` description but no error-log comment. The UI journey proves only the "Copied" label, which matches the design; it does not prove the clipboard contents. The narrowed generation assertion, which checks entries after `installed`, is correct.

## Evidence flags

- I give no runtime verdict. The current full OrbisTests run and the Mac logs were not available to me, and the earlier 127 results do not cover the new code.
- The entry-size and report-size figures are hand estimates from the field layout, not measured.

## Device acceptance still needed

- Copy a report on a physical iPhone after a real 1–2 s jump or repeat. Check that `discontinuity` and `timeJumped` appear, and that the incident is still in the history after about 10 minutes of playback (Medium 2).
- Check that commands from the Lock Screen, Control Center and headset show `systemRemote`.
- Check that a full ring reports how many entries it holds and that the report pastes into a support channel.
- Check that sign-out clears the report on a real device.
- Audible continuity remains unverified, and this change does not claim to fix it.
