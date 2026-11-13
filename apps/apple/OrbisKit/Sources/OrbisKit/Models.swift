import Foundation

/// Mirrors the server contract. Only the fields the Library needs are decoded, so a
/// server that adds a field does not break this client.
public struct SavedSet: Identifiable, Decodable, Hashable, Sendable {
  enum CodingKeys: String, CodingKey {
    case id, url, title, source, tags, createdAt, releasedAt, creator, creatorId, artworkUrl, durationSeconds
    case artworkLargeUrl
    case metadataState, downloadState, playlistIds, playbackPositionSeconds
    case listenCount, finishCount, lastListenedAt
    case tracklistState
  }

  public let id: String
  public let url: String
  public let title: String
  public let source: SetSource
  public let tags: [String]
  public let createdAt: String
  public let releasedAt: String?
  public let creator: String?
  /// The provider's stable id for the creator; nil until the service has read the details.
  public var creatorId: String? = nil
  public let artworkUrl: String?
  public let artworkLargeUrl: String?
  public let durationSeconds: Int?
  public let metadataState: String
  public let downloadState: String
  public let playlistIds: [String]
  public let playbackPositionSeconds: Int
  public let listenCount: Int
  public let finishCount: Int
  public let lastListenedAt: String?
  public var tracklistState: TracklistState = .none
}

extension SavedSet {
  /// Whether the app can play this Set: it has Retained Audio, or it is an Apple Music Set, which
  /// plays through MusicKit (ADR 0021). The service's `isPlayableSet` holds the same rule.
  public var isPlayable: Bool { downloadState == "ready" || source == .appleMusic }

  /// Whether the service is still working on a download in `state`: it is `queued` or
  /// `downloading`. Every other state has settled. The service's `isDownloadInFlight` holds the
  /// same rule.
  public static func isInFlight(_ state: String) -> Bool { state == "queued" || state == "downloading" }

  /// True while the service is still working on this Set's audio.
  public var isDownloading: Bool { Self.isInFlight(downloadState) }

  /// The catalog id of an Apple Music Set's album, the last part of its Source Link
  /// (`https://music.apple.com/album/<id>`).
  public var appleMusicAlbumID: String? {
    guard source == .appleMusic, let url = URL(string: url) else { return nil }
    let id = url.lastPathComponent
    return id.isEmpty || id == "/" ? nil : id
  }

  /// Where playback should start for this Set: where the last Listen left off, or the beginning
  /// for a Set nobody has heard, which is also where a finished one starts again.
  public var resumePosition: TimeInterval { TimeInterval(playbackPositionSeconds) }
}

/// The decode is written out rather than left to the compiler for one reason: `playlistIds` is
/// read as empty when it is absent.
///
/// A service and an app upgrade on their own schedules. When the field arrived, every Set from
/// the older service failed to decode, which turned a version skew into "cannot reach your
/// library" on both platforms with a Try again button that could never work. A field that is
/// missing because the service predates it is not worth making someone's library unreadable.
extension SavedSet {
  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    url = try values.decode(String.self, forKey: .url)
    title = try values.decode(String.self, forKey: .title)
    source = try values.decode(SetSource.self, forKey: .source)
    tags = try values.decode([String].self, forKey: .tags)
    createdAt = try values.decode(String.self, forKey: .createdAt)
    releasedAt = try values.decodeIfPresent(String.self, forKey: .releasedAt)
    creator = try values.decodeIfPresent(String.self, forKey: .creator)
    creatorId = try values.decodeIfPresent(String.self, forKey: .creatorId)
    artworkUrl = try values.decodeIfPresent(String.self, forKey: .artworkUrl)
    artworkLargeUrl = try values.decodeIfPresent(String.self, forKey: .artworkLargeUrl)
    durationSeconds = try values.decodeIfPresent(Int.self, forKey: .durationSeconds)
    metadataState = try values.decode(String.self, forKey: .metadataState)
    downloadState = try values.decode(String.self, forKey: .downloadState)
    playlistIds = try values.decodeIfPresent([String].self, forKey: .playlistIds) ?? []
    playbackPositionSeconds = try values.decode(Int.self, forKey: .playbackPositionSeconds)
    listenCount = try values.decode(Int.self, forKey: .listenCount)
    finishCount = try values.decode(Int.self, forKey: .finishCount)
    lastListenedAt = try values.decodeIfPresent(String.self, forKey: .lastListenedAt)
    tracklistState = try values.decodeIfPresent(TracklistState.self, forKey: .tracklistState) ?? .none
  }
}

public enum TracklistState: String, Decodable, Hashable, Sendable {
  case pending
  case ready
  case none
  case failed

