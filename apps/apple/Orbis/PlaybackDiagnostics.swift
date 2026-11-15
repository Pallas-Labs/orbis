import Foundation

final class PlaybackDiagnostics {
  static let retainedEntryLimit = 256
  static let reportByteLimit = 256 * 1_024
  /// The most entries kept for delivery before the oldest unsent one is evicted and declared
  /// lost. Separate from the report's ring, which may evict a sample the moment it arrives.
  static let unsentEntryLimit = 1_024

  struct Finite: Codable, Equatable, Sendable {
    let value: Double?

    init(_ value: Double?) {
      self.value = value.flatMap { $0.isFinite ? $0 : nil }
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.singleValueContainer()
      if container.decodeNil() {
        self.init(nil)
      } else {
        self.init(try container.decode(Double.self))
      }
    }

    func encode(to encoder: any Encoder) throws {
      var container = encoder.singleValueContainer()
      if let value {
        try container.encode(value)
      } else {
        try container.encodeNil()
      }
    }
  }

  enum PlaybackState: String, Codable, Sendable {
    case idle, loading, playing, paused, interrupted, failed
  }

  enum ItemState: String, Codable, Sendable {
    case none, unknown, ready, failed
  }

  enum WaitingReason: String, Codable, Sendable {
    case none, minimizingStalls, evaluatingBufferingRate, noItem, interstitial, other
  }

  enum Origin: String, Codable, Sendable {
    /// `automatic` is the player acting on its own after a failure or a stall, not a person.
    case app, systemRemote, internalOperation, automatic, unknown
  }

  enum CommandKind: String, Codable, Sendable {
    case play, pause, toggle, seek, nextCue, previousCue, skipForward, skipBackward, stop, reload
  }

  enum ErrorDomain: String, Codable, Sendable {
    case url, avFoundation, coreMedia, osStatus, other
  }

  struct NormalizedError: Codable, Equatable, Sendable {
    let domain: ErrorDomain
    let code: Int

    nonisolated init(_ error: any Error) {
      self.init(domain: Self.domain(for: (error as NSError).domain), code: (error as NSError).code)
    }

    nonisolated init(domain: String, code: Int) {
      self.init(domain: Self.domain(for: domain), code: code)
    }

    private nonisolated init(domain: ErrorDomain, code: Int) {
      self.domain = domain
      self.code = code
    }

    private nonisolated static func domain(for value: String) -> ErrorDomain {
      switch value {
      case NSURLErrorDomain: .url
      case "AVFoundationErrorDomain": .avFoundation
      case "CoreMediaErrorDomain": .coreMedia
      case NSOSStatusErrorDomain: .osStatus
      default: .other
      }
    }
  }

  struct BufferRange: Codable, Equatable, Sendable {
    let start: Finite
    let duration: Finite
  }

  struct AccessMetrics: Codable, Equatable, Sendable {
    let bytesTransferred: Int64
    let transferDuration: Finite
    let observedBitrate: Finite
    let indicatedBitrate: Finite
    let stalls: Int
    let downloadedDuration: Finite
  }

  struct Snapshot: Codable, Equatable, Sendable {
    var state: PlaybackState = .idle
    var itemState: ItemState = .none
    var waitingReason: WaitingReason = .none
    var actualTime = Finite(nil)
    var displayedTime = Finite(nil)
    var duration = Finite(nil)
    var rate = Finite(nil)
    var sessionReady = false
    var pendingSeek = Finite(nil)
    var seekInFlight = false
    var playbackGeneration = 0
    var seekID = 0
    var bufferEmpty = false
    var bufferFull = false
    var likelyToKeepUp = false
    var bufferRanges: [BufferRange] = []
    var access: AccessMetrics?
    var setId: String?
  }

  struct CommandEvent: Codable, Equatable, Sendable {
    let kind: CommandKind
    let origin: Origin
    let target: Finite

    init(kind: CommandKind, origin: Origin, target: Finite = .init(nil)) {
      self.kind = kind
      self.origin = origin
      self.target = target
    }
  }

  struct StateEvent: Codable, Equatable, Sendable {
    let from: PlaybackState
    let to: PlaybackState
  }

  struct SeekEvent: Codable, Equatable, Sendable {
    let seekID: Int
    let target: Finite
    let actual: Finite
    let finished: Bool
    let duration: Finite
  }

  struct TimelineEvent: Codable, Equatable, Sendable {
    let mediaDelta: Finite
    let wallDelta: Finite
    let rate: Finite
    let gap: Finite
  }

  struct TimeJumpEvent: Codable, Equatable, Sendable {
    let actual: Finite
    let seekID: Int?
  }

