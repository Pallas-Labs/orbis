# Orbis

Orbis is a personal library for collecting and organizing music and DJ sets from supported sources.

## Language

**Set**:
A music recording or DJ performance identified by its Source Link. One Set exists per Source Link, shared by every Library that saves it.
_Avoid_: Item, bookmark, track

**Tracklist**:
The ordered Cues identified for one Set, shared by everyone who can see that Set.
_Avoid_: Playlist, chapters

**Cue**:
One named recording in a Set's Tracklist. It may name a start time in the Set's Retained Audio.
_Avoid_: Track, chapter

**Library Entry**:
One Person's saving of one Set, holding that Person's title override and Tags.
_Avoid_: Save, bookmark

**Artwork**:
The provider's image for a Set. A Set holds two: the one a listing draws, and the large one its own page draws.
_Avoid_: Thumbnail, cover, image

**Source Link**:
The original YouTube, SoundCloud, or Apple Music album address associated with a Set.
_Avoid_: Media URL, download URL

**Orbis Link**:
A Set's public address, `https://orbis.p11a.xyz/s/<set id>`. It opens the Set in Orbis and previews only the Set's shared facts.
_Avoid_: Share link, deep link

**Retained Audio**:
An audio copy of a Set stored on Vanta for playback. One per Set, streamable by anyone who can see the Set.
_Avoid_: Download, media file

**Download**:
A request for Orbis to create Retained Audio for a Set from its Source Link. It never means a copy on a device.

**Auto Download**:
A Person's setting, on by default, that starts a Download whenever they save a Set without Retained Audio.
_Avoid_: Save

**Playback Position**:
The point in a Set's Retained Audio where one Person's listening should resume.
_Avoid_: Progress

**Listen**:
One Person's activation of a Set through an intentional play action or automatic Listening Queue advance. Pausing and resuming the active Set remain part of the same Listen.
_Avoid_: Play, playback session

**Listening Time**:
The seconds of one Set one Person heard on one UTC day, credited from the short forward steps between saved Playback Positions that match the time between the saves. A seek, a skip while paused, or a second device playing the same Set is not Listening Time.
_Avoid_: Play time, watch time

**Heavy Rotation**:
The collection of the Sets one Person heard most over a range (30 days, 3 months, or the past year), ranked by Listening Time and opened like a Playlist. A day under two minutes of a Set does not count. Recent days weigh more over 30 days, a little more over 3 months, and the same over a year. Home's shelf shows the 30-day collection's first Sets, and the collection is empty until three Sets qualify.
_Avoid_: Top Sets, most played

**Collection**:
A filter one Person saves over their own Listening Time: a range, and at will a Source, a creator, a Tag, and a least time heard. Its Sets are the ones that pass, ranked as Heavy Rotation ranks them, and opened like a Playlist. Listening fills it, so a Person edits the filter, never its Sets. Heavy Rotation is the collection with no filter.
_Avoid_: Smart playlist, saved search

**Finish**:
A Listen that reaches the natural end of its Set. A Listen can produce at most one Finish.
_Avoid_: Completion

**Library**:
The complete collection of one Person's Library Entries.
_Avoid_: Catalog, collection

**Playlist**:
A named, ordered selection of Sets, owned by the Person who created it. The word on screen is Playlist.
_Avoid_: Folder, Crate

**Listening Queue**:
One Person's temporary ordered sequence of Sets scheduled for playback, shared by all of that Person's clients.
_Avoid_: Playlist, play queue

**Tag**:
A short label used to classify and filter Sets across the Library.
_Avoid_: Category

**Collaborative**:
A Playlist flag, set by its creator, that lets named editors add, remove, and reorder its Sets.

**Person**:
A member of the Group with a username and one or more API keys.
_Avoid_: User, account

**Group**:
Everyone the Host admits to one Orbis deployment. One Group per deployment.
_Avoid_: Team, org, server

**Host**:
The Person who runs the deployment. The Host opens and closes joining, shows a Sign-in Code for any Person, revokes keys, and removes People.
_Avoid_: Admin

**Group Passcode**:
The random code Orbis makes when the Host opens joining, which the Host tells friends so they can join the Group without the Host. Joining is closed while there is none.
_Avoid_: Invite code, password

**Join Link**:
The link `https://orbis.p11a.xyz/join#<Group Passcode>` that the Host's "Invite a Friend" shares. It opens Join Your Group with the passcode already in place, so a friend chooses only a username. The passcode rides in the fragment, which no browser sends to a server, and the link stops working when the Host makes a new passcode or closes joining.
_Avoid_: Invite link, magic link

**Sign-in Code**:
A short, one-time code that a signed-in device, or the Host, shows so another device can sign in as the same Person.
_Avoid_: Device Link, pairing code, Invite

**Approval Request**:
A signed-out device's request to sign in. It shows an Approval Code until a signed-in Person approves it or it expires, and the device then receives its own key for that Person.
_Avoid_: Pairing, device link

**Approval Code**:
The 6-digit code an Approval Request shows. A signed-in Person types it or scans it to approve.
_Avoid_: Pairing code, PIN

**Social**:
A Person's switch, off by default. Off hides them from others and others from them.
_Avoid_: Sharing mode, public mode

**See / Appear**:
One Person's filters for another. See includes them in your social views; Appear lets them see you.
_Avoid_: Follow, mute

**Presence**:
The Set a Person is in a Listen on now, plus their few most recent Sets.
_Avoid_: Now playing, status

**Listen History**:
A Person's Listens and Finishes, shown on their profile to People who pass the social gate.
_Avoid_: Activity feed
