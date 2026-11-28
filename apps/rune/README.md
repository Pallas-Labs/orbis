# Orbis for the desktop (Rune)

A desktop client for Orbis, built with [Rune](https://github.com/anomalyco/rune), a GPU-drawn Rust UI framework. It shows the person's Library, Playlists and Listening Queue with their Artwork, plays a Set's Retained Audio, keeps the Playback Position, moves through the queue as each Set ends, tells the Group what it plays, and follows Orbis's live events so changes from other devices show at once. It talks to the same API as the other clients (`packages/contracts/src/http-api.ts`).

It started from the `rune-app` skill's template and pins Rune `268ac7c`, the rev the template pins. Its look takes OpenCode Desktop's sizes (rune-kit's reference) and Orbis's own colours (`docs/design/tokens.json`).

![The Library](shots/library.png)

## Run it

Requires Rust (the toolchain in `apps/rune/rust-toolchain.toml` installs itself through rustup) and, on Linux, the `libxkbcommon` and `wayland` development files. Sound needs `mpv` on `PATH`.

```sh
cd apps/rune
cargo run                                   # the window, online
ORBIS_RUNE_DEMO=1 cargo run                 # the window on made-up data; nothing goes out
cargo run -- --snap out.png --scene playing --at 1.5    # one scene, headless
cargo run -- --list-scenes
```

A plain launch signs in with `ORBIS_URL` and `ORBIS_KEY`, else the key saved in `$XDG_CONFIG_HOME/orbis-rune/config.json` (readable by this user alone), else it shows the sign-in page.

### Against a stand-in Orbis

`apps/rune/scripts/stand-in` starts the repo's disposable fixture server (`scripts/fixture.ts`) with four made-up Sets, three with Retained Audio made from four minutes of silence, and two of them in the queue. It prints the command that opens the window against it, and removes its data when it stops. It needs `bun`, `ffmpeg`, and a built contracts package (`bun run --filter @orbis/contracts build`).

## What it does

### Signing in

A new device signs in one of three ways (ADR 0020): a Sign-in Code from a signed-in device's Settings, an Approval Code this device shows for a signed-in device to approve (it waits on the server's long poll, and shows a new code when one expires), or the Group Passcode, which joins the Group as a new Person. It signs in to `https://orbis.p11a.xyz/api` unless the person names another Orbis. Scenes: `sign-in`, `sign-in-approve`, `sign-in-join`, `sign-in-failed`.

### Library

Every Set the person saved, built only near the viewport, so a long Library scrolls lightly; rows coming into view fetch their Artwork. The search field filters by title, creator and Tag as the person types, and Tag pills narrow it to one Tag. Pressing a Set plays it. Under the pointer or keyboard focus, a playable Set offers Play Next, Add to Queue and its menu; a right-click opens the same menu. The menu also adds the Set to a Playlist, edits its Tags, starts a Download, and removes it from the Library. Save a Link (Ctrl+N) saves a YouTube, SoundCloud or Apple Music link and says whether its Download started. An Apple Music Set plays only in the Apple apps, so this app marks it and doesn't play it.

Scenes: `library`, `library-search`, `library-tag`, `library-menu`, `library-save`, `library-save-failed`, `library-tags`, `library-remove`, `library-empty`, `library-loading`, `library-failed`, `library-long`, `toast`.

### Playlists

The sidebar lists the person's Playlists and the Collaborative ones they edit. A Playlist's page shows a cover of its first four Sets, Play and Shuffle (which replace the Listening Queue), and its Sets. Its creator renames and deletes it. Adding or removing a Set reads the Playlist's members first, so another editor's change isn't lost.

Scenes: `playlist`, `playlist-menu`, `playlist-new`, `playlist-delete`, `playlist-empty`, `playlist-loading`, `playlist-failed`.

### Listening Queue

The active Set, then Up Next, then any Sets earlier in the queue. Pressing a Set plays it and keeps the rest of the queue (ADR 0001). Another device's change arrives on the event stream and shows at once.

Scenes: `queue`, `queue-empty`, `queue-loading`, `queue-failed`.

### Now Playing and the bar

Pressing Play makes the Set the queue's active one and streams it through a stream grant (ADR 0007). Now Playing shows the Set's large Artwork, a seek bar (press, drag, or the arrow keys), Back 15 s, Play and Pause, Ahead 30 s and Next, and the Tracklist with the Cue playing now; pressing a Cue with a start time goes there. In a narrow window the Tracklist moves under the controls. The other screens show the same Set in a bar at the foot.

The app saves the place every 15 s while a Set plays, on pause and when another Set starts. When a save gets no answer, a 429 or a 5xx, the app saves the place again every 15 s until Orbis answers, while that Set stays loaded and not playing. It never resends after a 4xx or after sign-out. When a Set plays out, the app resets its place, tells Orbis it finished, and plays the next Set; at the end of the queue it stops. Closing the window stops the sound.

Scenes: `playing`, `playing-loading`, `playing-failed`, `playing-no-tracklist`, `playing-long`, `playing-empty`.

### The Group

Each Set the player starts is a Presence session (ADR 0019): play, pause and stop go to Orbis in order, and a playing session renews its lease every 15 s. The sidebar's Listening Now section shows who in the Group is listening, from the event stream; pressing one plays their Set. Scene: `listening`.

### Settings and playback reports

Settings changes the Person's name, Share with Group and Auto Download; lists their devices and signs others out; shows a Sign-in Code for the next device; approves a device that shows an Approval Code; copies the playback report; and signs out, which removes this device's key from Orbis and from the config file.

The player records what it does, as the Apple app does ("Playback reports" in `docs/development.md`). Copy Report copies the last 256 entries as JSON. While signed in, entries also go to `/diagnostics/playback` in batches of at most 32 every 5 s, with `metadata.client` set to `rune`, so the relay names them `orbis-rune`. A batch Orbis can't take now comes back later, after a wait that doubles to a minute; a batch it refuses for good is named lost in the next one. Entries name a Set by id only.

Scenes: `settings`, `settings-code`, `settings-approve`, `settings-loading`, `sign-out`.

### Keys

| Key              | Does                                            |
| ---------------- | ----------------------------------------------- |
| Space            | Play and pause                                  |
| Ctrl+1 to Ctrl+4 | Library, Listening Queue, Now Playing, Settings |
| Ctrl+N           | Save a Link                                     |
| Ctrl+R           | Reload the screen                               |
| Ctrl+,           | Settings                                        |
| Ctrl+Shift+B     | Show and hide the sidebar                       |

### Not yet

Importing a YouTube playlist, managing a Collaborative Playlist's editors, reordering a Playlist's Sets, People pages, and the Host's administration. Sound plays through mpv on every platform; Rune's own `Player` has no Linux backend at this rev.

## Check it

```sh
scripts/check                                       # format, code shape, clippy, tests and goldens
ORBIS_RUNE_UPDATE_GOLDENS=1 cargo test goldens       # rewrite goldens after a change you meant
```

`apps/rune/src/goldens.rs` renders every scene into `apps/rune/goldens/<scene>.txt` and fails on any difference. The press tests in `apps/rune/src/tests.rs` drive the real view, answer the API from `api::fixture`, and check what the app sent and what it then shows. `bun run check` at the repo root runs `apps/rune/scripts/check` as this package's `test` task.

## Scenes

Each still is `cargo run -- --snap shots/<scene>.png --scene <scene> --size 1180x780 --scale 1 --at 1.5`, on made-up data; `-light` stills add `--theme light`, and `library-hover` moves the pointer onto Night Ferry with a `--script`.

|  |  |
| --- | --- |
| ![library](shots/library.png) `library` | ![library-hover](shots/library-hover.png) `library-hover` |
| ![library-search](shots/library-search.png) `library-search` | ![library-tag](shots/library-tag.png) `library-tag` |
| ![library-menu](shots/library-menu.png) `library-menu` | ![library-save](shots/library-save.png) `library-save` |
| ![library-save-failed](shots/library-save-failed.png) `library-save-failed` | ![library-tags](shots/library-tags.png) `library-tags` |
| ![library-remove](shots/library-remove.png) `library-remove` | ![library-empty](shots/library-empty.png) `library-empty` |
| ![library-loading](shots/library-loading.png) `library-loading` | ![library-failed](shots/library-failed.png) `library-failed` |
| ![library-long](shots/library-long.png) `library-long` | ![toast](shots/toast.png) `toast` |
| ![listening](shots/listening.png) `listening` | ![playlist](shots/playlist.png) `playlist` |
| ![playlist-menu](shots/playlist-menu.png) `playlist-menu` | ![playlist-new](shots/playlist-new.png) `playlist-new` |
| ![playlist-delete](shots/playlist-delete.png) `playlist-delete` | ![playlist-empty](shots/playlist-empty.png) `playlist-empty` |
| ![playlist-loading](shots/playlist-loading.png) `playlist-loading` | ![playlist-failed](shots/playlist-failed.png) `playlist-failed` |
| ![queue](shots/queue.png) `queue` | ![queue-empty](shots/queue-empty.png) `queue-empty` |
| ![queue-loading](shots/queue-loading.png) `queue-loading` | ![queue-failed](shots/queue-failed.png) `queue-failed` |
| ![playing](shots/playing.png) `playing` | ![playing-loading](shots/playing-loading.png) `playing-loading` |
| ![playing-failed](shots/playing-failed.png) `playing-failed` | ![playing-no-tracklist](shots/playing-no-tracklist.png) `playing-no-tracklist` |
| ![playing-long](shots/playing-long.png) `playing-long` | ![playing-empty](shots/playing-empty.png) `playing-empty` |
| ![settings](shots/settings.png) `settings` | ![settings-code](shots/settings-code.png) `settings-code` |
| ![settings-approve](shots/settings-approve.png) `settings-approve` | ![settings-loading](shots/settings-loading.png) `settings-loading` |
| ![sign-out](shots/sign-out.png) `sign-out` | ![sign-in](shots/sign-in.png) `sign-in` |
| ![sign-in-approve](shots/sign-in-approve.png) `sign-in-approve` | ![sign-in-join](shots/sign-in-join.png) `sign-in-join` |
| ![sign-in-failed](shots/sign-in-failed.png) `sign-in-failed` | ![library-light](shots/library-light.png) `library-light` |
| ![playing-light](shots/playing-light.png) `playing-light` | ![playlist-light](shots/playlist-light.png) `playlist-light` |
| ![settings-light](shots/settings-light.png) `settings-light` | ![sign-in-light](shots/sign-in-light.png) `sign-in-light` |
