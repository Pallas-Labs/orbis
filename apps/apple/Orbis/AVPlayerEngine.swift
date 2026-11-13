import AVFoundation
import OrbisKit

/// Plays a Set's retained audio with AVPlayer, streamed from the service with the device token.
///
/// AVPlayer does its own threading. KVO can call back on any thread, so each KVO handler only hops
/// to the main actor and reports what changed; the hops are separate tasks and can land in either
/// order, which is why the events carry no values. The tick, the seek completion, and the item
/// notifications are registered on the main queue and report without a hop.
@MainActor
final class AVPlayerEngine: PlaybackEngine {
  /// The player, for tests that read AVPlayer's own clock and silence it.
  private(set) var player: AVPlayer?
  private var onEvent: (@MainActor (PlaybackEngineEvent) -> Void)?
  private var timeObserver: Any?
  private var observations: [NSKeyValueObservation] = []

  /// The item notifications this engine registered, held nonisolated so `deinit`, which cannot
  /// hop actors, takes them back.
  ///
  /// `nonisolated(unsafe)` is sound only while this holds: every read and write outside `deinit`
  /// happens on the main actor (in `load` and `invalidate`), and `deinit` runs when no other
  /// reference is left, so it has the array to itself.
  nonisolated(unsafe) private var observers: [NSObjectProtocol] = []

  var isSystemMusicPlayer: Bool { false }

  deinit {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  func load(
    _ set: SavedSet, baseURL: URL, token: String,
    onEvent: @escaping @MainActor (PlaybackEngineEvent) -> Void
  ) {
    self.onEvent = onEvent
    // The asset is the Set's own audio file, not the service root: loading the
    // root answers 404 and the player fails without ever asking for audio.
    let item = AVPlayerItem(
      asset: AudioPlayer.asset(
        url: AudioPlayer.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    observations = [
      item.observe(\.status, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.report(.statusChanged) }
      },
      // The item can learn its length after it is ready, or revise it once more of a stream has
      // arrived.
      item.observe(\.duration, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.report(.durationChanged) }
      },
      item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.report(.bufferChanged) }
      },
      player.observe(\.rate, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.report(.rateChanged) }
      },
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.report(.timeControlChanged) }
      },
    ]
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] _ in
      // Registered on the main queue, so this closure is already on the main actor; assuming it
      // avoids a task on every tick.
      MainActor.assumeIsolated { self?.report(.tick) }
    }
    observe(item)
  }

  private func report(_ event: PlaybackEngineEvent) {
    onEvent?(event)
  }

  /// The item's notifications, registered per item because each names the item it is about. A
  /// stream that breaks after it started playing never fails the item's status, so the failure
  /// notice is the only word of it.
  private func observe(_ item: AVPlayerItem) {
    let center = NotificationCenter.default
    // Registered on the main queue, so each block is already on the main actor. Notification is
    // not Sendable, so plain values are read first.
    observers = [
      center.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.report(.ended) }
      },
      center.addObserver(
        forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main
      ) { [weak self] notification in
        let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
        let normalized = error.map(PlaybackDiagnostics.NormalizedError.init)
        MainActor.assumeIsolated { self?.report(.failed(normalized)) }
      },
      center.addObserver(
        forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.report(.stalled) }
      },
      center.addObserver(
        forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main
      ) { [weak self] notification in
        let entry = (notification.object as? AVPlayerItem).flatMap(Self.lastErrorLogEntry)
        MainActor.assumeIsolated { self?.report(.streamError(entry)) }
      },
      center.addObserver(
        forName: AVPlayerItem.timeJumpedNotification, object: item, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.report(.timeJumped) }
      },
      center.addObserver(
        forName: AVPlayerItem.newAccessLogEntryNotification, object: item, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.report(.accessLogged) }
      },
    ]
  }

  func play() {
    player?.play()
  }

  func pause() {
    player?.pause()
  }

  /// Seeks exactly. The default tolerance lets the player land seconds early on a compressed
  /// stream, so a tapped track started inside the one before it, the bar did not show the
  /// position asked for, and Next track found the same track again.
  func seek(to seconds: TimeInterval, completion: @escaping @MainActor (Bool) -> Void) {
    player?.seek(
      to: CMTime(seconds: seconds, preferredTimescale: 600),
      toleranceBefore: .zero,
      toleranceAfter: .zero
    ) { finished in
      Task { @MainActor in completion(finished) }
    }
  }

  func invalidate() {
    onEvent = nil
    if let timeObserver {
      player?.removeTimeObserver(timeObserver)
      self.timeObserver = nil
    }
    for observation in observations { observation.invalidate() }
    observations = []
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
  }

  var currentTime: TimeInterval { player?.currentTime().seconds ?? .nan }

  var duration: TimeInterval { player?.currentItem?.duration.seconds ?? .nan }

  var rate: Float { player?.rate ?? 0 }

  var status: PlaybackEngineStatus {
    switch player?.currentItem?.status {
    case .some(.readyToPlay): .ready
    case .some(.failed): .failed
    default: .unknown
    }
  }

  var timeControl: PlaybackEngineTimeControl {
    switch player?.timeControlStatus {
    case .some(.playing): .playing
    case .some(.waitingToPlayAtSpecifiedRate): .waiting
    default: .paused
    }
  }

  var waitingReason: PlaybackDiagnostics.WaitingReason {
    switch player?.reasonForWaitingToPlay?.rawValue {
    case nil: .none
    case "AVPlayerWaitingToMinimizeStallsReason": .minimizingStalls
    case "AVPlayerWaitingWhileEvaluatingBufferingRateReason": .evaluatingBufferingRate
    case "AVPlayerWaitingWithNoItemToPlayReason": .noItem
    case "AVPlayerWaitingDuringInterstitialEventReason": .interstitial
    default: .other
    }
  }

  var waitingReasonName: String? { player?.reasonForWaitingToPlay?.rawValue }

  var failure: PlaybackDiagnostics.NormalizedError? {
    guard let item = player?.currentItem else { return nil }
    return item.error.map(PlaybackDiagnostics.NormalizedError.init)
      ?? Self.lastErrorLogEntry(of: item)
  }

  var buffer: PlaybackEngineBuffer {
    guard let item = player?.currentItem else { return PlaybackEngineBuffer() }
    let ranges = item.loadedTimeRanges
    return PlaybackEngineBuffer(
      isEmpty: item.isPlaybackBufferEmpty, isFull: item.isPlaybackBufferFull,
      isLikelyToKeepUp: item.isPlaybackLikelyToKeepUp,
      ranges: ranges.prefix(8).map { value in
        let range = value.timeRangeValue
        return (start: range.start.seconds, duration: range.duration.seconds)
      },
      rangeCount: ranges.count)
  }

  var access: PlaybackEngineAccess? {
    guard let entry = player?.currentItem?.accessLog()?.events.last else { return nil }
    return PlaybackEngineAccess(
      bytesTransferred: entry.numberOfBytesTransferred, transferDuration: entry.transferDuration,
      observedBitrate: entry.observedBitrate, indicatedBitrate: entry.indicatedBitrate,
      stalls: entry.numberOfStalls, downloadedDuration: entry.segmentsDownloadedDuration)
  }

  private nonisolated static func lastErrorLogEntry(of item: AVPlayerItem)
    -> PlaybackDiagnostics.NormalizedError?
  {
    guard let entry = item.errorLog()?.events.last else { return nil }
    return .init(domain: entry.errorDomain, code: entry.errorStatusCode)
  }
}
