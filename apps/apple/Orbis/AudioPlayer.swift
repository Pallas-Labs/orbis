import AVFoundation
import MediaPlayer
import os

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// What the player did and why, in Console under `app.orbis` / `player`. Positions, states and
/// normalized error codes are public; a Set's id is hashed so two lines can be matched without
/// naming it, and titles, addresses, tokens and SDK error text are never written.
private let logger = Logger(subsystem: "app.orbis", category: "player")

/// A position or length for a log line, to a tenth of a second; "unknown" when there is none.
private func clock(_ seconds: TimeInterval?) -> String {
  guard let seconds, seconds.isFinite else { return "unknown" }
  return String(format: "%.1fs", seconds)
}

/// Plays one Set's retained audio, streamed from the service with the device token.
///
/// Everything here stays on the main actor: playback control is not CPU-bound, and
/// AVPlayer does its own threading. Observers that the system can call from any thread
/// hop back here and read the player's current values before touching state. The audio
/// session and the artwork decode are the exceptions, and run off the main actor: see
/// `sessionWork` and `artwork(from:)`.
@MainActor
@Observable
final class AudioPlayer {
  /// Where playback stands, and what the person last asked for. One value holds both, so a
  /// press and a late callback can never disagree about whether sound is wanted: `.loading`
  /// and `.playing` mean the person asked to hear the Set, `.paused` means they asked for
  /// quiet, and `.interrupted` means the system took the sound away while they wanted it.
  /// Sound starts only after the audio session and the latest seek are ready.
  enum PlaybackState: Equatable {
    case idle
    /// Sound is wanted and has not started: the session is coming up or the stream is filling.
    case loading
    case playing
    case paused
    /// The audio session reported an interruption while sound was wanted.
    case interrupted
    case failed(String)
  }

  enum Command {
    case play, pause, toggle
    case seek(TimeInterval)
  }

  @ObservationIgnored var onCommand: ((Command) -> Bool)?
  @ObservationIgnored var onReloadNeeded: ((String, TimeInterval) -> Void)?

  private(set) var state = PlaybackState.idle {
    didSet {
      let before = diagnosticState(oldValue)
      let after = diagnosticState(state)
      if before != after { record(.state(.init(from: before, to: after))) }
    }
  }
  private(set) var currentSetId: String?
  private(set) var currentTitle = ""
  /// Who made the Set, for the artist line the system draws under the title.
  private(set) var currentArtist: String?
  private var cues: [Cue] = []
  /// Where each Cue starts, for the marks along the seek bar.
  var cueStarts: [TimeInterval] { cues.compactMap(\.startSeconds) }
  var currentCue: Cue? {
    cues.last { cue in cue.startSeconds.map { $0 <= elapsed } ?? false }
  }
  /// The Cue the mix moves into next, once it has a start time.
  var nextCue: Cue? {
    cues.first { cue in cue.startSeconds.map { $0 > elapsed } ?? false }
  }
  /// The Set's artwork, once it has arrived, for the lock screen, the Dynamic Island, and
  /// Control Center. Fetched after playback starts so a slow image never delays the sound.
  private var currentArtwork: MPMediaItemArtwork?
  private var artworkFetch: Task<Void, Never>?
  private(set) var elapsed: TimeInterval = 0
  private(set) var duration: TimeInterval?

  var settledPosition: TimeInterval? {
    guard pendingSeek == nil, !isSeeking,
      let seconds = player?.currentTime().seconds, seconds.isFinite, seconds >= 0
    else { return nil }
    return seconds
  }

  private(set) var player: AVPlayer?
  private var timeObserver: Any?
  private var statusObservation: NSKeyValueObservation?
  private var durationObservation: NSKeyValueObservation?
  private var loadedRangesObservation: NSKeyValueObservation?
  private var rateObservation: NSKeyValueObservation?
  private var stallObservation: NSKeyValueObservation?

  /// The Set's length as the service measured it, used until the item reports its own. Some
  /// streams never do (an Ogg file, a VBR MP3 without a header), and a seek bar with no length
  /// cannot be dragged.
  private var serviceDuration: TimeInterval?

  /// Where a resumed Set should start once its item is ready. AVPlayer refuses a seek before the
  /// item knows its own timeline, so the position waits here until it does.
  private var pendingSeek: TimeInterval?
  private var isSeeking = false
  private var sessionReady = false
  private var itemNeedsReload = false

  private struct TimelineSample {
    let mediaTime: TimeInterval
    let uptime: TimeInterval
    let rate: Float
  }
  @ObservationIgnored private var timelineSample: TimelineSample?
  @ObservationIgnored private var lastTimelineLog: TimeInterval = 0
  @ObservationIgnored private var soundRequestedAt: TimeInterval?
  @ObservationIgnored private var hasStartedSound = false
  @ObservationIgnored private var completionReported = false
  /// Which seek is the newest. A seek that a later one interrupts still calls back, unfinished,
  /// and must not end the wait for the later one: a tick in between would put the old position
  /// back on the bar.
  @ObservationIgnored private var latestSeek = 0
  @ObservationIgnored private let diagnostics = PlaybackDiagnostics()
  @ObservationIgnored private var lastDiagnosticSample: TimeInterval = 0
  @ObservationIgnored private var diagnosticsEpoch = 0

  /// Called with the Set that has just played to its natural end, so the caller can finish its
  /// Listen and start whatever the Listening Queue holds next. Nothing is called when playback
  /// stops early: that Set keeps its position and its Listen.
  @ObservationIgnored var onFinished: ((String) -> Void)?

  /// Which observations are current: a callback carrying an older number is dropped.
  private var playbackGeneration = 0

  /// The audio session work still in flight. Bringing the session up or letting it go talks
  /// to the audio server and takes long enough to freeze a screen that waits for it, so it
  /// happens off the main actor. Each step waits for the one before it, because a stop that
  /// deactivates must never land after the play that follows it.
  private(set) var sessionWork: Task<Void, Never>?

  /// How the audio session comes up and goes away. The system's in the app; a test passes its own
  /// to hold activation open and press buttons while it is pending.
  struct Session: Sendable {
    var start: @Sendable () async -> Bool
    var end: @Sendable () async -> Void

    static let system = Session(
      start: { await AudioPlayer.startSession() },
      end: { await AudioPlayer.endSession() }
    )
  }

  private let session: Session

  /// The registrations this player made outside itself, held nonisolated so `deinit`, which
  /// cannot hop actors, takes back exactly its own handlers instead of clearing the shared
  /// command center. Ignored by observation: nothing reads them.
  ///
  /// `nonisolated(unsafe)` is sound only while this holds: every read and write outside
  /// `deinit` happens on the main actor (in `init`, `setupCommands`, `stop`, and the observe
  /// methods), and `deinit` runs when no other reference is left, so it has the arrays to
  /// itself. A write from anywhere else would be a data race the compiler no longer checks.
  @ObservationIgnored nonisolated(unsafe) private var commandTargets: [Any] = []
  @ObservationIgnored nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
  private var isObservingInterruptions = false