  /// A newer service state must not make the whole Library unreadable.
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? .none
  }
}

public struct Cue: Decodable, Equatable, Identifiable, Sendable {
  public let position: Int
  public let startSeconds: TimeInterval?
  public let artist: String
  public let title: String
  public let appleMusicId: String?
  public let artworkUrl: String?

  public var id: Int { position }
}

public struct Tracklist: Decodable, Equatable, Sendable {
  public let state: TracklistState
  public let cues: [Cue]

  public init(state: TracklistState, cues: [Cue]) {
    self.state = state
    self.cues = cues
  }
}

public enum SetSource: Hashable, Decodable, Sendable {
  case youtube
  case soundcloud
  /// An Apple Music album, which plays through Apple Music and is never downloaded (ADR 0021).
  case appleMusic
  /// The service named a source this build does not know. The Set stays readable and
  /// shows the name the service used, because a source arriving later than the app is a
  /// version skew, not a broken library.
  case unknown(String)

  public var label: String {
    switch self {
    case .youtube: "YouTube"
    case .soundcloud: "SoundCloud"
    case .appleMusic: "Apple Music"
    case .unknown(let name): name
    }
  }

  /// Whether the service can keep this Source's audio. Apple Music audio plays through Apple Music
  /// and is never downloaded (ADR 0021), so nothing offers a Download for it.
  public var isDownloadable: Bool { self != .appleMusic }

  /// Which service a link names, or nil when Orbis takes none of them.
  ///
  /// Only the host is judged here, so a paste is refused without asking the service. The shape of
  /// the path stays the service's judgement: it owns that rule, and its refusal reaches the field
  /// in its own words rather than a second copy of the rule going stale in the app.
  public static func named(by url: URL) -> SetSource? {
    guard let host = url.host()?.lowercased() else { return nil }
    let youTube = [
      "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    ]
    if youTube.contains(host) { return .youtube }
    // The SoundCloud app shares `on.soundcloud.com` short links; the service follows them.
    let soundCloud = [
      "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
    ]
    if soundCloud.contains(host) { return .soundcloud }
    if host == "music.apple.com" { return .appleMusic }
    return nil
  }
}

/// The decode is written out because a source the app does not know must not fail the Set
/// it rides on. A closed enum turned one new word from the service into a library that
/// would not decode at all, and the silent decode that reported it hid the reason.
extension SetSource {
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    switch raw {
    case "youtube": self = .youtube
    case "soundcloud": self = .soundcloud
    case "apple-music": self = .appleMusic
    case let name: self = .unknown(name)
    }
  }
}

public struct LibraryResponse: Decodable, Sendable {
  public let sets: [SavedSet]
}

/// What anyone with a Set's Orbis Link may read about it (ADR 0023): the provider's facts, never
/// a Library's.
public struct SharedSet: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  /// The Source Link, which saving the Set sends.
  public let url: String
  public let title: String
  public let source: SetSource
  public let creator: String?
  public let artworkUrl: String?
}

/// An album an Apple Music search found. Saving its link makes it a Set (ADR 0021).
public struct AppleMusicAlbum: Decodable, Equatable, Identifiable, Sendable {
  public let url: String
  public let title: String
  public let creator: String?
  public let artworkUrl: String?
  public let releasedAt: String?
  public let songCount: Int
  public let durationSeconds: Int?
  public let djMix: Bool
  /// Whether the Set is in this Person's Library.
  public var inLibrary: Bool

  public var id: String { url }
}

public struct AppleMusicSearchResponse: Decodable, Sendable {
  public let albums: [AppleMusicAlbum]
}

/// Where the Find on Apple Music field stands. A search in flight keeps its words, so a late
/// answer to words since replaced is dropped.
public enum AppleMusicSearch: Equatable, Sendable {
  case idle
  case searching(words: String)
  case found([AppleMusicAlbum])
  case failed(message: String)
}

/// How far a download has got. Bytes are the worker's own count, because a converted
/// tunnel carries no content length; the format is what the worker stored, if anything.
public struct AudioState: Decodable, Equatable, Sendable {
  public let state: String
  public let bytesReceived: Int
  public let bytesTotal: Int?
  public let format: String?
}

/// Mirrors the server contract. The count comes from the server so a sidebar does not ask once
/// per playlist, and the creation date is left out because nothing shows it.
public struct Playlist: Identifiable, Decodable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let setCount: Int
}

public struct PlaylistsResponse: Decodable, Sendable {
  public let playlists: [Playlist]
}

public struct ImportPlaylistRequest: Encodable, Sendable {
  public let url: String
}

