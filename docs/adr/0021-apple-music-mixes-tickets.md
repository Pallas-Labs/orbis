# Ticket plan: Apple Music DJ mixes

This plan carries out [ADR 0021](0021-apple-music-mixes.md). Each ticket is a vertical slice that a fresh agent can finish and verify alone. No Linear issues exist yet. Publish them in this order after Parth answers the ADR's questions and approves the breakdown.

| # | Title | Blocked by |
| --- | --- | --- |
| 1 | Read Apple Music albums on the service (bring PR #274 up to date) | Parth's answers to ADR questions 1, 2, and 7 |
| 2 | Share an album from the Music app to Orbis | 1 |
| 3 | Put the audio engine behind a seam in `AudioPlayer` | None |
| 4 | Play an Apple Music Set through MusicKit on iPhone and Mac | 1, 3 |
| 5 | Find Apple Music DJ mixes from Add Set | 1 |
| 6 | Show, save, and search Apple Music Sets on web | 1, 5 |
| 7 | Play Apple Music Sets on Apple TV | 4 |

Tickets 2, 3, and 5 can run in parallel once their blockers are done. Live checks need the MusicKit key and the MusicKit App Service, which only Parth can set up (see "What Parth must do" in the ADR). Apple client checks need the Mac and a device with an Apple Music subscription; record them as unverified when an agent works from Vanta.

## 1: Read Apple Music albums on the service (bring PR #274 up to date)

**What to build:** A Person saves an Apple Music album link through the API and gets a Set with the album's title, creator, Artwork, length, and its songs as a ready Tracklist. Orbis never offers or makes a Download for it, and it can enter the Listening Queue.

**Blocked by:** Parth's answers to ADR questions 1, 2, and 7.

**Status:** ready-for-agent once unblocked.

- [ ] PR #274 has main merged in and no ADR commits; this record's PR holds the ADR.
- [ ] The client-supplied album is gone from the save payload, with its refusal and the friend-save special case.
- [ ] Apple Music is an entry in the metadata provider registry (ADR 0005), present only when the Team ID, Key ID, and private key are configured. The Group signs an ES256 developer token and reuses it until it is near expiry.
- [ ] A save of an album link reads the album with its songs. The Set has metadata enriched, details filled, a Tracklist ready, one Cue per song in album order, start times from summed song lengths, and each Cue's `appleMusicId`.
- [ ] A song link inside an album saves the album. Playlist, artist, station, and bare song links are refused with the shared Source Link message.
- [ ] A refused or timed-out read saves the Set with the temporary title "Apple Music mix" and failed metadata. The metadata retry and the Tracklist retry read Apple Music again.
- [ ] A Download request for an Apple Music Set is refused, Auto Download reports it unavailable, and the audio node never claims one.
- [ ] An Apple Music Set enters the Listening Queue, and the Library's source filter accepts `apple-music`.
- [ ] The glossary's Source Link entry names Apple Music.
- [ ] Server HTTP tests drive `createApp` with a fake Apple Music provider that replays a recorded album response (one real DJ mix, with its songs), and cover every item above. The recorded response is committed as a fixture.
- [ ] Live check: with the key set on the Group, saving one real DJ mix link through the API returns its title and Tracklist. Record the command, response, and commit.

## 2: Share an album from the Music app to Orbis

**What to build:** In the Music app on iPhone or Mac, a Person chooses Share on a DJ-mix album, then Orbis. The share sheet shows the Apple Music link, saves it, and shows the saved Set with its title and Artwork. The Set is in the Library with an Apple Music stamp and its Tracklist.

**Blocked by:** 1.

**Status:** ready-for-agent.

- [ ] Before code: on a device, record the exact attachments the Music app sends for an album and for a song (type identifiers and values), on iPhone and on Mac. Record whether the Mac Music app's Share menu lists Orbis. Commit the payloads as test fixtures.
- [ ] The Apple client knows the `apple-music` source: its label, the Source stamp, and the link host check.
- [ ] The share capture tests find the Source Link in each recorded payload.
- [ ] The share sheet hides "Download after saving" for an Apple Music link, and its refusal text names Apple Music.
- [ ] Add Set in the app saves a pasted Apple Music link the same way.
- [ ] No Set page, menu, or row offers Download for an Apple Music Set.
- [ ] A native journey saves an Apple Music link through Add Set against the lane service with the fake provider, and exports a screenshot of the Set page with its Tracklist.
- [ ] Device check: share one real DJ mix from the Music app on iPhone (and on Mac, if the menu lists Orbis), and keep a screenshot of the saved state.

## 3: Put the audio engine behind a seam in `AudioPlayer`

**What to build:** No visible change. `AudioPlayer` drives playback through an engine seam, with `AVPlayer` as the only engine, so ticket 4 can add a MusicKit engine without editing every playback path.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent.

- [ ] The seam covers what a second engine needs: load a Set, play, pause, seek to a mix time, the current position and length, the stall and end events, and who owns Now Playing and the remote commands.
- [ ] Position reporting, Listens, Finishes, the Listening Queue advance, and playback diagnostics read through the seam and behave as before.
- [ ] The existing playback reliability, streaming playback, and position reporting suites pass unchanged on iOS and macOS (`bun run native:lanes`), and the journeys pass. Retain the run's xcresult and screenshots.

## 4: Play an Apple Music Set through MusicKit on iPhone and Mac

**What to build:** A Person with Apple Music taps Play on an Apple Music Set and hears the mix from the first song, with one seek bar across the whole mix. Seeking, next and previous Cue, resuming on another device, and Listen History work as for any Set. A Person without access or a subscription sees Open in Apple Music instead of Play.

**Blocked by:** 1, 3.

**Status:** ready-for-agent.

- [ ] The app declares `NSAppleMusicUsageDescription`. The MusicKit App Service is enabled on `app.orbis.client` (Parth's step).
- [ ] The first Play of an Apple Music Set asks for Apple Music access, then checks that the account can play catalog content.
- [ ] A MusicKit engine behind the seam queues the album's tracks in `ApplicationMusicPlayer` and does not change the Music app's queue.
- [ ] Position and length are in mix time, computed from the queued tracks' lengths. A seek to a mix time lands in the right song at the right offset. Next and previous Cue move by song.
- [ ] Playback Position, Listens, and Finishes reach the service in mix time. A Set resumed on a second device starts within a few seconds of where the first stopped.
- [ ] The Listening Queue advances from an Apple Music Set to a Set with Retained Audio and back.
- [ ] While an Apple Music Set plays, Orbis does not overwrite the Now Playing information that `ApplicationMusicPlayer` publishes, and lock screen controls work.
- [ ] Without access or a subscription, the Set page shows its Tracklist and Open in Apple Music, which opens the album.
- [ ] Device check on iPhone and Mac: play one real DJ mix, seek into its third song, skip a Cue, stop, and resume on the other device. Record a screen recording or screenshots with the commit and device.

## 5: Find Apple Music DJ mixes from Add Set

**What to build:** In Add Set on iPhone or Mac, a Person types a DJ, a label, or a series name and sees Apple Music DJ mixes that match, each with Artwork, title, creator, song count, and length. An All Albums switch shows other albums. Choosing a result saves it as a Set; a result already in the Library says so.

**Blocked by:** 1.

**Status:** ready-for-agent.

- [ ] Before the rules: record real search and album responses for at least five queries (for example a DJ, a mix series, a label, and a studio artist). List where the ADR's DJ-mix rules would be wrong, and adjust the rules in the ADR if needed. Commit the responses as fixtures.
- [ ] `GET /apple-music/search?q=` is in the typed API. It runs the typed search and the same words followed by "DJ Mix", merges them without duplicates, and reads the albums with their songs in one batched call.
- [ ] Each result carries the Source Link, title, creator, Artwork, release date, song count, length, whether it looks like a DJ mix, and whether it is in the Person's Library.
- [ ] DJ mixes sort first and keep Apple's order. The default shows only DJ mixes; the All Albums switch shows the rest. A single is never a DJ mix.
- [ ] With no key configured, the endpoint answers with a clear "not configured" error and the field says Apple Music search is not set up.
- [ ] Server HTTP tests replay the recorded responses and assert which albums each query returns as DJ mixes, and in what order.
- [ ] Add Set on iPhone and Mac shows the search field, results, the switch, and the saved mark. Choosing a result saves through the ordinary save.
- [ ] A native journey searches against the lane service with the fake provider, saves a result, and exports screenshots of the results and the saved Set.
- [ ] Live check: one real search on the Group returns at least one real DJ mix first. Record the query and response.

## 6: Show, save, and search Apple Music Sets on web

**What to build:** On web, an Apple Music Set shows in the Library with an Apple Music label and on its page with the Tracklist and Open in Apple Music, never Play or Download. A Person can paste an Apple Music link, or search as in the Apple app, to save one.

**Blocked by:** 1, 5.

**Status:** ready-for-agent.

- [ ] The Library row and Set page show the Apple Music label, Artwork, length, and Tracklist.
- [ ] The Set page offers Open in Apple Music and neither Play nor Download.
- [ ] Pasting an Apple Music link into Add Set saves it.
- [ ] Add Set offers the Apple Music search with the All Albums switch, through the endpoint from ticket 5.
- [ ] Web browser journeys cover the row, the page, a pasted save, and a search save against the fixture service, and keep their screenshots.

## 7: Play Apple Music Sets on Apple TV

**What to build:** On Apple TV, a Person with Apple Music plays a saved Apple Music Set from its page with the Siri Remote, with the same mix-time position as on the phone.

**Blocked by:** 4.

**Status:** ready-for-agent.

- [ ] The TV app uses the MusicKit engine from ticket 4 and asks for Apple Music access on first Play.
- [ ] The TV Set page shows the Tracklist and Play, or a message to open Apple Music when the account cannot play.
- [ ] Resume, seek, and next and previous Cue work in mix time.
- [ ] The tvOS journey (`bun run native:lanes --tvos --journeys`) still passes, and the TV Set page for an Apple Music Set renders in it.
- [ ] Device check on an Apple TV: play, seek, and resume one real DJ mix. Record screenshots with the commit.