  init(session: Session = .system) {
    self.session = session
    setupCommands()
  }

  func playbackReport() -> String {
    diagnostics.report(current: diagnosticSnapshot())
  }

  func diagnosticsTail() -> Int { diagnostics.tail }

  func diagnostics(after sequence: Int, limit: Int) -> PlaybackDiagnostics.Slice {
    diagnostics.slice(after: sequence, limit: limit)
  }

  func resetDiagnostics() {
    diagnosticsEpoch += 1
    diagnostics.reset()
    lastDiagnosticSample = 0
  }

  func recordActivation(
    _ phase: PlaybackDiagnostics.ActivationEvent.Phase, generation: Int,
    wantsSound: Bool, target: TimeInterval?, latency: TimeInterval?
  ) {
    record(
      .activation(
        .init(
          phase: phase, generation: generation, wantsSound: wantsSound,
          target: .init(target), requestDuration: .init(latency))))
  }

  func recordError(_ error: any Error) {
    record(.error(.init(error)))
  }

  private func record(_ event: PlaybackDiagnostics.Event) {
    diagnostics.record(event, snapshot: diagnosticSnapshot())
  }

  private func diagnosticSnapshot() -> PlaybackDiagnostics.Snapshot {
    let engine = player
    let item = engine?.currentItem
    let ranges =
      item?.loadedTimeRanges.prefix(8).compactMap { value -> PlaybackDiagnostics.BufferRange? in
        let range = value.timeRangeValue
        guard range.start.seconds.isFinite, range.duration.seconds.isFinite else { return nil }
        return .init(start: .init(range.start.seconds), duration: .init(range.duration.seconds))
      } ?? []
    return PlaybackDiagnostics.Snapshot(
      state: diagnosticState(state), itemState: diagnosticItemState(item?.status),
      waitingReason: diagnosticWaitingReason(engine?.reasonForWaitingToPlay),
      actualTime: .init(engine?.currentTime().seconds), displayedTime: .init(elapsed),
      duration: .init(duration), rate: .init(engine.map { Double($0.rate) }),
      sessionReady: sessionReady, pendingSeek: .init(pendingSeek), seekInFlight: isSeeking,
      playbackGeneration: playbackGeneration, seekID: latestSeek,
      bufferEmpty: item?.isPlaybackBufferEmpty ?? false,
      bufferFull: item?.isPlaybackBufferFull ?? false,
      likelyToKeepUp: item?.isPlaybackLikelyToKeepUp ?? false,
      bufferRanges: ranges, access: item?.accessLog()?.events.last.map(diagnosticAccessMetrics),
      setId: currentSetId)
  }

  private func diagnosticState(_ state: PlaybackState) -> PlaybackDiagnostics.PlaybackState {
    switch state {
    case .idle: .idle
    case .loading: .loading
    case .playing: .playing
    case .paused: .paused
    case .interrupted: .interrupted
    case .failed: .failed
    }
  }

  private func diagnosticItemState(_ status: AVPlayerItem.Status?) -> PlaybackDiagnostics.ItemState {
    switch status {
    case .none: .none
    case .some(.unknown): .unknown
    case .some(.readyToPlay): .ready
    case .some(.failed): .failed
    case .some: .unknown
    }
  }

  private func diagnosticWaitingReason(_ reason: AVPlayer.WaitingReason?)
    -> PlaybackDiagnostics.WaitingReason
  {
    switch reason?.rawValue {
    case nil: .none
    case "AVPlayerWaitingToMinimizeStallsReason": .minimizingStalls
    case "AVPlayerWaitingWhileEvaluatingBufferingRateReason": .evaluatingBufferingRate
    case "AVPlayerWaitingWithNoItemToPlayReason": .noItem
    case "AVPlayerWaitingDuringInterstitialEventReason": .interstitial
    default: .other
    }
  }

  private func diagnosticAccessMetrics(_ entry: AVPlayerItemAccessLogEvent)
    -> PlaybackDiagnostics.AccessMetrics
  {
    .init(
      bytesTransferred: entry.numberOfBytesTransferred,
      transferDuration: .init(entry.transferDuration),
      observedBitrate: .init(entry.observedBitrate),
      indicatedBitrate: .init(entry.indicatedBitrate), stalls: entry.numberOfStalls,
      downloadedDuration: .init(entry.segmentsDownloadedDuration))
  }

  deinit {
    // A nonisolated deinit cannot touch MainActor state, so everything owned here
    // is released through stop(), which every play() enters through first. What
    // remains is global, and only this player's own registrations are taken back.
    let center = MPRemoteCommandCenter.shared()
    let commands = [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
      center.skipBackwardCommand, center.skipForwardCommand, center.changePlaybackPositionCommand,
      center.nextTrackCommand, center.previousTrackCommand,
    ]
    for command in commands {
      for target in commandTargets { command.removeTarget(target) }
      command.isEnabled = false
    }
    let notifications = NotificationCenter.default
    for observer in observers {
      notifications.removeObserver(observer)
    }
  }

  /// The header fields an asset needs so the service trusts the stream. The token
  /// travels here, never in the URL. The SDK no longer declares the key (it is gone
  /// from the Xcode 26 headers on every platform), so it is spelled as the literal
  /// string AVFoundation has always honored. If playback ever answers 401 where the
  /// same token works over URLSession, this key stopped being honored and the asset
  /// needs a resource-loader delegate instead.
  static let assetHeaderFieldsKey = "AVURLAssetHTTPHeaderFieldsKey"

  static func assetOptions(token: String) -> [String: Any] {
    [assetHeaderFieldsKey: ["Authorization": "Bearer \(token)"]]
  }

  static func asset(url: URL, token: String) -> AVURLAsset {
    AVURLAsset(url: url, options: assetOptions(token: token))
  }

  /// The Set's own audio file under the service address.
  static func fileURL(setID: String, baseURL: URL) -> URL {
    baseURL.appending(path: "sets/\(setID)/audio")
  }