/// A YouTube playlist being read into a new Playlist in the background. The service answers the
/// import request with one and reports it again on `/events` as each page lands.
public struct PlaylistImportJob: Decodable, Equatable, Sendable {
  /// What the finished import did. `unavailable` counts tracks YouTube no longer serves and
  /// `overLimit` tracks past the Playlist maximum; neither was saved.
  public struct Summary: Decodable, Equatable, Sendable {
    public let added: Int
    public let downloading: Int
    /// Saved while the download queue was full, so they wait for a Download to be asked for.
    public let waiting: Int
    public let unavailable: Int
    public let overLimit: Int
  }

  public enum State: Equatable, Sendable {
    /// `processed` counts the playlist's entries read so far, out of `total` when YouTube said.
    case running(processed: Int, total: Int?)
    case done(Summary)
    case failed(message: String)
  }

  public let id: String
  public let playlist: Playlist
  public let state: State

  private enum CodingKeys: String, CodingKey {
    case id, playlist, state
  }

  private enum StateKeys: String, CodingKey {
    case kind, processed, total, message
  }

  public init(id: String, playlist: Playlist, state: State) {
    self.id = id
    self.playlist = playlist
    self.state = state
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    playlist = try container.decode(Playlist.self, forKey: .playlist)
    let state = try container.nestedContainer(keyedBy: StateKeys.self, forKey: .state)
    switch try state.decode(String.self, forKey: .kind) {
    case "running":
      self.state = .running(
        processed: try state.decode(Int.self, forKey: .processed),
        total: try state.decodeIfPresent(Int.self, forKey: .total))
    case "done":
      self.state = .done(try container.decode(Summary.self, forKey: .state))
    case "failed":
      self.state = .failed(message: try state.decode(String.self, forKey: .message))
    case let kind:
      throw DecodingError.dataCorruptedError(
        forKey: .kind, in: state, debugDescription: "Unknown import state \(kind)")
    }
  }
}

/// A finished import as its summary shows it: the Playlist, what the import did, and the first
/// Sets of the Playlist for the artwork mosaic.
public struct ImportedPlaylist: Equatable, Sendable {
  public let playlist: Playlist
  public let summary: PlaylistImportJob.Summary
  public let firstSets: [SavedSet]

  public init(playlist: Playlist, summary: PlaylistImportJob.Summary, firstSets: [SavedSet]) {
    self.playlist = playlist
    self.summary = summary
    self.firstSets = firstSets
  }
}

/// The one Listening Queue, in play order. `activeSetId` is the Set playing now, and at most one
/// entry ever matches it.
public struct ListeningQueue: Decodable, Equatable, Sendable {
  public let activeSetId: String?
  public let entries: [SavedSet]

  /// The Set playing now, if any. A queue with entries but no active Set is a queue nobody has
  /// started yet.
  public var active: SavedSet? { entries.first { $0.id == activeSetId } }

  public func isActive(_ id: String) -> Bool { id == activeSetId }
}

/// Every queue request answers with the queue itself, so a change is read back from the service
/// rather than assumed from locally applied rules.
public struct QueueResponse: Decodable, Sendable {
  public let queue: ListeningQueue
}

/// The save request. `tags` goes out empty on the first save, and the server takes the title,
/// the creator, and the rest from the link, so a save needs nothing the person has not typed.
public struct SaveSetRequest: Encodable, Sendable {
  public let tags: [String]
  public let url: String
}

/// What the service did about a filed Set's download, as `POST /sets` reports it.
public enum AutoDownload: String, Decodable, Sendable {
  case queued, disabled, ready, inProgress, queueFull, unavailable
}

public struct AutoDownloadReport: Decodable, Sendable {
  public let autoDownloadResult: AutoDownload?
}

/// The two edits the reveal makes. The service caps a title at 200 characters, so a longer one
/// is cut rather than refused.
public struct SetTitleRequest: Encodable, Sendable {
  public let title: String
}

public struct SetTagsRequest: Encodable, Sendable {
  public let tags: [String]
}

/// The Playlists a Set belongs to. The service treats this as the whole membership, so naming
/// another Playlist moves the Set rather than adding a second one.
public struct SetPlaylistsRequest: Encodable, Sendable {
  public let playlistIds: [String]
}

public struct CreatePlaylistRequest: Encodable, Sendable {
  public let name: String
}

public struct PlaylistNameRequest: Encodable, Sendable {
  public let name: String
}

public struct PlaylistMembersRequest: Encodable, Sendable {
  public let setIds: [String]
}

public struct PlaylistMembersResponse: Decodable, Sendable {
  public let sets: [SavedSet]
}

/// Where a queued Set goes: `next` starts after the active Set, `end` goes last.
public enum QueuePlacement: String, Sendable {
  case next
  case end
}

