import Foundation

/// Recent typed playback evidence for a report copied during this app run.
/// AudioPlayer owns one instance on the main actor.
final class PlaybackDiagnostics {
  static let retainedEntryLimit = 256
  static let reportByteLimit = 256 * 1_024

  struct Finite: Codable, Equatable {
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

  enum PlaybackState: String, Codable {
    case idle, loading, playing, paused, interrupted, failed
  }

  enum ItemState: String, Codable {
    case none, unknown, ready, failed
  }

  enum WaitingReason: String, Codable {
    case none, minimizingStalls, evaluatingBufferingRate, noItem, interstitial, other
  }

  enum Origin: String, Codable {
    case app, systemRemote, internalOperation, unknown
  }

  enum CommandKind: String, Codable {
    case play, pause, toggle, seek, nextCue, previousCue, skipForward, skipBackward, stop
  }

  enum ErrorDomain: String, Codable {
    case url, avFoundation, coreMedia, osStatus, other
  }

  struct NormalizedError: Codable, Equatable {
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

  struct BufferRange: Codable, Equatable {
    let start: Finite
    let duration: Finite
  }

  struct AccessMetrics: Codable, Equatable {
    let bytesTransferred: Int64
    let transferDuration: Finite
    let observedBitrate: Finite
    let indicatedBitrate: Finite
    let stalls: Int
    let downloadedDuration: Finite
  }

  struct Snapshot: Codable, Equatable {
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
  }

  struct CommandEvent: Codable, Equatable {
    let kind: CommandKind
    let origin: Origin
    let target: Finite

    init(kind: CommandKind, origin: Origin, target: Finite = .init(nil)) {
      self.kind = kind
      self.origin = origin
      self.target = target
    }
  }

  struct StateEvent: Codable, Equatable {
    let from: PlaybackState
    let to: PlaybackState
  }

  struct SeekEvent: Codable, Equatable {
    let seekID: Int
    let target: Finite
    let actual: Finite
    let finished: Bool
    let duration: Finite
  }

  struct TimelineEvent: Codable, Equatable {
    let mediaDelta: Finite
    let wallDelta: Finite
    let rate: Finite
    let gap: Finite
  }

  struct TimeJumpEvent: Codable, Equatable {
    let actual: Finite
    let seekID: Int?
  }

  struct BufferEvent: Codable, Equatable {
    enum Reason: String, Codable { case ready, waiting, stalled }
    let reason: Reason
  }

  struct AccessEvent: Codable, Equatable {
    let metrics: AccessMetrics
  }

  struct WaitingEvent: Codable, Equatable {
    let reason: WaitingReason
  }

  struct SessionEvent: Codable, Equatable {
    enum Phase: String, Codable { case startRequested, ready, failed, endRequested, ended }
    let phase: Phase
    let requestID: Int
    let playbackGeneration: Int
  }

  struct ItemEvent: Codable, Equatable {
    enum Phase: String, Codable { case installed, ready, failed }
    let phase: Phase
    let error: NormalizedError?
  }

  struct InterruptionEvent: Codable, Equatable {
    enum Phase: String, Codable { case began, ended }
    let phase: Phase
    let shouldResume: Bool
  }

  struct RouteEvent: Codable, Equatable {
    enum Reason: String, Codable { case oldDeviceUnavailable, other }
    let reason: Reason
  }

  struct EndEvent: Codable, Equatable {
    let actual: Finite
    let expected: Finite
    let premature: Bool
  }

  struct ActivationEvent: Codable, Equatable {
    enum Phase: String, Codable { case began, intentChanged, accepted, superseded, failed }
    let phase: Phase
    let generation: Int
    let wantsSound: Bool
    let target: Finite
    let requestDuration: Finite
  }

  enum Event: Codable, Equatable {
    case command(CommandEvent)
    case state(StateEvent)
    case seekResult(SeekEvent)
    case sample
    case waiting(WaitingEvent)
    case stalled
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

  struct Entry: Codable, Equatable {
    let sequence: Int
    let wallTime: Date
    let uptime: Finite
    let event: Event
    let snapshot: Snapshot
  }

  struct Metadata: Codable, Equatable {
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

  struct Report: Codable, Equatable {
    let schemaVersion: Int
    let metadata: Metadata
    let generatedAt: Date
    let generatedUptime: Finite
    let evictedCount: Int
    let current: Snapshot
    let entries: [Entry]
  }

  private let maxEntries: Int
  private let maxReportBytes: Int
  private let metadata: Metadata
  private var entries: [Entry] = []
  private var nextSequence = 1
  private var evictedCount = 0

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
    entries.append(
      Entry(
        sequence: nextSequence, wallTime: wallTime, uptime: Finite(uptime), event: event,
        snapshot: snapshot))
    nextSequence += 1
    if entries.count > maxEntries {
      let overflow = entries.count - maxEntries
      entries.removeFirst(overflow)
      evictedCount += overflow
    }
  }

  func report(current: Snapshot) -> String {
    var renderedEntries = entries
    var reportEvictions = evictedCount
    let generatedAt = Date()
    let generatedUptime = Finite(ProcessInfo.processInfo.systemUptime)
    while true {
      let report = Report(
        schemaVersion: 1, metadata: metadata, generatedAt: generatedAt,
        generatedUptime: generatedUptime, evictedCount: reportEvictions,
        current: current, entries: renderedEntries)
      if let data = Self.encode(report), data.count <= maxReportBytes {
        return String(decoding: data, as: UTF8.self)
      }
      guard !renderedEntries.isEmpty else { return "{}" }
      let removal = max(1, renderedEntries.count / 2)
      renderedEntries.removeFirst(removal)
      reportEvictions += removal
    }
  }

  func reset() {
    entries.removeAll(keepingCapacity: true)
    nextSequence = 1
    evictedCount = 0
  }

  private static func encode(_ report: Report) -> Data? {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try? encoder.encode(report)
  }
}
