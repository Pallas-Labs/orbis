import Foundation
import MusicKit

/// Where each song of an album starts in the mix, from the songs' lengths. The service sums the
/// same lengths for the Cues, so a Cue's start is a song's start here.
struct MixTimeline: Equatable {
  /// Where each song starts, in seconds from the start of the mix.
  let starts: [TimeInterval]
  let lengths: [TimeInterval]
  let duration: TimeInterval

  /// How close before a song's start a time may fall and still mean that song. The service sums
  /// milliseconds and MusicKit reports seconds, so a Cue start can miss by a rounding error.
  static let tolerance: TimeInterval = 0.25

  /// A song with no length takes no time.
  init(lengths: [TimeInterval?]) {
    let known = lengths.map { length in length.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0 }
    var starts: [TimeInterval] = []
    var total: TimeInterval = 0
    for length in known {
      starts.append(total)
      total += length
    }
    self.starts = starts
    self.lengths = known
    duration = total
  }

  /// The mix time of an offset into a song; not a number when the song or offset is unknown. An
  /// offset past the song's length stays at its end, so the Cue does not change before the song.
  func time(song index: Int, at offset: TimeInterval) -> TimeInterval {
    guard starts.indices.contains(index), offset.isFinite else { return .nan }
    return starts[index] + min(max(offset, 0), lengths[index])
  }

  /// The song that holds a mix time and the offset into it. A time before the mix is its start,
  /// and one past it is the end of the last song.
  func locate(_ time: TimeInterval) -> (song: Int, offset: TimeInterval)? {
    guard time.isFinite, !starts.isEmpty else { return nil }
    let song = starts.lastIndex { $0 <= time + Self.tolerance } ?? 0
    return (song, min(max(time - starts[song], 0), lengths[song]))
  }
}

/// Plays an Apple Music Set through `ApplicationMusicPlayer`, which has its own queue and leaves
/// the Music app's alone. The album's songs are queued in order, and the engine turns MusicKit's
/// song and offset into one clock for the whole mix.
///
/// MusicKit publishes Now Playing and answers the lock screen itself, so `ownsNowPlaying` is true
/// and `AudioPlayer` stays out of both. A pause from the lock screen reaches MusicKit, not
/// `AudioPlayer`, so the engine reports one it did not ask for as `.pausedBySystem`.
///
/// MusicKit does not play in the simulator: this engine is checked on a device.
@MainActor
final class MusicKitEngine: PlaybackEngine {
  private var onEvent: (@MainActor (PlaybackEngineEvent) -> Void)?
  private var loading: Task<Void, Never>?
  private var ticker: Task<Void, Never>?
  private var timeline = MixTimeline(lengths: [])
  /// The queue's entries in album order, so the current entry gives its song.
  private var entries: [MusicPlayer.Queue.Entry] = []
  private var loadFailure: PlaybackDiagnostics.NormalizedError?
  private var isLoaded = false
  private var hasEnded = false
  /// The latest status the engine reported, so a change between ticks is reported once.
  private var lastStatus: MusicPlayer.PlaybackStatus?
  private var lastEntry: MusicPlayer.Queue.Entry.ID?
  /// Set from the engine's own `pause()` until MusicKit reports it, so only a pause the engine did
  /// not ask for reads as one from the system.
  private var pauseRequested = false
  /// The furthest mix time heard while playing, so a player that stops at the end of the last
  /// song is told from one paused in the middle of it.
  private var lastPlayingTime: TimeInterval = 0
  private var seekNumber = 0

  private var player: ApplicationMusicPlayer { .shared }

  var ownsNowPlaying: Bool { true }

  func load(
    _ set: SavedSet, baseURL: URL, token: String,
    onEvent: @escaping @MainActor (PlaybackEngineEvent) -> Void
  ) {
    self.onEvent = onEvent
    loading = Task { [weak self] in
      do {
        guard let albumID = set.appleMusicAlbumID else { throw AppleMusicError.noAlbum }
        guard MusicAuthorization.currentStatus == .authorized else {
          throw AppleMusicError.notAuthorized
        }
        let request = MusicCatalogResourceRequest<Album>(
          matching: \.id, equalTo: MusicItemID(albumID))
        guard let album = try await request.response().items.first else {
          throw AppleMusicError.noAlbum
        }
        let tracks = try await album.with([.tracks]).tracks ?? []
        guard !tracks.isEmpty else { throw AppleMusicError.noAlbum }
        guard let self, !Task.isCancelled else { return }
        let player = self.player
        player.state.repeatMode = MusicPlayer.RepeatMode.none
        player.state.shuffleMode = .off
        player.queue = ApplicationMusicPlayer.Queue(for: tracks)
        try await Self.prepareToPlay()
        guard !Task.isCancelled else { return }
        self.timeline = MixTimeline(lengths: tracks.map(\.duration))
        self.entries = Array(player.queue.entries)
        self.isLoaded = true
        self.report(.statusChanged)
        self.report(.durationChanged)
        self.startTicking()
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.loadFailure = PlaybackDiagnostics.NormalizedError(error)
        self.report(.statusChanged)
      }
    }
  }

  private func report(_ event: PlaybackEngineEvent) {
    onEvent?(event)
  }

