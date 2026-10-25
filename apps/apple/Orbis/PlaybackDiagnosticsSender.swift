import Foundation

struct PlaybackDiagnosticsUpload: Codable, Sendable {
  let schemaVersion: Int
  let runId: UUID
  let metadata: PlaybackDiagnostics.Metadata
  let afterSequence: Int
  let throughSequence: Int
  let entries: [PlaybackDiagnostics.Entry]
}

actor PlaybackDiagnosticsEncoder {
  struct Batch: Sendable {
    let body: Data
    let throughSequence: Int
  }

  func encode(
    slice: PlaybackDiagnostics.Slice, runID: UUID, metadata: PlaybackDiagnostics.Metadata,
    afterSequence: Int, maxBytes: Int = 64 * 1_024
  ) throws -> Batch {
    let metadata = PlaybackDiagnostics.Metadata(
      appVersion: String(decoding: metadata.appVersion.utf16.prefix(64), as: UTF16.self),
      appBuild: String(decoding: metadata.appBuild.utf16.prefix(64), as: UTF16.self),
      osName: String(decoding: metadata.osName.utf16.prefix(64), as: UTF16.self),
      osVersion: String(decoding: metadata.osVersion.utf16.prefix(64), as: UTF16.self))
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    var count = slice.entries.count
    while true {
      try Task.checkCancellation()
      let entries = Array(slice.entries.prefix(count))
      let through = count == slice.entries.count ? slice.throughSequence : entries.last?.sequence ?? afterSequence
      let upload = PlaybackDiagnosticsUpload(
        schemaVersion: 1, runId: runID, metadata: metadata, afterSequence: afterSequence,
        throughSequence: through, entries: entries)
      let data = try encoder.encode(upload)
      if data.count <= min(maxBytes, 64 * 1_024) {
        return Batch(body: data, throughSequence: through)
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
    let tail = player.diagnosticsTail()
    task = Task { [weak player] in
      await Self.run(
        client: client, tail: tail, pollInterval: pollInterval,
        capture: { [weak player] sequence in
          player?.diagnostics(after: sequence, limit: 32)
        })
    }
  }

  deinit { task.cancel() }

  func cancel() { task.cancel() }

  private enum Outcome {
    case acknowledged
    case dropped
    case cooldown(TimeInterval)
    case stopped
  }

  private static func run(
    client: OrbisClient, tail: Int, pollInterval: Duration,
    capture: @MainActor (Int) -> PlaybackDiagnostics.Slice?
  ) async {
    let encoder = PlaybackDiagnosticsEncoder()
    let runID = UUID()
    let metadata = PlaybackDiagnostics.Metadata.current
    var readSequence = tail
    var acknowledgedSequence = tail
    var delay = pollInterval
    do {
      while !Task.isCancelled {
        try await Task.sleep(for: delay)
        delay = pollInterval
        guard let slice = capture(readSequence), slice.throughSequence >= readSequence else { return }
        guard slice.throughSequence > readSequence else { continue }
        let batch = try await encoder.encode(
          slice: slice, runID: runID, metadata: metadata, afterSequence: acknowledgedSequence)
        try Task.checkCancellation()
        let outcome = await deliver(batch.body, client: client)
        try Task.checkCancellation()
        readSequence = batch.throughSequence
        switch outcome {
        case .acknowledged:
          acknowledgedSequence = batch.throughSequence
        case .dropped:
          break
        case .cooldown(let seconds):
          delay = .seconds(seconds)
        case .stopped:
          return
        }
      }
    } catch {}
  }

  private static func deliver(_ body: Data, client: OrbisClient) async -> Outcome {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(60))
    for attempt in 0..<3 {
      guard !Task.isCancelled, clock.now < deadline else { return .dropped }
      var retryAfter: TimeInterval?
      do {
        let result = try await client.uploadPlaybackDiagnostics(body)
        guard !Task.isCancelled else { return .stopped }
        switch result.status {
        case 200:
          return .acknowledged
        case 401, 403, 404:
          return .stopped
        case 429, 503:
          retryAfter = result.retryAfter
        default:
          return .dropped
        }
      } catch is CancellationError {
        return .stopped
      } catch let error as URLError {
        if error.code == .cancelled { return .stopped }
      } catch {
        return .dropped
      }
      if let retryAfter, retryAfter > 300 { return .stopped }
      if let retryAfter, retryAfter > 30 { return .cooldown(retryAfter) }
      guard attempt < 2 else {
        return retryAfter.map { .cooldown($0) } ?? .dropped
      }
      let backoff = Double(1 << attempt) * Double.random(in: 0.8...1.2)
      let delay = max(backoff, retryAfter ?? 0)
      guard clock.now.advanced(by: .seconds(delay + 10)) <= deadline else { return .cooldown(delay) }
      do { try await Task.sleep(for: .seconds(delay)) } catch { return .stopped }
    }
    return .dropped
  }
}
