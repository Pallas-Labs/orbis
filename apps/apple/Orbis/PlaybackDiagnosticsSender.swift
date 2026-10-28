import Foundation

struct PlaybackDiagnosticsUpload: Codable, Sendable {
  let schemaVersion: Int
  let runId: UUID
  let metadata: PlaybackDiagnostics.Metadata
  let afterSequence: Int
  let throughSequence: Int
  let entries: [PlaybackDiagnostics.Entry]
  /// Ranges this run will never send. Absent when there are none, so a Group that predates the
  /// field still accepts the batch.
  let lost: [PlaybackDiagnostics.LostRange]?
}

actor PlaybackDiagnosticsEncoder {
  struct Batch: Sendable {
    let body: Data
    /// The last entry the body carries, or 0 when it carries only loss ranges.
    let lastEntry: Int
    let lostCount: Int
  }

  func encode(
    pending: PlaybackDiagnostics.Pending, runID: UUID, metadata: PlaybackDiagnostics.Metadata,
    maxBytes: Int = 64 * 1_024
  ) throws -> Batch {
    let metadata = PlaybackDiagnostics.Metadata(
      appVersion: String(decoding: metadata.appVersion.utf16.prefix(64), as: UTF16.self),
      appBuild: String(decoding: metadata.appBuild.utf16.prefix(64), as: UTF16.self),
      osName: String(decoding: metadata.osName.utf16.prefix(64), as: UTF16.self),
      osVersion: String(decoding: metadata.osVersion.utf16.prefix(64), as: UTF16.self))
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    var count = pending.entries.count
    while true {
      try Task.checkCancellation()
      let entries = Array(pending.entries.prefix(count))
      let through = entries.last?.sequence ?? pending.lost.last?.throughSequence ?? 0
      let upload = PlaybackDiagnosticsUpload(
        schemaVersion: 1, runId: runID, metadata: metadata,
        afterSequence: entries.first.map { $0.sequence - 1 } ?? through,
        throughSequence: through, entries: entries, lost: pending.lost.isEmpty ? nil : pending.lost)
      let data = try encoder.encode(upload)
      if data.count <= min(maxBytes, 64 * 1_024) {
        return Batch(body: data, lastEntry: entries.last?.sequence ?? 0, lostCount: pending.lost.count)
      }
      guard count > 1 else { throw DiagnosticsUploadFailure.invalidResponse }
      count /= 2
    }
  }
}

@MainActor
final class PlaybackDiagnosticsSender {
  private let task: Task<Void, Never>

  init(player: AudioPlayer, client: OrbisClient, pollInterval: Duration = .seconds(5)) {
    let delivery = player.startDiagnosticsDelivery()
    task = Task { [weak player] in
      await Self.run(
        client: client, pollInterval: pollInterval,
        pending: { [weak player] in player?.pendingDiagnostics(for: delivery, limit: 32) },
        settle: { [weak player] batch, settlement in
          player?.settleDiagnostics(
            delivery, through: batch.lastEntry, lostCount: batch.lostCount, as: settlement)
        })
    }
  }

  deinit { task.cancel() }

  func cancel() { task.cancel() }

  private enum Outcome {
    case acknowledged
    case refused
    case unsent(retryAfter: TimeInterval?)
    case stopped
  }

  /// Sends unsent history oldest first until the Group acknowledges it, so a batch can arrive
  /// twice but never silently goes missing. A refused batch, and history evicted beyond
  /// `PlaybackDiagnostics.unsentEntryLimit`, is declared lost in a later batch instead.
  private static func run(
    client: OrbisClient, pollInterval: Duration,
    pending: @MainActor () -> PlaybackDiagnostics.Pending?,
    settle: @MainActor (PlaybackDiagnosticsEncoder.Batch, PlaybackDiagnostics.Settlement) -> Void
  ) async {
    let encoder = PlaybackDiagnosticsEncoder()
    let runID = UUID()
    let metadata = PlaybackDiagnostics.Metadata.current
    var delay = pollInterval
    var failures = 0
    do {
      while !Task.isCancelled {
        try await Task.sleep(for: delay)
        delay = pollInterval
        guard let next = pending() else { return }
        guard !next.entries.isEmpty || !next.lost.isEmpty else { continue }
        let batch = try await encoder.encode(pending: next, runID: runID, metadata: metadata)
        try Task.checkCancellation()
        let outcome = await deliver(batch.body, client: client)
        try Task.checkCancellation()
        switch outcome {
        case .acknowledged:
          failures = 0
          settle(batch, .delivered)
        case .refused:
          failures += 1
          settle(batch, .refused)
          delay = backoff(pollInterval, failures: failures)
        case .unsent(let retryAfter):
          failures += 1
          settle(batch, .unsent)
          delay = max(backoff(pollInterval, failures: failures), .seconds(retryAfter ?? 0))
        case .stopped:
          return
        }
      }
    } catch {}
  }

  /// Doubles the poll interval for each failure in a row, up to a minute.
  private static func backoff(_ pollInterval: Duration, failures: Int) -> Duration {
    min(pollInterval * (1 << min(failures, 6)), max(pollInterval, .seconds(60)))
  }

  private static func deliver(_ body: Data, client: OrbisClient) async -> Outcome {
    do {
      let result = try await client.uploadPlaybackDiagnostics(body)
      guard !Task.isCancelled else { return .stopped }
      switch result.status {
      case 200:
        return .acknowledged
      case 401, 403, 404:
        return .stopped
      case 408, 429, 502, 503, 504:
        if let retryAfter = result.retryAfter, retryAfter > 300 { return .stopped }
        return .unsent(retryAfter: result.retryAfter)
      default:
        return .refused
      }
    } catch is CancellationError {
      return .stopped
    } catch let error as URLError where error.code == .cancelled {
      return .stopped
    } catch {
      return Task.isCancelled ? .stopped : .unsent(retryAfter: nil)
    }
  }
}
