# Run the Orbis audio node on Vanta

The production API and database moved to the Cloudflare Group on 2026-10-03. Vanta runs the database-free audio node as the existing systemd user service at `127.0.0.1:4311`. The Funnel on port `10000` serves audio and forwards old `/api` requests to the Group. The web client runs on Cloudflare.

For Cloudflare deployment, use the [API deploy README](../../apps/api/README.md). For Group backup recovery, use [Transfer and restore Group data](../../docs/data-transfer.md).

## Production files and services

| Path | Purpose |
| --- | --- |
| `~/Developer/orbis-service` | Production checkout. |
| `~/Developer/orbis-service-data` | Retained Audio, stream secret, and canary records. The pre-cutover SQLite database and trust files are rollback records, not live Group data. |
| `~/.config/systemd/user/orbis-server.service` | Installed service and its drop-ins. The production entrypoint is `src/node.ts`. |

Keep the installed service, its drop-ins, and the backup and canary timers. Caddy reserves Tailscale port `443`. Keep the Jellyfin Funnel on `8443`.

## Secrets

`apps/server/.env.schema` names every provider setting and key. The keys live in the 1Password vault `Vanta Services` (`orbis-youtube`, `orbis-cobalt`, `orbis-openrouter`, `orbis-node`, field `credential`), read by the Vanta read-only service account. `orbis-server`, `orbis-canary`, and `orbis-backup` start through `~/.local/share/mise/shims/varlock run`, which resolves the schema, caches values for an hour, and refuses to start when a value is missing. Every value is required, so each `varlock run` in `apps/server` needs `ORBIS_NODE_KEY` too. After a key changes in 1Password, restart the unit once with `varlock run --clear-cache`, or wait out the cache. No file on Vanta holds these values.

The Cloudflare deploy reads the same keys: run `~/vanta-stack/deploy/orbis-deploy.ts` under `varlock run --path <checkout>/apps/server/`, as its header shows.

## Run the audio node

For a standalone audio-node process, run `bun run node` from `apps/server`. Build its entrypoint with `bun run build` and start the result with `bun dist/node.js`.