  /// The Now Playing dictionary for a moment in time. Elapsed time and rate are set
  /// at play, pause, seek, and track change only: the system extrapolates between
  /// them, and a timer would only add jitter.
  static func nowPlayingInfo(
    title: String,
    artist: String? = nil,
    cue: Cue? = nil,
    artwork: MPMediaItemArtwork? = nil,
    duration: TimeInterval?,
    elapsed: TimeInterval,
    isPlaying: Bool
  ) -> [String: Any] {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: cue?.title ?? title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
      // A Set is one long recording, which the system otherwise treats as a song and
      // offers to skip past.
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let cue {
      info[MPMediaItemPropertyArtist] = cue.artist
      info[MPMediaItemPropertyAlbumTitle] = title
    } else if let artist, !artist.isEmpty {
      info[MPMediaItemPropertyArtist] = artist
    }
    if let artwork {
      info[MPMediaItemPropertyArtwork] = artwork
    }
    if let duration {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    return info
  }

  /// The image the provider offered, as the system wants it: a handler that returns the same
  /// image at any size, since the provider gives one size and the system scales it.
  ///
  /// `@concurrent`, so the decode and crop run off the main actor rather than on the thread
  /// that draws the screen. Nonisolated for a second reason too: the system calls the handler
  /// on its own Now Playing queue whenever it wants the image at a new size, so a handler built
  /// on the main actor traps the moment it is asked. Nothing in here touches the main actor:
  /// the image is already decoded and the handler only hands back what it captured.
  @concurrent nonisolated static func artwork(from data: Data) async -> sending MPMediaItemArtwork? {
    #if os(macOS)
      guard let source = NSImage(data: data),
        let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
      else { return nil }
      let cropped = widescreen(cg)
      let image = NSImage(
        cgImage: cropped, size: NSSize(width: cropped.width, height: cropped.height))
    #else
      guard let source = UIImage(data: data), let cg = source.cgImage else { return nil }
      // Decoded here rather than on first draw, so the pixels are ready before the system asks
      // and the uncropped original is not kept alive behind the crop.
      let cropped = UIImage(cgImage: widescreen(cg))
      let image = cropped.preparingForDisplay() ?? cropped
    #endif
    return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
  }

  /// The middle 16:9 band of an image that is taller than 16:9; an image that is already as
  /// wide, or wider, is returned as it is.
  nonisolated static func widescreen(_ image: CGImage) -> CGImage {
    let width = image.width
    let height = image.height
    let target = width * 9 / 16
    // A few pixels of tolerance, so a 1280×721 render is not cropped for nothing.
    guard height > target + 2 else { return image }
    let rect = CGRect(x: 0, y: (height - target) / 2, width: width, height: target)
    return image.cropping(to: rect) ?? image
  }

  /// Brings the audio session up for playback and answers whether it came up.
  ///
  /// `@concurrent`, so none of it runs on the main actor whatever the caller's isolation:
  /// activation is a slow call that the system warns will freeze a screen that makes it. From
  /// iOS 27 the framework offers a handler and never blocks at all; before that the blocking
  /// call is the only one there is, and running it here keeps it off the main thread just the
  /// same.
  @concurrent fileprivate nonisolated static func startSession() async -> Bool {
    #if os(macOS)
      return true
    #else
      let session = AVAudioSession.sharedInstance()
      do {
        try session.setCategory(.playback, mode: .default)
      } catch {
        logger.error("Audio session category refused: \(Self.describe(error), privacy: .public)")
        return false
      }
      if #available(iOS 27.0, tvOS 27.0, *) {
        return await withCheckedContinuation { continuation in
          session.activate(options: []) { activated, error in
            if !activated {
              logger.error(
                "Audio session did not activate: \(error.map(Self.describe) ?? "no error", privacy: .public)"
              )
            }
            continuation.resume(returning: activated)
          }
        }
      }
      do {
        try session.setActive(true)
        return true
      } catch {
        logger.error("Audio session did not activate: \(Self.describe(error), privacy: .public)")
        return false
      }
    #endif
  }

