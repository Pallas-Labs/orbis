# Save Apple Music DJ mixes as Sets played through MusicKit

Status: accepted. Accepted by Parth on 2026-10-25.

Revised 2026-10-24. The first draft is in PR #274. This revision adds two ways in, sharing from the Music app and a search inside Orbis, and moves the album read from the Apple app to the service. The ticket plan is in [0021-apple-music-mixes-tickets.md](0021-apple-music-mixes-tickets.md).

## Decisions by Parth

Parth answered the seven open questions on 2026-10-25.

1. **Direction.** An Apple Music DJ mix becomes a Set with its songs as the Tracklist. The Apple app plays it through MusicKit, and Orbis never downloads it.
2. **Key on the service.** The Group holds a MusicKit private key and signs its own developer token. The first draft kept the key off the service, which left the share extension unable to save a mix on its own and put search and the DJ-mix rules in Swift, which Vanta cannot build or test.
3. **A new key.** Orbis gets its own MusicKit key in the same team, so that revoking the Orbis key or the Versos key does not break the other app.
4. **US only.** Every read and search uses the `us` storefront, whatever storefront the shared link names. A link from another country saves when the album is in the US catalog. When it is not, the save is refused with "This album is not in the US Apple Music catalog."
5. **Search shows DJ mixes.** By default search shows only albums that look like DJ mixes, with an All Albums switch. Any album can still be saved.
6. **Apple TV and web.** Apple TV plays saved Apple Music Sets in a later ticket, with no search on the TV. Web shows, searches, and saves Apple Music Sets, but does not play them. Web playback needs MusicKit JS and each listener's Music User Token, which this record does not plan.
7. **PR #274 stays the server PR.** It takes main, drops its ADR commits (this record replaces them), and changes its save path as ticket 1 says.

## What Parth must do

- Enable the MusicKit App Service on the App ID `app.orbis.client`: Certificates, Identifiers & Profiles > Identifiers > `app.orbis.client` > App Services > MusicKit. The iPhone, Mac, and Apple TV builds share this App ID. The share extension (`app.orbis.client.share`) does not use MusicKit and needs nothing.
- Create a Media ID and a private key with Media Services (MusicKit) enabled. Keep the `.p8` file. Give the Team ID, Key ID, and key to the Group as Worker secrets.
- Use an Apple Music subscription on the iPhone and Mac that test playback.

## Decision

Apple Music carries DJ mixes, but it files each one as an album: a list of songs that play without gaps. A Person who saves one in Apple Music gets an album beside their other albums, with no sign that it is one continuous performance. Orbis treats a performance as one thing, a Set with a Tracklist of Cues. So an Apple Music DJ mix becomes a Set like any other: one row in the Library, one seek bar across the whole mix, and its songs as the Tracklist.

**Source and Source Link.** Apple Music is a third Source, `apple-music`. Its Source Link is the album address without a storefront, `https://music.apple.com/album/<id>`, so a link from any country names the same Set. A song link inside an album (`?i=<song id>`) saves the album. Playlist, artist, station, and bare song links are refused with the shared Source Link message. PR #274 already holds this rule and its cases.

**Reading the album.** The service reads Apple Music albums, as it reads YouTube and SoundCloud. Apple Music becomes a third entry in ADR 0005's provider registry. The Group signs an ES256 developer token from the MusicKit private key, keeps it for an hour, and calls `GET /v1/catalog/us/albums/{id}?include=tracks`. The storefront is always `us` (decision 4). The read gives the title, the artist as creator, Artwork at both sizes, the release date, and the songs. Each song becomes a Cue in album order. A Cue's start time is the sum of the song lengths (`durationInMillis`) before it, and its `appleMusicId` is the song's catalog id. The Set's length is the sum of all song lengths. The Tracklist is ready when the read succeeds, so Versos (ADR 0017) is not asked about these Sets.

ADR 0005's rule that a read never fails a save holds, with one exception. When Apple Music answers that the album is not in the US catalog, the save is refused with "This album is not in the US Apple Music catalog." and no Set is made, because no listener in Orbis could read or play it. If Apple Music refuses for another reason or times out, the Set keeps the temporary title "Apple Music mix", its metadata state is failed, and the client offers a retry, which reads the album again. With no key configured, Apple Music has no registry entry, so tests and a Group without the secrets save the Set with failed metadata and make no Apple Music request.

**No Retained Audio.** Apple Music audio is protected and licensed to each listener, so Orbis never makes a Download for it. The Set's download state stays `none`, Auto Download skips it, a Download request is refused, and no client offers Download. ADR 0001's rule that only Sets with Retained Audio enter the Listening Queue widens to playable Sets: Sets with Retained Audio, and Apple Music Sets. The service cannot know whether a client can play Apple Music, so it accepts them, and a client that cannot play one skips it.

