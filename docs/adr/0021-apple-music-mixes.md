# Save Apple Music DJ mixes as Sets played through MusicKit

Status: proposed.

Apple Music carries DJ mixes, but it files each one as an album: a list of songs that happen to play gaplessly. A Person who saves one in Apple Music gets an album beside their other albums, with no sense that it is one continuous performance. Orbis already treats a performance as one thing, a Set with a Tracklist of Cues, so an Apple Music DJ mix should become a Set like any other: one row in the Library, one seek bar across the whole mix, and its songs as the Tracklist.

**Source and Source Link.** Apple Music is a third Source, `apple-music`. Its Source Link is the album address without a storefront, `https://music.apple.com/album/<id>`, so a link shared from any country is the same Set. A song link inside the album (`?i=<song id>`) saves the album. Playlist, artist, station, and bare song links are refused with the shared Source Link message. Orbis does not try to decide whether an album is "really" a DJ mix: the catalog has no reliable flag for it, and a Person who saves an album is saying they want it heard as one Set.

**Metadata and Tracklist.** The iOS and macOS app reads the album on the device with MusicKit, which Apple signs for the app, so the Host holds no MusicKit key and the service makes no Apple Music request. The save posts the Source Link together with what the app read: the title, the curator or artist as creator, Artwork, release date, duration, and the songs. Each song becomes a Cue in album order, its start time is the sum of the lengths before it, and its `appleMusicId` is the song's catalog id. The Tracklist is ready when the save finishes, so Versos (ADR 0017) is not asked about these Sets. The service refuses an Apple Music save that carries no album details, with a message saying to save it from the iPhone or Mac app, so a Set never exists without its Tracklist. This is the one Source whose metadata a client supplies; ADR 0005's provider registry has no Apple Music entry.

**No Retained Audio.** Apple Music audio is protected and licensed per listener, so Orbis never makes a Download for it. The Set's download state stays `none`, Auto Download skips it, and no client offers Download. ADR 0001's rule that only Sets with Retained Audio can enter the Listening Queue widens to Sets that are playable: Sets with Retained Audio, and Apple Music Sets on a client that can play Apple Music.

**Playback.** The iOS and macOS app plays an Apple Music Set through MusicKit's `ApplicationMusicPlayer`, queued with the album's songs, behind the same player model that drives `AVPlayer` today. The rest of the app sees one Set: position and length span the whole mix, a seek to a time becomes a move to the song that holds it plus an offset into that song, and next and previous Cue are next and previous song. Playback Position, Listens, and Finishes are reported in mix time, as for any Set, so resuming on another device lands in the same place. Each listener needs their own Apple Music subscription and grants the app Apple Music access the first time they play one; a listener without it sees the Set with an Open in Apple Music action instead of Play. The app's App ID needs the MusicKit App Service enabled, and the app declares `NSAppleMusicUsageDescription`.

**Not yet.** Only the iOS and macOS app saves and plays Apple Music Sets. Web shows a saved one in the Library with its Tracklist and an Open in Apple Music action, and refuses to save one; Raycast refuses too. tvOS, CarPlay, and web playback can follow once phone and Mac playback is proven. Web playback would need MusicKit JS and a developer token, which brings back the Host key this record avoids.

Rejected alternatives:

- **Download the audio through Cobalt like YouTube and SoundCloud.** The audio is DRM-protected and licensed to one subscriber; Retained Audio would break Apple's terms and would not play.
- **Read the album on the service from the Apple Music API.** Lets web and Raycast save Apple Music links, and fits ADR 0005. Rejected for now because it needs a MusicKit key the Host creates, signs, and rotates, for clients that cannot play the Set anyway. It returns with web playback, which needs the same key.
- **Ask Versos for the Tracklist.** Apple's own song list is exact and carries catalog ids; asking a second service could only disagree with it.
- **Import the album as a Playlist of songs.** That is the album-shaped view this decision exists to avoid, and Playlists hold Sets, not songs.
- **Accept only albums Apple labels as DJ mixes.** The label is not exposed reliably, and refusing a continuous live album or a mix filed under another genre would surprise the Person who chose it.

The trade this accepts is that an Apple Music Set plays only for People who pay for Apple Music, on an iPhone or Mac, while every other Set plays for everyone who can see it. A friend without a subscription can still see the Set, its Tracklist, and its Listen History.