public struct SetIdRequest: Encodable, Sendable {
  public let setId: String
}

public struct QueueEntryRequest: Encodable, Sendable {
  public let placement: String
  public let setId: String
}

/// The order a Playlist plays in. `shuffled` is random; `playlist` keeps the Playlist's own order.
public enum PlaylistOrder: String, Encodable, Sendable {
  case playlist
  case shuffled
}

/// `order` left out keeps Playlist order, which is what a service from before shuffle reads.
public struct PlaylistQueueRequest: Encodable, Sendable {
  public let playlistId: String
  public let order: PlaylistOrder?
}

/// The ranges Heavy Rotation covers. The service ranks each and weighs recent days by range.
public enum ListeningRange: String, CaseIterable, Identifiable, Sendable, Codable {
  case month
  case quarter
  case year

  public var id: Self { self }

  public var title: String {
    switch self {
    case .month: "30 days"
    case .quarter: "3 months"
    case .year: "Past year"
    }
  }

  /// What the collection's subtitle says it holds.
  public var summary: String {
    switch self {
    case .month: "What you've played most this month."
    case .quarter: "What you've played most in the last 3 months."
    case .year: "What you've played most this year."
    }
  }
}

/// What a Collection admits. Nil admits every Set. `source` is the service's name for a source,
/// as the filter stores it.
public struct CollectionFilter: Equatable, Sendable {
  public var name = ""
  public var range: ListeningRange = .month
  public var source: String?
  public var creatorId: String?
  public var tag: String?
  public var minimumMinutes = 0

  public init(
    name: String = "", range: ListeningRange = .month, source: String? = nil,
    creatorId: String? = nil, tag: String? = nil, minimumMinutes: Int = 0
  ) {
    self.name = name
    self.range = range
    self.source = source
    self.creatorId = creatorId
    self.tag = tag
    self.minimumMinutes = minimumMinutes
  }

  /// The sources a filter can name, with the words a person reads.
  public static let sources: [(id: String, label: String)] = [
    ("youtube", "YouTube"), ("soundcloud", "SoundCloud"), ("apple-music", "Apple Music"),
  ]
  /// The least listening a filter can ask for, in minutes.
  public static let minimums = [0, 30, 60, 120]

  public static func minimumLabel(_ minutes: Int) -> String {
    switch minutes {
    case 0: "Any time"
    case ..<60: "\(minutes) min or more"
    case 60: "1 hour or more"
    default: "\(minutes / 60) hours or more"
    }
  }
}

/// One Person's saved filter over their listening, ranked as Heavy Rotation is.
public struct ListeningCollection: Identifiable, Decodable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let range: ListeningRange
  public let source: String?
  public let creatorId: String?
  /// The creator's name when the filter was saved.
  public let creator: String?
  public let tag: String?
  public let minimumMinutes: Int

  public var filter: CollectionFilter {
    CollectionFilter(
      name: name, range: range, source: source, creatorId: creatorId, tag: tag,
      minimumMinutes: minimumMinutes)
  }

  /// The filter in a few words: the range, then whatever narrows it.
  public var summary: String {
    var parts = [range.title]
    if let source, let label = CollectionFilter.sources.first(where: { $0.id == source })?.label {
      parts.append(label)
    }
    if let creator { parts.append(creator) }
    if let tag { parts.append("#\(tag)") }
    if minimumMinutes > 0 { parts.append(CollectionFilter.minimumLabel(minimumMinutes)) }
    return parts.joined(separator: " · ")
  }
}

public struct CollectionsResponse: Decodable, Sendable {
  public let collections: [ListeningCollection]
}

/// Every key is sent, a nil as null, because the service reads a whole filter on each save.
public struct CollectionRequest: Encodable, Sendable {
  public let filter: CollectionFilter

  private enum CodingKeys: String, CodingKey {
    case name, range, source, creatorId, tag, minimumMinutes
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(filter.name, forKey: .name)
    try container.encode(filter.range, forKey: .range)
    try container.encode(filter.source, forKey: .source)
    try container.encode(filter.creatorId, forKey: .creatorId)
    try container.encode(filter.tag, forKey: .tag)
    try container.encode(filter.minimumMinutes, forKey: .minimumMinutes)
  }
}

public struct CollectionQueueRequest: Encodable, Sendable {
  public let collectionId: String
  public let order: String?
}

/// `order` left out keeps the service's ranking.
public struct HeavyRotationQueueRequest: Encodable, Sendable {
  public let range: ListeningRange
  public let order: String?
}

/// A Playback Position in whole seconds. The service bounds it to the Set's own length.
public struct PlaybackPositionRequest: Encodable, Sendable {
  public let seconds: Int
}