  /// Reads MusicKit twice a second, as the AVPlayer engine's clock ticks. A change in the
  /// player's status or song is reported on the tick that sees it.
  private func startTicking() {
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        self.poll()
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  private func poll() {
    guard isLoaded, !hasEnded else { return }
    // MusicKit can fill in the entries after the queue is prepared.
    if entries.isEmpty { entries = Array(player.queue.entries) }
    let status = player.state.playbackStatus
    let entry = player.queue.currentEntry?.id
    let time = currentTime
    if status == .playing, time.isFinite { lastPlayingTime = max(lastPlayingTime, time) }
    if status != lastStatus || entry != lastEntry {
      let wasPlaying = lastStatus == .playing
      lastStatus = status
      lastEntry = entry
      if reachedEnd(status, entry: entry) {
        hasEnded = true
        report(.ended)
        return
      }
      if wasPlaying, status == .paused || status == .stopped, !pauseRequested {
        report(.pausedBySystem)
      }
      if status != .playing { pauseRequested = false }
      report(.rateChanged)
      report(.timeControlChanged)
    }
    report(.tick)
  }

  /// MusicKit stops after the last song, and may leave it current or clear the entry. Either way
  /// it is the end only when the last song was heard close to its end.
  private func reachedEnd(_ status: MusicPlayer.PlaybackStatus, entry: MusicPlayer.Queue.Entry.ID?)
    -> Bool
  {
    guard status != .playing || entry == nil, !pauseRequested else { return false }
    return lastPlayingTime >= timeline.duration - 3
  }

  func play() {
    pauseRequested = false
    Task { [weak self] in
      do {
        try await Self.startPlaying()
      } catch {
        self?.report(.failed(PlaybackDiagnostics.NormalizedError(error)))
      }
    }
  }

  /// MusicKit's async calls run off the main actor, and its player is not `Sendable`, so these
  /// read the shared player where they run rather than carry it from the main actor.
  @concurrent private nonisolated static func prepareToPlay() async throws {
    try await ApplicationMusicPlayer.shared.prepareToPlay()
  }

  @concurrent private nonisolated static func startPlaying() async throws {
    try await ApplicationMusicPlayer.shared.play()
  }

  func pause() {
    guard isLoaded else { return }
    // A pause of a player that is already quiet changes nothing for the next status to answer,
    // and would hide the next pause from the lock screen.
    pauseRequested = player.state.playbackStatus == .playing
    player.pause()
  }

  /// Moves to the song that holds the mix time, then to the offset in it. MusicKit changes the
  /// song on its own schedule, so the offset waits until the new song is current.
  func seek(to seconds: TimeInterval, completion: @escaping @MainActor (Bool) -> Void) {
    seekNumber += 1
    let number = seekNumber
    guard isLoaded, let target = timeline.locate(seconds), entries.indices.contains(target.song)
    else {
      completion(false)
      return
    }
    let entry = entries[target.song]
    let player = self.player
    if player.queue.currentEntry?.id == entry.id {
      player.playbackTime = target.offset
      lastPlayingTime = seconds
      completion(true)
      return
    }
    player.queue.currentEntry = entry
    Task { [weak self] in
      let deadline = ContinuousClock.now + .seconds(5)
      while player.queue.currentEntry?.id != entry.id, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(50))
      }
      guard let self, self.seekNumber == number else {
        completion(false)
        return
      }
      guard player.queue.currentEntry?.id == entry.id else {
        completion(false)
        return
      }
      player.playbackTime = target.offset
      self.lastPlayingTime = seconds
      completion(true)
    }
  }

  func invalidate() {
    onEvent = nil
    loading?.cancel()
    ticker?.cancel()
    seekNumber += 1
    if isLoaded { player.stop() }
  }

  /// The song MusicKit is on, by its place in the album.
  private var currentSong: Int? {
    guard let id = player.queue.currentEntry?.id else { return nil }
    return entries.firstIndex { $0.id == id }
  }

  var currentTime: TimeInterval {
    guard isLoaded else { return .nan }
    if hasEnded { return timeline.duration }
    guard let song = currentSong else { return .nan }
    return timeline.time(song: song, at: player.playbackTime)
  }

  var duration: TimeInterval { isLoaded ? timeline.duration : .nan }

  var rate: Float {
    guard isLoaded, player.state.playbackStatus == .playing else { return 0 }
    return player.state.playbackRate
  }

  var status: PlaybackEngineStatus {
    if loadFailure != nil { return .failed }
    return isLoaded ? .ready : .unknown
  }

  var timeControl: PlaybackEngineTimeControl {
    guard isLoaded else { return .paused }
    switch player.state.playbackStatus {
    case .playing, .seekingForward, .seekingBackward: return .playing
    default: return .paused
    }
  }

  var waitingReason: PlaybackDiagnostics.WaitingReason { .none }
  var waitingReasonName: String? { nil }
  var failure: PlaybackDiagnostics.NormalizedError? { loadFailure }
  var buffer: PlaybackEngineBuffer { PlaybackEngineBuffer() }
  var access: PlaybackEngineAccess? { nil }
}

/// Why an Apple Music Set could not load.
enum AppleMusicError: Error {
  /// The Set names no album, or the catalog has none by that id.
  case noAlbum
  /// This device has no Apple Music access, so the queue advanced into a Set it cannot play.
  case notAuthorized
}
