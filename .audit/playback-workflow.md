# Playback reliability workflow

The native app must keep the latest command across queue activation, session activation, item readiness and seeks. Real AVPlayer checks must show that initial audio starts at the requested time and that pause remains effective. Native journeys must prove failed-item retries work from the user controls. The unexplained jumps during ordinary streaming require a separate verdict.

1. Read the development map, domain records, existing native tests and server audio handlers.
2. Audit native command ownership and server streaming separately. Design two alternatives, then obtain an independent design verdict.
3. Capture the current native journey and actual AVPlayer failures before production edits. Add deterministic streamed-audio gates and a long Ogg fixture first.
4. Correct HTTP fixture ranges and verify exact returned bytes through the real HTTP application and database.
5. Keep existing model/player ownership. Implement a seek barrier, explicit versus saved start policy, pending sound intent, ordered queue writes and shared failed-item recovery.
6. Check native changes against the original failing probes, existing session/queue behavior, recovery journeys, long Ogg streaming and a real induced buffer underrun.
7. Review correctness, comments and the decision trail independently. Retain logs, actual timeline traces, screenshots and xcresult bundles with commands and revision.
8. Publish reviewable changes and record physical iPhone acceptance separately. Do not claim that simulator continuity proves the reported spontaneous audio skips are fixed.

The work has high verification rigor because it changes asynchronous audio control. Runtime evidence decides each fix. Codec and buffer tuning require a demonstrated failing stream.

The throughput checkpoint is to use the existing native lane and a small fixture with reusable hold/release controls. The same probes run before and after changes. File ownership separates the player, model, UI and test fixture work.