Set `ORBIS_GROUP_URL` to the API base URL, such as `https://orbis.p11a.xyz/api`, and keep the imported node key in 1Password, where the schema loads it as `ORBIS_NODE_KEY`. [Transfer and restore Group data](../../docs/data-transfer.md#import-into-an-empty-group) covers node-key creation for migration. The Group accepts that key on `/api/node`. It does not grant client API access.

Set `ORBIS_AUDIO_DIR` to the existing audio directory and `ORBIS_STREAM_SECRET_FILE` to the existing 32-byte `stream-grant.key` file. The node refuses to start if that secret is missing or has the wrong size. `ORBIS_NODE_HOST` and `ORBIS_NODE_PORT` default to `127.0.0.1` and `4311`.

The installed node keeps `ORBIS_API_FORWARD_URL=https://orbis.p11a.xyz/api` for older clients. The listener serves grant-authorized audio and forwards every other API request without a local database or trust store. Retire forwarding only after the [forwarding retirement checks](#retire-api-forwarding) pass. Keep the existing provider settings, yt-dlp binary, cookies, ffprobe, and ffmpeg.

The node opens an outbound WebSocket and reconnects with exponential backoff, capped at 30 seconds. Its files are its only persistent state. Each connection reports validated audio files. The Group reconciles missing and unreferenced files and resumes interrupted Downloads using the existing job rows. Download commands and replies carry a Set ID and a request ID; a result from a canceled attempt cannot finish a later attempt.

Set `ORBIS_OTLP_LOGS_URL` to SigNoz's local collector, `http://127.0.0.1:4318/v1/logs`, to send the node's events to SigNoz as well as the journal. When the variable is unset, the node logs only to the journal. [Send events to SigNoz](#send-events-to-signoz) lists where to set it.

Run `bun run --cwd apps/api test:node` to exercise the local Group with a fake node and the built node process. The journey writes a protocol transcript and process log under `.cache/audio-node/<run>/`, including a forced process stop, recovery of the same job, progress through the API, and file deletion after removing the Library Entry. It needs ffmpeg and ffprobe on `PATH`.

## Analyse each Set's tempo and loudness

After each new Download, the node runs `orbis-analyze` on the file, at `nice 19` and one Set at a time, and writes `<set id>.analysis.json` beside the audio. It then sends the analysis to the Group, which stores it in `set_analysis` and returns it as `analysis` from `GET /api/sets/<id>`. After each inventory, the node also sends every stored analysis, so a report that a lost link dropped arrives on the next connection. A release deletes the analysis with the audio. Each run writes one `job: audio-analysis` event. A failure or a timeout after 2 hours ends there; it never changes the Download. Without `ORBIS_ANALYZE_BIN`, the node analyses nothing.

`orbis-analyze` is the Python program in [`apps/server/analysis`](../../apps/server/analysis). It runs beat_this `final0` on the CPU in 10-minute chunks and ffmpeg's `ebur128` filter. It takes about 9 minutes of wall time per hour of audio on a busy Vanta (980 s for a 113-minute Set at load 40 on 2026-11-12) and about 450 MB of RAM.

- **Python.** `uv` installs Python 3.12 and the locked packages, CPU-only torch included, into `apps/server/analysis/.venv` of the production checkout. Run `uv sync --frozen --project apps/server/analysis` after each checkout update. The program is `apps/server/analysis/.venv/bin/orbis-analyze`. Its shebang names the venv's Python, so the node needs no Python on `PATH`. Set `ORBIS_ANALYZE_BIN` to that path.
- **The model file.** `ORBIS_ANALYZE_CHECKPOINT` names the beat_this `final0` checkpoint file. `orbis-analyze` refuses a file whose SHA-256 differs from `CHECKPOINT_SHA256` in [`analyze.py`](../../apps/server/analysis/orbis_analysis/analyze.py). It never downloads the file. To get it, download `https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt` once, check it with `sha256sum`, and keep it beside the audio directory, for example at `~/Developer/orbis-service-data/models/beat_this-final0.ckpt`. On 2026-11-12 Vanta had a copy at `~/.cache/torch/hub/checkpoints/beat_this-final0.ckpt`.
- **ffmpeg.** `orbis-analyze` runs `ffmpeg` from `PATH`, the same one the node uses to validate Downloads. `ORBIS_FFMPEG` names another one. `nice` comes from coreutils.
- **Threads.** `ORBIS_ANALYZE_THREADS` caps torch's CPU threads at 4 by default.

Set `ORBIS_ANALYZE_BIN` and `ORBIS_ANALYZE_CHECKPOINT` in a drop-in for `orbis-server`, next to `ORBIS_YTDLP_BIN`, and restart the unit in the update window. To check the installation without the node, run the program on one file:

```sh
cd ~/Developer/orbis-service
ORBIS_ANALYZE_CHECKPOINT=<checkpoint> apps/server/analysis/.venv/bin/orbis-analyze \
  ~/Developer/orbis-service-data/audio/<set id>.ogg /tmp/check.analysis.json
```

`python -m orbis_analysis.check_reference <audio dir> <out dir>`, run from `apps/server/analysis` with the venv's Python, checks the program against the four reference Sets of the 2026-11-11 audio research. Each median BPM must be within 1.5, and the Rinse FM Set's five sections must start within 1 minute of the About This Set prototype.

### Analyse the Retained Audio already on the node

`python -m orbis_analysis.backfill <audio dir> [<library-run results dir>]` writes the missing `<set id>.analysis.json` files. The node reports them on its next connection. It imports a Set that has 2026-11-11 library-run results (`<id>.beatthis.beats.npy` and `<id>.loudness.json`, in `~/.cache/orbis-audio-intel-2026-11-11/out/dglib/` on Vanta), using the same line fit. Every other Set runs `orbis-analyze` at `nice 19`. The script skips a Set that already has a file, so a second run analyses only what is new. It prints one JSON line per Set and a summary with the imported, analysed, failed, and skipped counts and the wall time.

```sh
cd ~/Developer/orbis-service/apps/server/analysis
ORBIS_ANALYZE_CHECKPOINT=<checkpoint> .venv/bin/python -m orbis_analysis.backfill \
  ~/Developer/orbis-service-data/audio ~/.cache/orbis-audio-intel-2026-11-11/out/dglib
```

## Update the installed service

Use the approved Vanta update window. Preserve the installed unit and drop-ins.

1. Check the installed unit's `WorkingDirectory` and `ExecStart` with `systemctl --user cat orbis-server`. Confirm the production checkout and audio-node entrypoint without printing private environment files.
2. Update that checkout to the approved revision. Use the unit's exact Bun executable for the frozen install and shared-contract build, and match that path to `packageManager` in `package.json`. The frozen install also installs the 1Password plugin that the schema needs. Complete both before restarting.
3. Record `systemctl --user show orbis-server -p InvocationID --value`, restart the existing service, and confirm its new invocation and active status.
4. Check [API forwarding](#check-the-api-and-forwarding), authenticated audio playback, and the [download canary](#check-downloads-every-night). Record the deployed commit and results. If rollout was not performed, state that on the issue or PR.

## Enrol a device

A new Person joins with their username and the Group Passcode, which Orbis makes when the Host turns on Allow Joining in Settings. A Person adds another device with a Sign-in Code shown on a device they already use. Each device receives its own daily key. If the Host has no signed-in device left, run `trust recover` on Vanta as the [API README](../../apps/api/README.md#recover-host-access) describes. See [Sign in with a Group Passcode or a Sign-in Code](../../docs/adr/0020-sign-in-by-group-passcode-and-sign-in-code.md).

## Check the API and forwarding

`GET /api/health` is public on the Group and returns `200`. While forwarding is active, the old Funnel health address also returns `200` without a key. Health alone does not verify authentication or audio playback.

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://orbis.p11a.xyz/api/health
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://<funnel-host>:10000/api/health
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  -H "Authorization: Bearer $ORBIS_DEVICE_TOKEN" \
  https://<funnel-host>:10000/api/sets
```

Expect `200` for both health requests and for `/api/sets` with a valid daily key. Inject the existing key without printing it or saving response data. On `/api/sets`, a missing key returns `403`, an invalid key returns `401`, and a node key returns `403`. Audio requires a signed stream grant from the Group.

## Check downloads every night

`apps/server/src/canary.ts` downloads a short and a long Set per source through each configured backend, using the worker's own code, and checks that each stored file has the expected duration. It catches a backend that stops working before a user's download does: on 2026-09-29, Cobalt returned empty YouTube streams for long videos while short ones still worked.

Keep the existing canary service and timer. Do not recopy the repository templates over them. For a first install, adapt `orbis-canary.service` before installing it and its timer. Set `WorkingDirectory=%h/Developer/orbis-service/apps/server` and `ORBIS_DATA_DIR=%h/Developer/orbis-service-data`. Start `src/canary.ts` with the Bun binary that matches `packageManager`, through `varlock run` (see [Secrets](#secrets)), and preserve the yt-dlp settings.

For installed units, check and run the timer:

```sh
systemctl --user daemon-reload
systemctl --user enable --now orbis-canary.timer
systemctl --user start orbis-canary.service   # first run now; takes a few minutes
```

It downloads about 400 MB a night and keeps none of it.

`last.json` records `ok`, which is true only when every check passed, and `sourcesWithoutBackend`, the sources for which no backend downloaded a fixture. The canary's event is an `error` only when `sourcesWithoutBackend` is not empty, because users then cannot download from that source. When a source still downloads through one backend but another backend fails, the event is a `warn`: the source has lost its fallback. The unit fails whenever `ok` is false.

## Send events to SigNoz

SigNoz runs on Vanta and accepts OTLP/HTTP logs at `127.0.0.1:4318`. Every event has `service.name=orbis` and an `orbis.component` resource attribute: `node`, `canary`, or `group`.

Add this line to the environment of both `orbis-server` and `orbis-canary`, for example in a drop-in, then restart each in the update window:

```sh
ORBIS_OTLP_LOGS_URL=http://127.0.0.1:4318/v1/logs
```

The Group on Cloudflare sends its events through the Access-protected endpoint that the playback relay uses, with the same `SIGNOZ_OTLP_*` bindings. [Worker configuration](../../apps/api/README.md#worker-configuration) names them. Each process sends events in batches of up to 50, at least every 5 seconds. A batch that fails three tries is dropped with one console warning and does not change the request or the download.

## Where to look when a download fails

Each record below is written for an agent to read without extra setup. The service and the canary log one JSON object per line when stdout is not a terminal, as under systemd.

```sh
# Did last night's canary pass, and when did it start failing?
cat ~/Developer/orbis-service-data/canary/last.json
jq -c '{at, ok}' ~/Developer/orbis-service-data/canary/history.jsonl | tail

# Is any unit failing?
systemctl --user --failed

# Why did a download fail? One wide event per download.
journalctl --user -u orbis-server --since today -o cat |
  jq -cR 'fromjson? | select(.job == "audio-download" and .outcome != "success")'

# What did the canary see?
journalctl --user -u orbis-canary --since today -o cat |
  jq -cR 'fromjson? | select(.job == "download-canary")'
```

In SigNoz, filter the logs on `service.name = orbis` and `severity_text = ERROR` to see everything a person should look at. Filter on `event` or `job` to follow one kind of event, and on `requestId` to follow one download from the Group to the node.

| Name | Component | Level | Fields |
| --- | --- | --- | --- |
| `job: audio-download` | node | `info`; `error` on failure | `set`, `source`, `requestId`, `outcome`, `backend`, `attempts` (`backend`, `ok`, `reason`), `logs` |
| `event: node-link-connected` | node | `info` | `files` (inventory size), `attempt` (failed tries before this one) |
| `event: node-link-closed` | node | `warn`; `info` at shutdown | `code`, `reason`, `heartbeatTimedOut` |
| `event: node-link-reconnecting` | node | `info`; `error` from the fifth failed try in a row | `attempt`, `delayMs`, `connectFailed` |
| `event: group-node-accepted` | group | `info` | `replaced` (earlier sockets closed) |
| `event: group-node-disconnected` | group | `warn`; `info` for code 1000 | `code`, `reason`, `ageMs`; no `code` when the node reconnected before the close arrived |
| `event: group-node-replaced-closed` | group | `info` | `code`, `reason`, `ageMs` |
| `event: group-download-started` | group | `info` | `set`, `source`, `requestId` |
| `event: group-download-settled` | group | `info`; `warn` when the node reports a failure | `set`, `requestId`, `outcome` |
| `event: group-downloads-waiting` | group | `warn` | `queued`, `oldestQueuedMs`, `node` (`missing` or `connecting`) |
| `job: download-canary` | canary | `info`; `warn` when a backend failed; `error` when a source has no working backend | `ok`, `failed`, `sourcesWithoutBackend`, `logs` |

`group-node-disconnected` counts each lost link once. The node often sees a drop and reconnects before the Group hears of it, so the Group logs the loss when it accepts the new link. The old link's own close can arrive minutes later; it is `group-node-replaced-closed` and is not a lost link.

`group-downloads-waiting` is the Group's sign that Downloads are queued and no node can take them. The Group checks each time it schedules work, so the event repeats while new work arrives and the node stays away. `oldestQueuedMs` is null for Downloads queued before 2026-10-20.

A download's wide event (`job: audio-download`) lists every backend attempt in `logs`: bytes received, yt-dlp's exit code with the start and end of its error output, Cobalt's tunnel status and content length, and ffprobe's error output. The `stderrHead` annotation names yt-dlp's identifying error; `stderr` keeps the end, where its hint is. The canary's event (`job: download-canary`) holds the same evidence for each check. The startup line `youtube downloads use cobalt only` means `ORBIS_YTDLP_BIN` is missing; see [Check the yt-dlp configuration](#check-the-yt-dlp-configuration).

## Where to look when a Set does not play

Playback crosses two hosts. The Group on Cloudflare answers `GET /api/sets/<id>/audio` with a redirect to this node, and the node serves the file. Each side writes one wide event per request, with an `audio` record. Neither records the grant.

```sh
# What did the node do with the Set's audio requests?
journalctl --user -u orbis-server --since today -o cat |
  jq -cR 'fromjson? | select(.ingress == "funnel-audio" and .audio.set == "<id>") | {timestamp, status, audio}'
```

On the node, `audio.grant` is `valid`, `missing`, `malformed`, `bad-signature`, `expired`, or `future-expiry`. `bad-signature` on every request means the node's grant secret differs from the Group's `STREAM_GRANT_SECRET`; `expired` or `future-expiry` on a fresh grant means the two clocks disagree. `audio.file: missing` means the node has no file for the Set. A served request records `range`, `size`, and `bytes`, the body length the response declares. The node writes a response with a body to the log when the body ends, not when its headers go out: `audio.sent` is the bytes the node handed to the connection, `audio.lastByteMs` is the time from the request to the last byte or to the client leaving, and `audio.aborted` is true when the client left first (`outcome: cancelled`). A 206 whose `sent` equals `bytes` with a small `lastByteMs` left the node whole and at once, so a client that still timed out lost the bytes after the node. A large `lastByteMs` means the connection drained slowly. `sent` counts what entered the socket, so it can run ahead of what the client received by the socket buffers.

On Cloudflare, the Api worker keeps Workers Logs. Filter on `audio.set` in the dashboard's Observability view. `audio.result` is `redirected` (with the `node` origin), `served`, or `refused`, and a refusal's `audio.reason` is `grant-refused` (with `audio.grant`), `set-not-found`, or `no-audio` (with `downloadState`). A request that died records `cause` with the error name and a cleaned message.

## Check the yt-dlp configuration

YouTube downloads try yt-dlp first and fall back to Cobalt. Without `ORBIS_YTDLP_BIN`, every YouTube download goes to Cobalt, whose tunnel returned zero bytes for long videos on 2026-09-29. yt-dlp needs Deno, and the service's default PATH does not include `~/.local/bin`, where `uv tool install` puts both.

Preserve the installed provider drop-ins, `ORBIS_YTDLP_BIN`, PATH, and cookies. The worker logs `ytdlp: true` at startup when the binary is configured.

## Back up the Group

After cutover, the nightly timer calls `scripts/data-transfer.ts backup`, which fetches the Group's SQL export with the node key and retains the newest 14 SQL files. The existing script then rsyncs the staging directory to `ORBIS_BACKUP_DEST`. SQL includes library and trust tables, so new backups do not need `devices.json`.

Keep the installed service, timer, destination, and environment file. Do not recopy the repository templates over them. The existing private environment file needs this value alongside its destination; the node key comes from 1Password through `varlock run --path <checkout>/apps/server/` (see [Secrets](#secrets)):

```sh
ORBIS_GROUP_API_URL=https://orbis.p11a.xyz/api
```

Keep `~/.config/orbis-backup.env` at mode `0600`. Keep the current `ORBIS_BACKUP_STAGING` if one exists. A remote destination requires key-based SSH for the service user. The script does not change the installed units or network configuration.

### Restore

Use [Transfer and restore Group data](../../docs/data-transfer.md#export-and-restore) to restore into a new scratch database and verify it before replacing service data. For a rollback after Group writes, use a current Group export. The Vanta copy from before cutover is stale.

## Retire API forwarding

Forwarded requests emit `ingress: "funnel-forward"` with the key's label, request path, and status. Keys and query strings stay out of the log. Read these events with:

```sh
	journalctl --user -u orbis-server --since '14 days ago' -o cat |
	  jq -cR 'fromjson? | select(.ingress == "funnel-forward") | {timestamp, keyLabel, method, path, status}'
```

An empty result is evidence only when the journal covers the whole interval and forwarding was active throughout it. Keep forwarding until the Host confirms 14 complete days without requests, per [#199](https://github.com/ParthMmm/orbis/issues/199). Group ingress headers are client supplied and cannot establish this evidence. Keep forwarding and the existing Serve mappings until those checks pass.

## Cutover evidence

The 2026-10-03 cutover retained existing key digests and stopped writes for at most 50.441 seconds in the request logs. A Group backup restored successfully, and an Apple build using the old Funnel address played and sought production audio.

The first canary after cutover passed four of six checks because both YouTube yt-dlp downloads required authentication. After the Host supplied fresh cookies, the installed canary service passed all six checks at `2026-10-03T22:50:46.589Z`. Both runs were triggered manually. At that snapshot, the next scheduled run was due at 04:00 PDT. Use the [canary records](#where-to-look-when-a-download-fails) for the latest result and [#195](https://github.com/ParthMmm/orbis/issues/195) for production acceptance.