**Share from the Music app.** In the Music app on iPhone or Mac, Share on an album sends its address, `https://music.apple.com/<storefront>/album/<slug>/<id>`, as a URL attachment, often with a text attachment that holds the title and the same address. A shared song adds `?i=<song id>`. OrbisShare already loads URL and text attachments and saves through the app's `OrbisClient`. It changes in three places:

- `SetSource` accepts `music.apple.com`, so `ShareCapture.sourceLink` finds the link, and the refusal text names Apple Music too.
- The form hides "Download after saving" for an Apple Music link.
- The save posts the bare link, as for YouTube. The service reads the album, so the share sheet shows the saved Set with its title and Artwork, and the extension needs no MusicKit, no Apple Music access prompt, and no handoff to the app.

The exact attachments the Music app sends are confirmed on a device in ticket 2 before the code changes. The Mac Music app's Share menu must also list Orbis there; if it does not, the Mac path is to copy the link and paste it into Add Set.

**Search.** Add Set gets a Find on Apple Music field. The field calls a new endpoint, `GET /apple-music/search?q=`, in the typed API (ADR 0014). The endpoint searches the `us` catalog. It runs two catalog searches with `types=albums`: the words as typed, and the words followed by "DJ Mix", so a DJ's own mixes rise above their studio albums. It merges the two lists without duplicates and reads the found albums with their songs in one batched `GET /v1/catalog/us/albums?ids=…&include=tracks` call. The second search adds only albums that look like DJ mixes, because its other results are strangers' singles: for "Radiohead" it adds Kendrick Lamar and Lana Del Rey. Each result carries the Source Link, title, creator, Artwork, release date, song count, length, whether the album looks like a DJ mix, and whether the Set is already in the Person's Library. Choosing a result saves its Source Link through the ordinary save, so a search save and a shared save are the same Set. The search is on the service, not on the device, so web and Raycast can use it, and its rules are tested over HTTP with recorded Apple Music responses.

**Telling a DJ mix from an album.** The Apple Music API has no DJ-mix flag and no continuous-mix flag. `isCompilation` is true for label samplers that are not mixed, and genres such as Dance and Electronic hold most studio albums too. Apple marks most of the mixes it carries in the names instead: the album title ends in "(DJ Mix)" and each song title carries "(Mixed)". The service calls an album a DJ mix when any of these is true:

- the title contains "DJ Mix", "Mixed by", or "Continuous Mix", or a bracket that closes on "Mixed";
- at least half of its songs have a bracket that closes on "Mixed": "(Mixed)", "[Mixed]", or "(Espen Remix - Mixed)";
- its editorial notes contain "DJ mix", "mixed by", or "continuous mix".

A single (`isSingle`) is never a DJ mix. The rules are one pure function beside the provider, so a miss is fixed in one place with one recorded case. Search sorts DJ mixes before other albums and keeps Apple's order within each group. By default it shows only DJ mixes, and an All Albums switch shows the rest. The rules only rank and filter search. A save never checks them, because a Person who saves a continuous live album or a mix that Apple filed without the label wants it heard as one Set.

Ticket 5 recorded six searches on 2026-10-25: a DJ (Seth Troxler), a mix series (DJ-Kicks), a label (Defected), a studio artist (Radiohead), a DJ with studio albums (Carl Cox), and a radio series (Essential Mix). The recordings are in `apps/server/src/fixtures/apple-music`, and `bun run record:apple-music --search` records them again. They changed the first draft of these rules in two places:

- Songs put "Mixed" inside a bracket as often as at the end of the title, as in "Ohh (Mixed) [feat. John Ciafone]" and "Cala Mystica (Gaston Ponte Remix - Mixed)". A rule that read only the end of a song title counted 11 of the 23 songs in one mix.
- The "DJ Mix" search returned unrelated singles and albums, which the first draft listed under All Albums.

Every album titled "(DJ Mix)" or "[DJ Mix]" in the recordings is called a DJ mix, and no studio album, EP, or single is. Three real mixes are missed, because Apple names them like any album and their songs carry no mark: Photek's _DJ-Kicks_, _Seth Troxler - The Lab 03_, and _Mixmag Presents Jamie Jones vs. Seth Troxler_. All Albums shows them. A search for a studio artist with few mixes of their own shows other DJs' mixes first, because the "DJ Mix" search finds them: for "Radiohead", Thom Yorke's Boiler Room set is followed by three festival mixes by other artists.

**Playback.** The iPhone and Mac app plays an Apple Music Set through MusicKit's `ApplicationMusicPlayer`, which leaves the Music app's own queue alone. `AudioPlayer` today drives `AVPlayer` directly, so ticket 3 first puts the engine behind a seam with no change in behavior, and ticket 4 adds a MusicKit engine beside it. The app reads the album with `MusicCatalogResourceRequest<Album>` and queues its tracks. The rest of the app sees one Set. Position and length span the whole mix and are computed from the lengths of the tracks the player queued. A seek to a mix time moves to the song that holds it plus an offset into that song. Next and previous Cue are next and previous song. Playback Position, Listens, and Finishes are reported in mix time, as for any Set, so resuming on another device lands in the same place.