  struct BufferEvent: Codable, Equatable, Sendable {
    enum Reason: String, Codable, Sendable { case ready, waiting, stalled }
    let reason: Reason
  }

  struct AccessEvent: Codable, Equatable, Sendable {
    let metrics: AccessMetrics
  }

  struct WaitingEvent: Codable, Equatable, Sendable {
    let reason: WaitingReason
  }

  struct SessionEvent: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable { case startRequested, ready, failed, endRequested, ended }
    let phase: Phase
    let requestID: Int
    let playbackGeneration: Int
  }

  struct ItemEvent: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable { case installed, ready, failed }
    let phase: Phase
    let error: NormalizedError?
  }

  struct InterruptionEvent: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable { case began, ended }
    let phase: Phase
    let shouldResume: Bool
  }

  struct RouteEvent: Codable, Equatable, Sendable {
    enum Reason: String, Codable, Sendable { case oldDeviceUnavailable, other }
    let reason: Reason
  }

  struct EndEvent: Codable, Equatable, Sendable {
    /// Why a premature end still finished the Set.
    enum Reason: String, Codable, Sendable { case repeated }
    let actual: Finite
    let expected: Finite
    let premature: Bool
    var reason: Reason?
  }

  struct ActivationEvent: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable { case began, intentChanged, accepted, superseded, failed, cancelled }
    let phase: Phase
    let generation: Int
    let wantsSound: Bool
    let target: Finite
    let requestDuration: Finite
  }

  enum Event: Codable, Equatable, Sendable {
    case command(CommandEvent)
    case state(StateEvent)
    case seekResult(SeekEvent)
    case sample
    case waiting(WaitingEvent)
    case stalled
    /// A stall that had not recovered when the stall window ran out.
    case stallUnrecovered
    case discontinuity(TimelineEvent)
    case timeJumped(TimeJumpEvent)
    case buffer(BufferEvent)
    case access(AccessEvent)
    case session(SessionEvent)
    case item(ItemEvent)
    case ended(EndEvent)
    case interruption(InterruptionEvent)
    case route(RouteEvent)
    case reset
    case activation(ActivationEvent)
    case error(NormalizedError)
  }

  struct Entry: Codable, Equatable, Sendable {
    let sequence: Int
    let wallTime: Date
    let uptime: Finite
    let event: Event
    let snapshot: Snapshot
  }

  struct Metadata: Codable, Equatable, Sendable {
    let appVersion: String
    let appBuild: String
    let osName: String
    let osVersion: String

    static var current: Metadata {
      let info = Bundle.main.infoDictionary
      #if os(iOS)
        let osName = "iOS"
      #elseif os(macOS)
        let osName = "macOS"
      #elseif os(tvOS)
        let osName = "tvOS"
      #else
        let osName = "Apple OS"
      #endif
      return Metadata(
        appVersion: info?["CFBundleShortVersionString"] as? String ?? "unknown",
        appBuild: info?["CFBundleVersion"] as? String ?? "unknown",
        osName: osName,
        osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
    }
  }

  struct Report: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let metadata: Metadata
    let generatedAt: Date
    let generatedUptime: Finite
    let evictedCount: Int
    let current: Snapshot
    let entries: [Entry]
  }

  /// The sequences `(afterSequence, throughSequence]`, which delivery will never send.
  struct LostRange: Codable, Equatable, Sendable {
    let afterSequence: Int
    let throughSequence: Int
  }

  /// The oldest history that delivery has yet to send, in sequence order.
  struct Pending: Sendable {
    let entries: [Entry]
    let lost: [LostRange]
  }

  enum Settlement {
    /// The Group acknowledged the batch.
    case delivered
    /// The Group refused the batch for good, so its entries are lost.
    case refused
    /// The batch may not have arrived, so it is sent again.
    case unsent
  }

  private let maxEntries: Int
  private let maxReportBytes: Int
  private let metadata: Metadata
  private var entries: [Entry] = []
  private var nextSequence = 1
  private var evictedCount = 0
  private var delivery: Int?
  private var deliveries = 0
  private var unsent: [Entry] = []
  private var lost: [LostRange] = []
  /// The last entry and the number of loss ranges that `pending` handed out and that are not
  /// yet settled. Eviction and merging leave them alone.
  private var inFlight: (through: Int, lost: Int)?

  init(
    maxEntries: Int = retainedEntryLimit,
    maxReportBytes: Int = reportByteLimit,
    metadata: Metadata = .current
  ) {
    self.maxEntries = max(1, min(maxEntries, Self.retainedEntryLimit))
    self.maxReportBytes = max(1_024, min(maxReportBytes, Self.reportByteLimit))
    self.metadata = metadata
  }

  func record(
    _ event: Event, snapshot: Snapshot, wallTime: Date = Date(),
    uptime: Double = ProcessInfo.processInfo.systemUptime
  ) {
    let entry = Entry(
      sequence: nextSequence, wallTime: wallTime, uptime: Finite(uptime), event: event,
      snapshot: snapshot)
    entries.append(entry)
    nextSequence += 1
    if entries.count > maxEntries {
      let index = entries.firstIndex { $0.event == .sample } ?? entries.startIndex
      entries.remove(at: index)
      evictedCount += 1
    }
    guard delivery != nil else { return }
    unsent.append(entry)
    if unsent.count > Self.unsentEntryLimit {
      let index = unsent.firstIndex { $0.sequence > inFlight?.through ?? 0 } ?? unsent.startIndex
      declareLost(unsent.remove(at: index).sequence)
    }
  }

  var tail: Int { nextSequence - 1 }

  /// Starts delivering what is recorded from now on, and forgets what an earlier delivery left
  /// unsent. Returns the delivery's generation, which `pending` and `settle` check.
  func startDelivery() -> Int {
    deliveries += 1
    delivery = deliveries
    unsent.removeAll()
    lost.removeAll()
    inFlight = nil
    return deliveries
  }

  /// The oldest unsent entries and loss ranges, at most `limit` of each. They stay unsent, and
  /// are not evicted, until `settle`. Nil once `generation` is no longer delivering.
  func pending(for generation: Int, limit: Int) -> Pending? {
    guard generation == delivery else { return nil }
    let pending = Pending(entries: Array(unsent.prefix(limit)), lost: Array(lost.prefix(limit)))
    if !pending.entries.isEmpty || !pending.lost.isEmpty {
      inFlight = (pending.entries.last?.sequence ?? 0, pending.lost.count)
    }
    return pending
  }

  /// Settles the batch that sent the unsent entries through `through` and the first `lostCount`
  /// loss ranges.
  func settle(_ generation: Int, through: Int, lostCount: Int, as settlement: Settlement) {
    guard generation == delivery else { return }
    inFlight = nil
    switch settlement {
    case .delivered:
      unsent.removeAll { $0.sequence <= through }
      lost.removeFirst(min(lostCount, lost.count))
    case .refused:
      let refused = unsent.prefix { $0.sequence <= through }.map(\.sequence)
      unsent.removeFirst(refused.count)
      for sequence in refused { declareLost(sequence) }
    case .unsent:
      break
    }
    lost.sort { $0.afterSequence < $1.afterSequence }
    lost = lost.reduce(into: []) { merged, range in
      if let last = merged.last, last.throughSequence >= range.afterSequence {
        merged[merged.count - 1] = LostRange(
          afterSequence: last.afterSequence,
          throughSequence: max(last.throughSequence, range.throughSequence))
      } else {
        merged.append(range)
      }
    }
  }

  /// Adds `sequence` to the loss ranges, extending the last range unless it is in flight.
  private func declareLost(_ sequence: Int) {
    if lost.count > inFlight?.lost ?? 0, let last = lost.last, last.throughSequence == sequence - 1 {
      lost[lost.count - 1] = LostRange(afterSequence: last.afterSequence, throughSequence: sequence)
    } else {
      lost.append(LostRange(afterSequence: sequence - 1, throughSequence: sequence))
    }
  }

  func report(current: Snapshot) -> String {
    let generatedAt = Date()
    let generatedUptime = Finite(ProcessInfo.processInfo.systemUptime)
    func encoded(_ retained: [Entry]) -> Data? {
      let report = Report(
        schemaVersion: 1, metadata: metadata, generatedAt: generatedAt, generatedUptime: generatedUptime,
        evictedCount: evictedCount + entries.count - retained.count, current: current, entries: retained)
      return Self.encode(report)
    }
    if let data = encoded(entries), data.count <= maxReportBytes {
      return String(decoding: data, as: UTF8.self)
    }
    let incidents = entries.filter { $0.event != .sample }
    var lower = 0
    var upper = incidents.count
    var best = encoded([]) ?? Data("{}".utf8)
    while lower <= upper {
      let count = lower + (upper - lower) / 2
      if let data = encoded(Array(incidents.suffix(count))), data.count <= maxReportBytes {
        best = data
        lower = count + 1
      } else {
        upper = count - 1
      }
    }
    return best.count <= maxReportBytes ? String(decoding: best, as: UTF8.self) : "{}"
  }

  func reset() {
    entries.removeAll(keepingCapacity: true)
    nextSequence = 1
    evictedCount = 0
    delivery = nil
    unsent.removeAll()
    lost.removeAll()
    inFlight = nil
  }

  private static func encode(_ report: Report) -> Data? {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try? encoder.encode(report)
  }
}
