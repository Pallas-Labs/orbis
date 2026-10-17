# Save Apple Music DJ mixes as Sets played through MusicKit

Status: proposed.

Apple Music carries DJ mixes, but it files each one as an album: a list of songs that happen to play gaplessly. A Person who saves one in Apple Music gets an album beside their other albums, with no sense that it is one continuous performance. Orbis already treats a performance as one thing, a Set with a Tracklist of Cues, so an Apple Music DJ mix should become a Set like any other: one row in the Library, one seek bar across the whole mix, and its songs as the Tracklist.

**Source and Source Link.** Apple Music is a third Source, `apple-music`. Its Source Link is the album address without a storefront, `https://music.apple.com/album/<id>`, so a link shared from any country is the same Set. A song link inside the album (`?i=<song id>`) saves the album. Playlist, artist, station, and bare song links are refused with the shared Source Link message. Orbis does not try to decide whether an album is "really" a DJ mix: the catalog has no reliable flag for it, and a Person who saves an album is saying they want it heard as one Set.

**Metadata and Tracklist.** The service reads the album from the Apple Music API catalog through the ADR 0005 provider registry. That needs a developer token, which the service signs from a MusicKit key (Team ID, Key ID, and the private key) that the Host creates in the Apple Developer account and keeps in the environment, never in the repository, as the YouTube key is kept. Without the key the provider is absent and a save takes the ADR 0005 failed-metadata path. The album gives the title, the curator or artist as creator, Artwork, release date, and duration. Its songs are the Tracklist: each song is a Cue in album order, its start time is the sum of the lengths before it, and its `appleMusicId` is the song's catalog id. The Tracklist is ready when the save finishes, so Versos (ADR 0017) is not asked about these Sets.

**No Retained Audio.** Apple Music audio is protected and licensed per listener, so Orbis never makes a Download for it. The Set's download state stays `none`, Auto Download skips it, and no client offers Download. ADR 0001's rule that only Sets with Retained Audio can enter the Listening Queue widens to Sets that are playable: Sets with Retained Audio, and Apple Music Sets on a client that can play Apple Music.

**Playback.** The iOS, macOS, and tvOS app plays an Apple Music Set through MusicKit's `ApplicationMusicPlayer`, queued with the album's songs, behind the same player model that drives `AVPlayer` today. The rest of the app sees one Set: position and length span the whole mix, a seek to a time becomes a move to the song that holds it plus an offset into that song, and next and previous Cue are next and previous song. Playback Position, Listens, and Finishes are reported in mix time, as for any Set, so resuming on another device lands in the same place. Each listener needs their own Apple Music subscription and grants the app Apple Music access the first time they play one; a listener without it sees the Set with an Open in Apple Music action instead of Play. The app's App ID needs the MusicKit App Service enabled, and the app declares `NSAppleMusicUsageDescription`.

**Not yet.** The web player can follow later with MusicKit JS and a developer token from the service, signed with the same key; until then web shows the Set and its Tracklist with Open in Apple Music. CarPlay waits until phone playback is proven, because the car drives the phone's player (ADR 0011). Raycast saves the link like any other.

Rejected alternatives:

- **Download the audio through Cobalt like YouTube and SoundCloud.** The audio is DRM-protected and licensed to one subscriber; Retained Audio would break Apple's terms and would not play.
- **Read the album on the device with MusicKit and post its details with the save.** Avoids the Host's MusicKit key, because Apple signs the device's requests. Rejected as the default because a save from web or Raycast would get nothing, and the Tracklist would depend on which client saved first. It stays the fallback if the Host cannot create a key.
- **Ask Versos for the Tracklist.** Apple's own song list is exact and carries catalog ids; asking a second service could only disagree with it.
- **Import the album as a Playlist of songs.** That is the album-shaped view this decision exists to avoid, and Playlists hold Sets, not songs.
- **Accept only albums Apple labels as DJ mixes.** The label is not exposed reliably, and refusing a continuous live album or a mix filed under another genre would surprise the Person who chose it.

The trade this accepts is that an Apple Music Set plays only for People who pay for Apple Music, on Apple devices first, while every other Set plays for everyone who can see it. A friend without a subscription can still see the Set, its Tracklist, and its Listen History.