Before the first Apple Music Set plays, the app asks for Apple Music access with `MusicAuthorization.request()`, and checks `MusicSubscription.current.canPlayCatalogContent`. A listener who refuses access or has no subscription sees the Set and its Tracklist with an Open in Apple Music action instead of Play. The app declares `NSAppleMusicUsageDescription`. `ApplicationMusicPlayer` publishes its own Now Playing information, so the MusicKit engine leaves `MPNowPlayingInfoCenter` and the remote commands to it while an Apple Music Set plays. MusicKit catalog reads and playback do not run in the simulator, so these checks run on a device.

**Platforms.**

- iPhone: share from the Music app, search, save, and play.
- Mac: the same. If the Mac Music app does not list share extensions, paste the link into Add Set.
- Apple TV: plays saved Apple Music Sets in ticket 7, through `ApplicationMusicPlayer` on tvOS. The TV has no share sheet, and search stays on the phone, the Mac, and web.
- Web: shows an Apple Music Set in the Library with its Tracklist and an Open in Apple Music action. It saves a pasted Apple Music link and offers the same search. It does not play.
- Raycast: saves an Apple Music link, because the service reads it.
- CarPlay: not yet. It follows once phone playback is proven.

**What stands from PR #274.** The Source, the Source Link rule and its cases, the Cues computed from song lengths, the Download refusals and the Auto Download skip, `isPlayableSet` in the Listening Queue, the Library's source filter, and the web source label all stand. The client-supplied album goes: `AppleMusicAlbumPayload` on the save payload, the refusal of a save without one, and the special case for a friend who saves a mix that someone else filed. The provider read replaces them, and a metadata or Tracklist retry reads Apple Music again instead of keeping what a client sent.

## Versos

Versos has no DJ-mix search or filter. It calls the Apple Music API with a server developer token ([apple-music-auth.ts](https://github.com/Pallas-Labs/versos/blob/main/apps/api/src/cloudflare/apple-music-auth.ts), signed with `jose`) to match single songs from pasted tracklists and to find artists' new releases. Its song matcher (`similarity-scoring.ts`, `match-relations.ts`) scores title and artist likeness, with an optional LLM judgment, to pick one recording; it never classifies albums. The only place that names DJ mixes is an experiment, [exp9-release-triage.ts](https://github.com/Pallas-Labs/versos/blob/main/docs/experiments/typesafe/exp9-release-triage.ts), which asks an LLM to put each made-up release into one of seven kinds, one of which is "A various-artists compilation, DJ mix, or label sampler". Radar does not use it.

Orbis reuses two things: the token signing pattern, about fifteen lines, and the idea of naming a release's kind from its title, artist, and songs. It uses rules instead of a model. Orbis does not reuse the song matcher, because Apple's own song list is exact.

## Rejected alternatives

- **Download the audio through Cobalt, as for YouTube and SoundCloud.** The audio is DRM-protected and licensed to one subscriber. Retained Audio would break Apple's terms and would not play.
- **Read the album on the device and post it with the save (the first draft).** It keeps the key off the service. But the share extension would need its own MusicKit App Service and an Apple Music access prompt inside the share sheet, or a handoff to the app to finish the save. Web and Raycast could not save. Search and its rules would be Swift that only a Mac can build and test.
- **Search on the device with `MusicCatalogSearchRequest`.** It needs no key and works on tvOS. Rejected because it needs Apple Music access before the first search, puts the DJ-mix rules in Swift, and leaves web without search. With the key on the service, one endpoint serves every client.
- **Ask Versos to read albums or search.** Versos holds a key already, but Orbis would wait on a Versos endpoint in another repository for a read of about fifty lines.
- **Ask Versos for the Tracklist.** Apple's own song list is exact and carries catalog ids. A second service could only disagree with it.
- **An LLM classifier, as in Versos's experiment.** It adds a model call, a cost, and an answer that can change between runs, to a question that Apple's "(DJ Mix)" and "(Mixed)" names answer for the mixes Apple labels. The All Albums switch covers the rest.
- **Import the album as a Playlist of songs.** That is the album-shaped view this decision exists to avoid, and Playlists hold Sets, not songs.
- **Accept only albums that look like DJ mixes.** Refusing a continuous live album or a mix filed without the label would surprise the Person who chose it.

The trade this accepts is that an Apple Music Set plays only for People who pay for Apple Music, on an iPhone, Mac, or later an Apple TV, while every other Set plays for everyone who can see it. A friend without a subscription still sees the Set, its Tracklist, and its Listen History. The Host also holds one more secret, the MusicKit private key, which does not expire but can be revoked.