  /// Lets the audio session go, off the main actor for the same reason, and tells whoever this
  /// playback interrupted that it may resume. Waits for the answer, so the next activation
  /// queued behind it cannot be undone by this deactivation landing late.
  @concurrent fileprivate nonisolated static func endSession() async {
    #if !os(macOS)
      let session = AVAudioSession.sharedInstance()
      if #available(iOS 27.0, tvOS 27.0, *) {
        await withCheckedContinuation { continuation in
          session.deactivate(options: .notifyOthersOnDeactivation) { _, _ in
            continuation.resume()
          }
        }
      } else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
      }
    #endif
  }

  func play(
    set: SavedSet, baseURL: URL, token: String, startAt: TimeInterval = 0,
    autoplay: Bool = true
  ) {
    stop()
    currentSetId = set.id
    currentTitle = set.title
    currentArtist = set.creator
    cues = []
    currentArtwork = nil
    serviceDuration = set.durationSeconds.flatMap { $0 > 0 ? TimeInterval($0) : nil }
    duration = serviceDuration
    let start = boundedPosition(startAt)
    elapsed = start
    isSeeking = false
    pendingSeek = start > 0 ? start : nil
    state = autoplay ? .loading : .paused
    soundRequestedAt = autoplay ? ProcessInfo.processInfo.systemUptime : nil
    let span = "from \(clock(start)) of \(clock(serviceDuration))"
    logger.info("Play \(set.id, privacy: .private(mask: .hash)) \(span, privacy: .public)")
    // The asset is the Set's own audio file, not the service root: loading the
    // root answers 404 and the player fails without ever asking for audio.
    let item = AVPlayerItem(
      asset: Self.asset(url: Self.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    playbackGeneration += 1
    let generation = playbackGeneration
    record(.item(.init(phase: .installed, error: nil)))
    // KVO can call back on any thread, so each handler only hops here. Each hop is its own
    // task, and two of them can land in either order, so the hop reads the player's current
    // values rather than the ones that fired it: a late hop then repeats the latest state
    // instead of undoing it. The generation check drops a callback that a stopped or replaced
    // player queued before this one took over.
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation,
          let item = self.player?.currentItem
        else { return }
        self.itemStatusChanged(item)
      }
    }
    // The item can learn its length after it is ready, or revise it once more of a stream has
    // arrived; the seek bar follows.
    durationObservation = item.observe(\.duration, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation,
          let item = self.player?.currentItem
        else { return }
        self.durationChanged(item.duration.seconds)
      }
    }
    loadedRangesObservation = item.observe(\.loadedTimeRanges, options: [.new]) {
      [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, self.state == .loading else {
          return
        }
        // Progressive file playback can pause on starvation and needs Play when data returns.
        self.playIfReady()
      }
    }
    rateObservation = player.observe(\.rate, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, let player = self.player
        else { return }
        self.rateChanged(rate: player.rate)
      }
    }
    stallObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, let player = self.player
        else { return }
        self.logWaiting(player)
        self.stallChanged(status: player.timeControlStatus)
      }
    }
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] _ in
      // Registered on the main queue, so this closure is already on the main actor; assuming it
      // avoids a task on every tick.
      MainActor.assumeIsolated {
        guard let self, self.playbackGeneration == generation else { return }
        self.recordPeriodicSnapshotIfNeeded()
        self.sampleTimeline()
        guard !self.isSeeking, self.pendingSeek == nil,
          let seconds = self.player?.currentTime().seconds, seconds.isFinite
        else { return }
        let previousCue = self.currentCue?.position
        self.elapsed = seconds
        if self.currentCue?.position != previousCue {
          self.publishNowPlaying(isPlaying: self.state == .playing)
        }
      }
    }
    observeCompletion(of: item, generation: generation)
    observeFailures(of: item, generation: generation)
    observeInterruptions()
    // The screen already reads as loading, so the sound can wait for the session rather than
    // the screen waiting for both.
    if autoplay { startPlayback() }
    fetchArtwork(for: set, generation: generation)
  }

  /// Starts the sound once the audio session is up. Every start goes through here (the first
  /// play, a resume, the lock screen's Play, the end of an interruption), so none plays without
  /// an active session. It queues behind the session work already in flight and asks for the
  /// session again each time: asking costs little when the session is up, and is what brings it
  /// back after a failure or an interruption took it down.
  ///
  /// What the person asks for while it waits wins. A pause in the meantime leaves the state at
  /// `.paused`, and the player stays quiet when the session answers. A generation that has
  /// moved on drops what comes back.
  ///
  /// Only the latest start acts. One queued behind it answers for the newer press, so an earlier
  /// start that fails cannot mark the Set failed under it, and one that succeeds does not play
  /// ahead of it.
  private func startPlayback() {
    sessionReady = false
    timelineSample = nil
    let generation = playbackGeneration
    latestStart += 1
    let start = latestStart
    let previous = sessionWork
    let startSession = session.start
    record(
      .session(
        .init(phase: .startRequested, requestID: start, playbackGeneration: generation)))
    sessionWork = Task { [weak self] in
      await previous?.value
      let started = await startSession()
      guard let self, self.playbackGeneration == generation, self.latestStart == start,
        self.wantsSound
      else { return }
      guard started else {
        self.record(
          .session(.init(phase: .failed, requestID: start, playbackGeneration: generation)))
        logger.error("Playback not started: the audio session is unavailable")
        self.player?.pause()
        self.state = .failed("Audio could not start on this device.")
        self.publishNowPlaying(isPlaying: false)
        return
      }
      self.sessionReady = true
      self.record(
        .session(.init(phase: .ready, requestID: start, playbackGeneration: generation)))
      logger.debug(
        "Session ready generation=\(generation, privacy: .public) start=\(start, privacy: .public)")
      self.playIfReady()
    }
  }

  private func playIfReady() {
    guard sessionReady, wantsSound, !itemNeedsReload, pendingSeek == nil, !isSeeking,
      let player, player.currentItem?.status != .failed
    else { return }
    if player.rate == 0 { player.play() }
    stallChanged(status: player.timeControlStatus)
  }

  /// Which `startPlayback()` call is the newest; an older one that finishes first does nothing.
  @ObservationIgnored private var latestStart = 0

  /// True while the person has asked to hear the Set, whether or not the sound has started.
  private var wantsSound: Bool {
    state == .loading || state == .playing
  }

  /// The largest image the provider offered, fetched off the play path. A stale fetch, one that
  /// lands after another Set took over, is dropped by the generation it was made under.
  private func fetchArtwork(for set: SavedSet, generation: Int) {
    artworkFetch?.cancel()
    guard let url = (set.artworkLargeUrl ?? set.artworkUrl).flatMap(URL.init(string:)) else {
      return
    }
    artworkFetch = Task { [weak self] in
      guard
        let (data, response) = try? await URLSession.shared.data(
          for: URLRequest(url: url, timeoutInterval: 15)),
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
      else { return }
      let artwork = await Self.artwork(from: data)
      guard let self, self.playbackGeneration == generation, let artwork else { return }
      self.currentArtwork = artwork
      self.publishNowPlaying(isPlaying: self.state == .playing)
    }
  }

  /// Quiets the Set and records that the person asked for quiet, so a session start still in
  /// flight does not play it when it lands.
  func pause(origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .pause, origin: origin)))
    logger.debug("Command pause generation=\(self.playbackGeneration, privacy: .public)")
    guard onCommand?(.pause) != true else { return }
    pausePlayback()
  }

  private func pausePlayback() {
    let requestedAt = ProcessInfo.processInfo.systemUptime
    timelineSample = nil
    soundRequestedAt = nil
    logger.debug("Pause from \(String(describing: self.state), privacy: .public)")
    if wantsSound || state == .interrupted {
      state = .paused
    }
    player?.pause()
    let delay = ProcessInfo.processInfo.systemUptime - requestedAt
    logger.debug(
      "Pause applied generation=\(self.playbackGeneration, privacy: .public) duration=\(delay, privacy: .public) rate=\(self.player?.rate ?? 0, privacy: .public)"
    )
    publishNowPlaying(isPlaying: false)
  }

  /// Plays the Set in the player again. Waits for the audio session like any start, so a resume
  /// before the session is up, or after a failure or interruption took it down, still has one.
  /// An item that failed to load has nothing to resume; the caller starts the Set again.
  func resume(origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .play, origin: origin)))
    logger.debug("Command play generation=\(self.playbackGeneration, privacy: .public)")
    guard onCommand?(.play) != true else { return }
    resumePlayback()
  }

  private func resumePlayback() {
    if let currentSetId, itemNeedsReload || player?.currentItem?.status == .failed {
      onReloadNeeded?(currentSetId, elapsed)
      return
    }
    guard let item = player?.currentItem, item.status != .failed else {
      logger.notice("Resume ignored: no playable item")
      return
    }
    logger.debug("Resume from \(String(describing: self.state), privacy: .public)")
    switch state {
    case .paused, .interrupted, .failed:
      // Now Playing turns to playing when the sound does, in `startPlayback()`.
      state = .loading
      soundRequestedAt = ProcessInfo.processInfo.systemUptime
      applyPendingSeek()
      startPlayback()
    case .loading:
      playIfReady()
    case .idle, .playing:
      return
    }
  }

  /// What a single play/pause control does: pauses while sound is wanted, including while it
  /// is still loading, and resumes otherwise.
  func togglePlayPause(origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .toggle, origin: origin)))
    logger.debug("Command toggle generation=\(self.playbackGeneration, privacy: .public)")
    guard onCommand?(.toggle) != true else { return }
    if wantsSound {
      pausePlayback()
    } else {
      resumePlayback()
    }
  }

  /// Moves the playhead. An item that is ready moves now; one still loading keeps the position
  /// and moves once it is ready, whether or not it has reported a length by then. Waiting for
  /// the length instead stranded the seek on a stream that never reports one: the bar froze at
  /// the target and the sound never moved.
  func seek(to seconds: TimeInterval, origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .seek, origin: origin, target: .init(seconds))))
    logger.debug("Command seek generation=\(self.playbackGeneration, privacy: .public)")
    guard seconds.isFinite, onCommand?(.seek(seconds)) != true else { return }
    guard let player, let item = player.currentItem, state != .idle else {
      logger.notice("Seek to \(clock(seconds), privacy: .public) ignored: nothing in the player")
      return
    }
    let target = boundedPosition(seconds)
    elapsed = target
    timelineSample = nil
    guard item.status == .readyToPlay else {
      if wantsSound { state = .loading }
      player.pause()
      logger.debug("Seek to \(clock(target), privacy: .public) held until the item is ready")
      pendingSeek = target
      publishNowPlaying(isPlaying: false)
      return
    }
    pendingSeek = nil
    move(to: target)
    publishNowPlaying(isPlaying: state == .playing)
  }

  /// Whether the Set's Tracklist has start times to step between.
  var canSkipCues: Bool { !cueStarts.isEmpty }

  /// Jumps to the start of the next Cue. Past the last one there is nowhere to go.
  func skipToNextCue(origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .nextCue, origin: origin)))
    guard let start = nextCue?.startSeconds else { return }
    logger.debug("Next track at \(clock(start), privacy: .public)")
    seek(to: start, origin: .internalOperation)
  }

  /// Jumps back the way a music player's back button does: to the start of this Cue, or to the
  /// previous one when this one has barely begun.
  func skipToPreviousCue(origin: PlaybackDiagnostics.Origin = .app) {
    record(.command(.init(kind: .previousCue, origin: origin)))
    let starts = cueStarts.filter { $0 <= elapsed }
    guard let current = starts.last else {
      seek(to: 0, origin: .internalOperation)
      return
    }
    if elapsed - current > 3 || starts.count < 2 {
      seek(to: current, origin: .internalOperation)
    } else {
      seek(to: starts[starts.count - 2], origin: .internalOperation)
    }
  }

  func setCues(_ cues: [Cue]) {
    guard self.cues != cues else { return }
    self.cues = cues
    publishNowPlaying(isPlaying: state == .playing)
  }

  func stop() {
    let hadPlayback = player != nil || sessionWork != nil
    let endingGeneration = playbackGeneration
    let epoch = diagnosticsEpoch
    if player != nil { record(.command(.init(kind: .stop, origin: .internalOperation))) }
    // Anything the player in hand still has queued belongs to a playback that is over.
    playbackGeneration += 1
    artworkFetch?.cancel()
    artworkFetch = nil
    currentArtwork = nil
    cues = []
    if player != nil {
      logger.debug("Stop at \(clock(self.elapsed), privacy: .public)")
    }
    player?.pause()
    dropPlayerObservers()
    player = nil
    pendingSeek = nil
    isSeeking = false
    sessionReady = false
    itemNeedsReload = false
    timelineSample = nil
    lastTimelineLog = 0
    soundRequestedAt = nil
    hasStartedSound = false
    completionReported = false
    lastDiagnosticSample = 0
    serviceDuration = nil
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
    isObservingInterruptions = false
    currentSetId = nil
    state = .idle
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    let previous = sessionWork
    let endSession = session.end
    let requestID = latestStart
    if hadPlayback {
      record(
        .session(
          .init(
            phase: .endRequested, requestID: requestID,
            playbackGeneration: endingGeneration)))
    }
    sessionWork = Task { [weak self] in
      await previous?.value
      await endSession()
      guard hadPlayback, let self, self.diagnosticsEpoch == epoch else { return }
      self.record(
        .session(
          .init(
            phase: .ended, requestID: requestID, playbackGeneration: endingGeneration)))
    }
  }

  private func itemStatusChanged(_ item: AVPlayerItem) {
    switch item.status {
    case .readyToPlay:
      let reported = item.duration.seconds
      let service = clock(serviceDuration)
      logger.info(
        "Item ready; length \(clock(reported), privacy: .public), service says \(service, privacy: .public)"
      )
      record(.item(.init(phase: .ready, error: nil)))
      durationChanged(reported)
      logBuffer(item, reason: .ready)
      applyPendingSeek()
      playIfReady()
      publishNowPlaying(isPlaying: state == .playing)
    case .failed:
      let itemError =
        item.error.map(PlaybackDiagnostics.NormalizedError.init)
        ?? Self.normalizedLastErrorLogEntry(of: item)
      let detail = itemError.map(Self.describe) ?? "no error"
      logger.error("Item failed: \(detail, privacy: .public)")
      record(.item(.init(phase: .failed, error: itemError)))
      capturePosition()
      itemNeedsReload = true
      timelineSample = nil
      player?.pause()
      state = .failed("This audio would not play.")
      publishNowPlaying(isPlaying: false)
    case .unknown:
      break
    @unknown default:
      break
    }
  }

  /// The item's own length when it has a usable one, else the service's. A change of more than a
  /// second is logged, because a mismatch is the sign of a stream whose timing is estimated.
  private func durationChanged(_ reported: Double) {
    let next = reported.isFinite && reported > 0 ? reported : serviceDuration
    guard next != duration else { return }
    if let next, let duration, abs(next - duration) > 1 {
      logger.notice(
        "Length changed from \(clock(duration), privacy: .public) to \(clock(next), privacy: .public)"
      )
    }
    duration = next
    publishNowPlaying(isPlaying: state == .playing)
  }

  /// Where a saved position starts: from the beginning when it is at or within a few seconds of
  /// the end, because a Set resumed there would finish before a sound was heard.
  static func startPosition(_ requested: TimeInterval, duration: TimeInterval?) -> TimeInterval {
    let start = requested.isFinite ? max(requested, 0) : 0
    guard let duration, duration.isFinite, duration > 0, start >= duration - 5 else { return start }
    return 0
  }

  /// Where a resumed Set starts. A position past the end of the audio would leave the item
  /// finished the moment it began, so the seek is bounded by the length the item reports.
  private func applyPendingSeek() {
    guard let pendingSeek else { return }
    self.pendingSeek = nil
    guard player != nil else { return }
    let bounded = boundedPosition(pendingSeek)
    logger.debug("Applying held seek to \(clock(bounded), privacy: .public)")
    move(to: bounded)
    elapsed = bounded
  }

  private func boundedPosition(_ seconds: TimeInterval) -> TimeInterval {
    let position = seconds.isFinite ? max(seconds, 0) : 0
    guard let duration, duration.isFinite, duration > 0 else { return position }
    return min(position, duration)
  }

  /// Seeks exactly. The default tolerance lets the player land seconds early on a compressed
  /// stream, so a tapped track started inside the one before it, the bar did not show the
  /// position asked for, and Next track found the same track again.
  private func move(to seconds: TimeInterval) {
    guard let player else { return }
    timelineSample = nil
    isSeeking = true
    latestSeek += 1
    let seekNumber = latestSeek
    let generation = playbackGeneration
    let requestedAt = ProcessInfo.processInfo.systemUptime
    logger.debug(
      "Seek requested generation=\(generation, privacy: .public) seek=\(seekNumber, privacy: .public) target=\(seconds, privacy: .public)"
    )
    player.seek(
      to: CMTime(seconds: seconds, preferredTimescale: 600),
      toleranceBefore: .zero,
      toleranceAfter: .zero
    ) { [weak self] finished in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, self.latestSeek == seekNumber,
          let player = self.player
        else { return }
        self.isSeeking = false
        self.timelineSample = nil
        let landed = player.currentTime().seconds
        let outcome = finished ? "landed at" : "stopped at"
        logger.debug(
          "Seek to \(clock(seconds), privacy: .public) \(outcome, privacy: .public) \(clock(landed), privacy: .public)"
        )
        let delay = ProcessInfo.processInfo.systemUptime - requestedAt
        logger.debug(
          "Seek completed generation=\(generation, privacy: .public) seek=\(seekNumber, privacy: .public) finished=\(finished, privacy: .public) target=\(seconds, privacy: .public) actual=\(landed, privacy: .public) duration=\(delay, privacy: .public)"
        )
        self.record(
          .seekResult(
            .init(
              seekID: seekNumber, target: .init(seconds), actual: .init(landed),
              finished: finished, duration: .init(delay))))
        if finished, landed.isFinite {
          self.elapsed = landed
          self.playIfReady()
        } else {
          self.pendingSeek = seconds
          self.state = .failed("The audio could not move to that position.")
          player.pause()
        }
        self.publishNowPlaying(isPlaying: self.state == .playing)
      }
    }
  }

  /// The end of the audio, which is the one way a Listen finishes. Registered per play, because
  /// the notification names the item that ended.
  private func observeCompletion(of item: AVPlayerItem, generation: Int) {
    observers.append(
      NotificationCenter.default.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        // Registered on the main queue, so this block is already on the main actor.
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation, !self.completionReported,
            let finished = self.currentSetId
          else { return }
          logger.info(
            "Item ended generation=\(generation, privacy: .public) actual=\(self.player?.currentTime().seconds ?? 0, privacy: .public) duration=\(self.duration ?? 0, privacy: .public)"
          )
          // Ogg duration can be estimated from bytes; the service measured the retained file.
          if let duration = [self.duration, self.serviceDuration].compactMap({ $0 }).min(),
            let actual = self.player?.currentTime().seconds,
            actual.isFinite, actual < duration - 2
          {
            self.record(
              .ended(
                .init(actual: .init(actual), expected: .init(duration), premature: true)))
            logger.notice(
              "Premature item end generation=\(generation, privacy: .public) actual=\(actual, privacy: .public) duration=\(duration, privacy: .public)"
            )
            if self.wantsSound { self.state = .loading }
            self.publishNowPlaying(isPlaying: false)
            return
          }
          self.record(
            .ended(
              .init(
                actual: .init(self.player?.currentTime().seconds),
                expected: .init(self.duration ?? self.serviceDuration), premature: false)))
          self.completionReported = true
          self.onFinished?(finished)
        }
      }
    )
  }

  /// A stream that breaks after it started playing never fails the item's status, so without this
  /// the screen would wait on a spinner for good. The player's own stall notice is logged too:
  /// it says the network fell behind, which reads the same as a stuck load from outside.
  private func observeFailures(of item: AVPlayerItem, generation: Int) {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: AVPlayerItem.failedToPlayToEndTimeNotification,
        object: item,
        queue: .main
      ) { [weak self] notification in
        let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
        let normalized = error.map(PlaybackDiagnostics.NormalizedError.init)
        let detail = normalized.map(Self.describe) ?? "no error"
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation else { return }
          logger.error(
            "Playback broke at \(clock(self.elapsed), privacy: .public): \(detail, privacy: .public)"
          )
          self.record(.item(.init(phase: .failed, error: normalized)))
          self.capturePosition()
          self.itemNeedsReload = true
          self.timelineSample = nil
          self.player?.pause()
          self.state = .failed("The audio stopped loading.")
          self.publishNowPlaying(isPlaying: false)
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: AVPlayerItem.playbackStalledNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation else { return }
          self.timelineSample = nil
          self.record(.stalled)
          logger.notice("Playback stalled at \(clock(self.elapsed), privacy: .public)")
          if let item = self.player?.currentItem { self.logBuffer(item, reason: .stalled) }
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: AVPlayerItem.newErrorLogEntryNotification,
        object: item,
        queue: .main
      ) { [weak self] notification in
        let entry = (notification.object as? AVPlayerItem).flatMap(Self.normalizedLastErrorLogEntry)
        logger.notice("Stream error\(entry.map { "; " + Self.describe($0) } ?? "", privacy: .public)")
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation, let entry else { return }
          self.record(.error(entry))
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: AVPlayerItem.timeJumpedNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation else { return }
          let seek = self.isSeeking ? String(self.latestSeek) : "none"
          let actual = self.player?.currentTime().seconds ?? .nan
          logger.debug(
            "Time jumped generation=\(generation, privacy: .public) seek=\(seek, privacy: .public) actual=\(actual, privacy: .public)"
          )
          self.record(
            .timeJumped(
              .init(actual: .init(actual), seekID: self.isSeeking ? self.latestSeek : nil)))
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: AVPlayerItem.newAccessLogEntryNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation,
            let item = self.player?.currentItem
          else { return }
          self.logAccess(item)
        }
      }
    )
  }

  private func capturePosition() {
    if let settledPosition { elapsed = settledPosition }
  }

  private func recordPeriodicSnapshotIfNeeded() {
    let uptime = ProcessInfo.processInfo.systemUptime
    guard uptime - lastDiagnosticSample >= 5 else { return }
    lastDiagnosticSample = uptime
    record(.sample)
  }

  private func sampleTimeline() {
    guard state == .playing, sessionReady, !isSeeking, pendingSeek == nil,
      let player, player.timeControlStatus == .playing, player.rate > 0
    else {
      timelineSample = nil
      return
    }
    let actual = player.currentTime().seconds
    guard actual.isFinite else { return }
    let uptime = ProcessInfo.processInfo.systemUptime
    let sample = TimelineSample(mediaTime: actual, uptime: uptime, rate: player.rate)
    defer { timelineSample = sample }
    if let previous = timelineSample {
      let wallDelta = uptime - previous.uptime
      let mediaDelta = actual - previous.mediaTime
      let gap = mediaDelta - wallDelta * Double(previous.rate)
      if abs(gap) > 0.75 {
        logger.notice(
          "Timeline discontinuity generation=\(self.playbackGeneration, privacy: .public) actual=\(actual, privacy: .public) mediaDelta=\(mediaDelta, privacy: .public) wallDelta=\(wallDelta, privacy: .public) rate=\(previous.rate, privacy: .public) gap=\(gap, privacy: .public)"
        )
        record(
          .discontinuity(
            .init(
              mediaDelta: .init(mediaDelta), wallDelta: .init(wallDelta),
              rate: .init(Double(previous.rate)), gap: .init(gap))))
      }
    }
    if uptime - lastTimelineLog >= 5 {
      lastTimelineLog = uptime
      logger.debug(
        "Timeline sample generation=\(self.playbackGeneration, privacy: .public) actual=\(actual, privacy: .public) uptime=\(uptime, privacy: .public) rate=\(player.rate, privacy: .public)"
      )
    }
  }

  private func logBuffer(_ item: AVPlayerItem, reason: PlaybackDiagnostics.BufferEvent.Reason) {
    let label =
      switch reason {
      case .ready: "ready"
      case .stalled: "stall"
      case .waiting: "wait"
      }
    let ranges = item.loadedTimeRanges.prefix(8).map { value in
      let range = value.timeRangeValue
      return "\(clock(range.start.seconds))+\(clock(range.duration.seconds))"
    }.joined(separator: ",")
    logger.debug(
      "Buffer generation=\(self.playbackGeneration, privacy: .public) reason=\(label, privacy: .public) empty=\(item.isPlaybackBufferEmpty, privacy: .public) full=\(item.isPlaybackBufferFull, privacy: .public) likely=\(item.isPlaybackLikelyToKeepUp, privacy: .public) rangeCount=\(item.loadedTimeRanges.count, privacy: .public) ranges=\(ranges, privacy: .public)"
    )
    record(.buffer(.init(reason: reason)))
  }

  private func logAccess(_ item: AVPlayerItem) {
    guard let entry = item.accessLog()?.events.last else { return }
    logger.debug(
      "Access generation=\(self.playbackGeneration, privacy: .public) bytes=\(entry.numberOfBytesTransferred, privacy: .public) transferDuration=\(entry.transferDuration, privacy: .public) observedBitrate=\(entry.observedBitrate, privacy: .public) indicatedBitrate=\(entry.indicatedBitrate, privacy: .public) stalls=\(entry.numberOfStalls, privacy: .public) downloadedDuration=\(entry.segmentsDownloadedDuration, privacy: .public)"
    )
    record(.access(.init(metrics: diagnosticAccessMetrics(entry))))
  }

  /// Why the player is waiting, when it is. The reason tells a slow network from a player that
  /// was never asked to play.
  private func logWaiting(_ player: AVPlayer) {
    switch player.timeControlStatus {
    case .waitingToPlayAtSpecifiedRate:
      let reason = player.reasonForWaitingToPlay?.rawValue ?? "no reason"
      logger.debug(
        "Waiting at \(clock(self.elapsed), privacy: .public): \(reason, privacy: .public)")
      timelineSample = nil
      record(.waiting(.init(reason: diagnosticWaitingReason(player.reasonForWaitingToPlay))))
      if let item = player.currentItem { logBuffer(item, reason: .waiting) }
    case .playing:
      logger.debug("Playing at \(clock(self.elapsed), privacy: .public)")
    case .paused:
      logger.debug("Player paused at \(clock(self.elapsed), privacy: .public)")
    @unknown default:
      break
    }
  }

  nonisolated static func describe(_ error: any Error) -> String {
    describe(PlaybackDiagnostics.NormalizedError(error))
  }

  nonisolated static func describe(_ error: PlaybackDiagnostics.NormalizedError) -> String {
    "domain=\(error.domain.rawValue) code=\(error.code)"
  }

  nonisolated static func normalizedLastErrorLogEntry(of item: AVPlayerItem)
    -> PlaybackDiagnostics.NormalizedError?
  {
    guard let entry = item.errorLog()?.events.last else { return nil }
    return .init(domain: entry.errorDomain, code: entry.errorStatusCode)
  }

  /// A rate drop can be buffering. Only an audio-session notification marks an interruption.
  ///
  /// Internal rather than private so a test can apply a change the system made, which it cannot
  /// make an unloaded player report.
  func rateChanged(rate: Float) {
    if rate == 0 { timelineSample = nil }
    switch state {
    case .playing where rate == 0:
      state = .loading
      publishNowPlaying(isPlaying: false)
    case .paused where rate > 0, .interrupted where rate > 0:
      state = .playing
      publishNowPlaying(isPlaying: true)
    default:
      break
    }
  }

  func stallChanged(status: AVPlayer.TimeControlStatus) {
    switch status {
    case .playing:
      if state == .loading, sessionReady, pendingSeek == nil, !isSeeking, !itemNeedsReload {
        state = .playing
        if !hasStartedSound {
          hasStartedSound = true
          let delay = soundRequestedAt.map { ProcessInfo.processInfo.systemUptime - $0 } ?? 0
          logger.info(
            "First playing generation=\(self.playbackGeneration, privacy: .public) actual=\(self.player?.currentTime().seconds ?? 0, privacy: .public) delay=\(delay, privacy: .public)"
          )
        }
      }
    case .paused:
      // As with the rate: the person's own pause is already `.paused` by the time this lands.
      if state == .playing {
        state = .loading
      }
    case .waitingToPlayAtSpecifiedRate:
      if state == .playing || state == .loading {
        state = .loading
      }
    @unknown default:
      break
    }
    publishNowPlaying(isPlaying: state == .playing)
  }

  private func publishNowPlaying(isPlaying: Bool) {
    guard !currentTitle.isEmpty else { return }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = Self.nowPlayingInfo(
      title: currentTitle,
      artist: currentArtist,
      cue: currentCue,
      artwork: currentArtwork,
      duration: duration,
      elapsed: elapsed,
      isPlaying: isPlaying
    )
  }

  private func dropPlayerObservers() {
    if let timeObserver {
      player?.removeTimeObserver(timeObserver)
      self.timeObserver = nil
    }
    statusObservation?.invalidate()
    durationObservation?.invalidate()
    loadedRangesObservation?.invalidate()
    rateObservation?.invalidate()
    stallObservation?.invalidate()
    statusObservation = nil
    durationObservation = nil
    loadedRangesObservation = nil
    rateObservation = nil
    stallObservation = nil
  }

  private func setupCommands() {
    let center = MPRemoteCommandCenter.shared()
    let play = center.playCommand.addTarget { [weak self] _ in
      self?.resume(origin: .systemRemote)
      return .success
    }
    center.playCommand.isEnabled = true
    let pause = center.pauseCommand.addTarget { [weak self] _ in
      self?.pause(origin: .systemRemote)
      return .success
    }
    center.pauseCommand.isEnabled = true
    let toggle = center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .noSuchContent }
      self.togglePlayPause(origin: .systemRemote)
      return .success
    }
    center.togglePlayPauseCommand.isEnabled = true
    // The same skips as the transport beside Play, so the Lock Screen and the car offer them too.
    // The interval is set before the target, because the system reads it when the target arrives.
    center.skipBackwardCommand.preferredIntervals = [Self.skipBack as NSNumber]
    let back = center.skipBackwardCommand.addTarget { [weak self] event in
      self?.skip(
        by: -Self.interval(of: event, default: Self.skipBack), origin: .systemRemote)
      return .success
    }
    center.skipBackwardCommand.isEnabled = true
    center.skipForwardCommand.preferredIntervals = [Self.skipAhead as NSNumber]
    let ahead = center.skipForwardCommand.addTarget { [weak self] event in
      self?.skip(
        by: Self.interval(of: event, default: Self.skipAhead), origin: .systemRemote)
      return .success
    }
    center.skipForwardCommand.isEnabled = true
    // Dragging the scrubber on the Lock Screen, in Control Center, or in the Dynamic Island.
    let scrub = center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      self.seek(to: event.positionTime, origin: .systemRemote)
      return .success
    }
    center.changePlaybackPositionCommand.isEnabled = true
    // Next and previous, from AirPods, headphones, and the car, step through the Cues. A Set
    // without a timed Tracklist has nothing to step between, so they skip like the buttons do.
    let next = center.nextTrackCommand.addTarget { [weak self] _ in
      guard let self else { return .noSuchContent }
      if self.canSkipCues {
        self.skipToNextCue(origin: .systemRemote)
      } else {
        self.record(.command(.init(kind: .nextCue, origin: .systemRemote)))
        self.skip(by: Self.skipAhead, origin: .internalOperation)
      }
      return .success
    }
    center.nextTrackCommand.isEnabled = true
    let previous = center.previousTrackCommand.addTarget { [weak self] _ in
      guard let self else { return .noSuchContent }
      if self.canSkipCues {
        self.skipToPreviousCue(origin: .systemRemote)
      } else {
        self.record(.command(.init(kind: .previousCue, origin: .systemRemote)))
        self.skip(by: -Self.skipBack, origin: .internalOperation)
      }
      return .success
    }
    center.previousTrackCommand.isEnabled = true
    commandTargets = [play, pause, toggle, back, ahead, scrub, next, previous]
  }

  static let skipBack: TimeInterval = 15
  static let skipAhead: TimeInterval = 30

  /// Moves the playhead by a number of seconds, back when negative.
  func skip(
    by seconds: TimeInterval, origin: PlaybackDiagnostics.Origin = .app
  ) {
    let kind: PlaybackDiagnostics.CommandKind = seconds < 0 ? .skipBackward : .skipForward
    record(.command(.init(kind: kind, origin: origin, target: .init(seconds))))
    seek(to: elapsed + seconds, origin: .internalOperation)
  }

  /// Siri can ask for a skip of its own length, so the event's interval wins over the button's.
  private static func interval(of event: MPRemoteCommandEvent, default fallback: TimeInterval)
    -> TimeInterval
  {
    (event as? MPSkipIntervalCommandEvent)?.interval ?? fallback
  }

  private func observeInterruptions() {
    guard !isObservingInterruptions else { return }
    isObservingInterruptions = true
    #if !os(macOS)
      let center = NotificationCenter.default
      // Registered on the main queue, so each block already runs on the main actor and
      // assumes it, like the completion observer, rather than queueing a task that could land
      // after a later press. Notification is not Sendable, so plain values are read first.
      observers.append(
        center.addObserver(
          forName: AVAudioSession.interruptionNotification,
          object: nil,
          queue: .main
        ) { [weak self] notification in
          guard let info = notification.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
          else { return }
          let shouldResume: Bool = {
            guard type == .ended,
              let rawOptions = info[AVAudioSessionInterruptionOptionKey] as? UInt
            else { return false }
            return AVAudioSession.InterruptionOptions(rawValue: rawOptions)
              .contains(.shouldResume)
          }()
          MainActor.assumeIsolated {
            self?.applyInterruption(type: type, shouldResume: shouldResume)
          }
        }
      )
      observers.append(
        center.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] notification in
          guard let info = notification.userInfo,
            let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
          else { return }
          MainActor.assumeIsolated {
            guard let self else { return }
            self.record(
              .route(
                .init(
                  reason: reason == .oldDeviceUnavailable ? .oldDeviceUnavailable : .other)))
            guard reason == .oldDeviceUnavailable else { return }
            logger.info("Audio route lost its output; pausing")
            self.pause(origin: .internalOperation)
          }
        }
      )
      observers.append(
        center.addObserver(
          forName: AVAudioSession.mediaServicesWereResetNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          MainActor.assumeIsolated {
            guard let self else { return }
            self.record(.reset)
            self.capturePosition()
            self.pause(origin: .internalOperation)
            self.playbackGeneration += 1
            self.sessionReady = false
            self.itemNeedsReload = true
            self.pendingSeek = nil
            self.isSeeking = false
            self.dropPlayerObservers()
            self.player = nil
            self.artworkFetch?.cancel()
            self.state = .failed("Audio was reset on this device. Press Play to resume.")
            self.publishNowPlaying(isPlaying: false)
            logger.notice("Media services reset; waiting for Play to reload the audio")
          }
        }
      )
    #endif
  }

  #if !os(macOS)
    private func applyInterruption(
      type: AVAudioSession.InterruptionType, shouldResume: Bool
    ) {
      let phase = type == .began ? "began" : "ended"
      logger.info(
        "Interruption \(phase, privacy: .public), resume allowed: \(shouldResume, privacy: .public)"
      )
      record(
        .interruption(
          .init(
            phase: type == .began ? .began : .ended, shouldResume: shouldResume)))
      switch type {
      case .began:
        // Only a Set the person wanted is marked interrupted; a paused one stays paused.
        guard wantsSound else { return }
        sessionReady = false
        timelineSample = nil
        player?.pause()
        state = .interrupted
        publishNowPlaying(isPlaying: false)
      case .ended:
        guard state == .interrupted else { return }
        // The interruption took the session down; `resume()` brings it back before playing.
        // Without the system's leave to resume, the Set waits for the person's Play.
        if shouldResume {
          resumePlayback()
        } else {
          state = .paused
        }
      @unknown default:
        break
      }
    }
  #endif
}
