import Foundation
import XCTest

@testable import Orbis

@MainActor
final class PlaybackDiagnosticsSenderTests: XCTestCase {
  private struct Delivered: Decodable {
    let sequence: Int
    let event: String
  }

  private struct Lost: Decodable, Equatable {
    let afterSequence: Int
    let throughSequence: Int
  }

  /// What the fixture received, and what the relay would have written to SigNoz from it.
  private struct FixtureState: Decodable {
    let requests: Int
    let waiting: Int
    let bodies: [PlaybackDiagnosticsUpload]
    let delivered: [Delivered]
    let lost: [Lost]

    /// The sequences in `1...tail` that neither arrived nor fall in a loss range.
    func absent(through tail: Int) -> [Int] {
      let arrived = Set(delivered.map(\.sequence))
      return (0..<tail).map { $0 + 1 }.filter { sequence in
        !arrived.contains(sequence)
          && !lost.contains { $0.afterSequence < sequence && sequence <= $0.throughSequence }
      }
    }
  }

  private func seed() throws -> URL {
    guard let value = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SEED_ADDRESS"],
      let url = URL(string: value)
    else { throw XCTSkip("Run through native-lanes with the real HTTP fixture") }
    return url
  }

  /// Sets how the fixture answers uploads. `fault` and `status` apply to the first `times`
  /// requests, or to every request when `times` is nil.
  @discardableResult
  private func configure(
    status: Int = 200, retryAfter: String? = nil, held: Bool = false, fault: String? = nil,
    times: Int? = nil
  ) async throws -> OrbisClient {
    let url = try seed()
    var request = URLRequest(url: url.appending(path: "diagnostics-control"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(
      Control(status: status, retryAfter: retryAfter, held: held, fault: fault, times: times))
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
    return OrbisClient(address: url, token: "native-probe-token")
  }

  private struct Control: Encodable {
    let status: Int
    let retryAfter: String?
    let held: Bool
    let fault: String?
    let times: Int?
  }

  private func state(retaining name: String? = nil) async throws -> FixtureState {
    let (data, _) = try await URLSession.shared.data(from: try seed().appending(path: "diagnostics-state"))
    if let name {
      let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    return try decoder.decode(FixtureState.self, from: data)
  }

  private func waitForRequests(_ count: Int, seconds: Double = 8) async throws -> FixtureState {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
      let result = try await state()
      if result.requests >= count { return result }
      try await Task.sleep(for: .milliseconds(50))
    } while ProcessInfo.processInfo.systemUptime < deadline
    XCTFail("Missing upload \(count)")
    return try await state()
  }

  /// Waits until every sequence the player recorded has arrived or is named lost, then a
  /// little longer so a late duplicate or a second loss record would show, and retains the
  /// fixture's state as `name`.
  private func waitForHistory(
    of player: AudioPlayer, retaining name: String, seconds: Double = 20
  ) async throws -> FixtureState {
    let tail = player.diagnosticsTail()
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
      if try await state().absent(through: tail).isEmpty { break }
      try await Task.sleep(for: .milliseconds(50))
    } while ProcessInfo.processInfo.systemUptime < deadline
    try await Task.sleep(for: .milliseconds(500))
    let result = try await state(retaining: name)
    let absent = result.absent(through: tail)
    XCTAssertTrue(absent.isEmpty, "Silently absent sequences: \(absent)")
    return result
  }

  private func assertEveryRecordArrived(_ state: FixtureState, through tail: Int) {
    XCTAssertEqual(state.lost, [], "No history was lost, so none may be declared lost")
    XCTAssertEqual(Set(state.delivered.map(\.sequence)), Set((0..<tail).map { $0 + 1 }))
  }

  func testSlicesAccountForInternalAndTrailingEvictedSamples() {
    let ring = PlaybackDiagnostics(maxEntries: 3)
    let snapshot = PlaybackDiagnostics.Snapshot()
    ring.record(.command(.init(kind: .play, origin: .app)), snapshot: snapshot)
    ring.record(.sample, snapshot: snapshot)
    ring.record(.stalled, snapshot: snapshot)
    ring.record(.command(.init(kind: .pause, origin: .app)), snapshot: snapshot)
    ring.record(.sample, snapshot: snapshot)
    let first = ring.slice(after: 0, limit: 2)
    XCTAssertEqual(first.entries.map(\.sequence), [1, 3])
    XCTAssertEqual(first.throughSequence, 3)
    let last = ring.slice(after: first.throughSequence, limit: 32)
    XCTAssertEqual(last.entries.map(\.sequence), [4])
    XCTAssertEqual(last.throughSequence, 5)
    XCTAssertTrue(ring.slice(after: 5, limit: 32).entries.isEmpty)
  }

  func testEncoderHalvingPreservesTheUnsentSuffixAndMillisecondDates() async throws {
    let ring = PlaybackDiagnostics()
    var snapshot = PlaybackDiagnostics.Snapshot()
    snapshot.bufferRanges = (0..<8).map { .init(start: .init(Double($0)), duration: .init(120)) }
    for _ in 0..<70 {
      ring.record(.sample, snapshot: snapshot, wallTime: Date(timeIntervalSince1970: 1_792_300_000.123))
    }
    let slice = ring.slice(after: 0, limit: 32)
    XCTAssertEqual(slice.entries.count, 32)
    let encoder = PlaybackDiagnosticsEncoder()
    let encoded = try await encoder.encode(
      slice: slice, runID: UUID(), metadata: .current, afterSequence: 0, maxBytes: 4_096)
    XCTAssertLessThanOrEqual(encoded.body.count, 4_096)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    let upload = try decoder.decode(PlaybackDiagnosticsUpload.self, from: encoded.body)
    XCTAssertLessThan(upload.entries.count, 32)
    XCTAssertEqual(upload.throughSequence, upload.entries.last?.sequence)
    let next = ring.slice(after: upload.throughSequence, limit: 32)
    XCTAssertEqual(next.entries.first?.sequence, upload.throughSequence + 1)
    XCTAssertEqual(upload.entries.first?.wallTime.timeIntervalSince1970 ?? 0, 1_792_300_000.123, accuracy: 0.0001)
    let full = try await encoder.encode(slice: slice, runID: UUID(), metadata: .current, afterSequence: 0)
    XCTAssertLessThanOrEqual(full.body.count, 65_536)
    let attachment = XCTAttachment(data: full.body, uniformTypeIdentifier: "public.json")
    attachment.name = "playback-upload.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testRealHTTPUploadHasNumericReceiptAndRetainsActualPayload() async throws {
    let client = try await configure()
    let ring = PlaybackDiagnostics()
    ring.record(.command(.init(kind: .seek, origin: .systemRemote, target: .init(8.5))), snapshot: .init())
    ring.record(.stalled, snapshot: .init())
    let encoded = try await PlaybackDiagnosticsEncoder().encode(
      slice: ring.slice(after: 0, limit: 32), runID: UUID(), metadata: .current, afterSequence: 0)
    let receipt = try await client.uploadPlaybackDiagnostics(encoded.body)
    XCTAssertEqual(receipt.status, 200)
    let captured = try await state()
    XCTAssertEqual(captured.requests, 1)
    XCTAssertEqual(captured.bodies.first?.entries.count, 2)
    let attachment = XCTAttachment(data: encoded.body, uniformTypeIdentifier: "public.json")
    attachment.name = "native-http-playback-upload.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testPermanentStatusesAndPartialSuccessNeverRetryTheBatch() async throws {
    for status in [200, 400, 413, 500, 401, 403, 404] {
      let client = try await configure(status: status)
      let player = AudioPlayer(session: .init(start: { false }, end: {}))
      let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
      player.skipToNextCue()
      let first = try await waitForRequests(1)
      let sent = try XCTUnwrap(first.bodies.first?.throughSequence)
      try await Task.sleep(for: .milliseconds(500))
      let observed = try await state()
      if [401, 403, 404].contains(status) { XCTAssertEqual(observed.requests, 1) }
      for body in observed.bodies.dropFirst() {
        XCTAssertFalse(body.entries.contains { $0.sequence <= sent }, "\(status) must not resend its entries")
      }
      sender.cancel()
    }
  }

  func testTransportFailureResendsTheSameEntriesAndDeclaresNoLoss() async throws {
    let client = try await configure(fault: "close-before-body", times: 3)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    _ = try await waitForRequests(3)
    player.pause()
    let state = try await waitForHistory(of: player, retaining: "transport-failure-then-success.json")
    XCTAssertGreaterThan(state.requests, 3)
    assertEveryRecordArrived(state, through: player.diagnosticsTail())
  }

  func testStoredButUnacknowledgedBatchIsResentWithoutLoss() async throws {
    let client = try await configure(fault: "close-after-body", times: 3)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    _ = try await waitForRequests(3)
    player.pause()
    let state = try await waitForHistory(of: player, retaining: "stored-but-unacknowledged.json")
    XCTAssertGreaterThan(
      state.delivered.count, Set(state.delivered.map(\.sequence)).count,
      "The stored batch is sent again, so its entries arrive more than once")
    assertEveryRecordArrived(state, through: player.diagnosticsTail())
  }

  func testRetryableStatusesResendTheSameEntriesUntilAccepted() async throws {
    for status in [429, 503] {
      let client = try await configure(status: status, retryAfter: "0", times: 3)
      let player = AudioPlayer(session: .init(start: { false }, end: {}))
      let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
      defer { sender.cancel() }
      player.skipToNextCue()
      _ = try await waitForRequests(3)
      player.pause()
      let state = try await waitForHistory(of: player, retaining: "retryable-\(status).json")
      let firstSent = state.bodies.prefix(4).map { $0.entries.first?.sequence }
      XCTAssertEqual(firstSent, Array(repeating: firstSent.first ?? nil, count: 4))
      XCTAssertEqual(Set(state.bodies.map(\.runId)).count, 1)
      assertEveryRecordArrived(state, through: player.diagnosticsTail())
    }
  }

  func testRefusedBatchIsDeclaredLostOnceWithItsExactRange() async throws {
    let client = try await configure(status: 400, times: 1)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    let firstRequest = try await waitForRequests(1)
    let refused = try XCTUnwrap(firstRequest.bodies.first)
    let first = try XCTUnwrap(refused.entries.first?.sequence)
    let last = try XCTUnwrap(refused.entries.last?.sequence)
    player.pause()
    let state = try await waitForHistory(of: player, retaining: "refused-400.json")
    XCTAssertEqual(state.lost, [Lost(afterSequence: first - 1, throughSequence: last)])
    let tail = player.diagnosticsTail()
    XCTAssertEqual(Set(state.delivered.map(\.sequence)), Set((last..<tail).map { $0 + 1 }))
  }

  func testSamplesAfterARingOfIncidentsAllArrive() async throws {
    let client = try await configure()
    let player = AudioPlayer()
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer {
      sender.cancel()
      player.stop()
    }
    for _ in 0..<256 { player.recordError(URLError(.timedOut)) }
    try await playFixture(on: player)
    try await Task.sleep(for: .seconds(12))
    player.pause()
    let state = try await waitForHistory(of: player, retaining: "incidents-then-samples.json")
    XCTAssertGreaterThanOrEqual(state.delivered.filter { $0.event == "sample" }.count, 2)
    assertEveryRecordArrived(state, through: player.diagnosticsTail())
  }

  func testUnsentHistoryBeyondItsBoundIsDeclaredLostExactly() async throws {
    // The documented bound on unsent history ("Playback reports" in docs/development.md).
    let bound = 1_024
    let client = try await configure(held: true, times: 1)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    let held = try await waitForRequests(1)
    let inFlight = try XCTUnwrap(held.bodies.first?.throughSequence)
    for _ in 0..<1_100 { player.recordError(URLError(.timedOut)) }
    let tail = player.diagnosticsTail()
    // Ends the held request without a receipt, so its entries are sent again.
    try await configure()
    let state = try await waitForHistory(of: player, retaining: "unsent-bound.json")
    let evictedThrough = inFlight + tail - bound
    XCTAssertEqual(state.lost, [Lost(afterSequence: inFlight, throughSequence: evictedThrough)])
    let kept = (0..<inFlight).map { $0 + 1 } + (evictedThrough..<tail).map { $0 + 1 }
    XCTAssertEqual(Set(state.delivered.map(\.sequence)), Set(kept))
  }

  func testResetEndsSender() async throws {
    let client = try await configure()
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    let sent = try await waitForHistory(of: player, retaining: "before-reset.json")
    player.resetDiagnostics()
    try await Task.sleep(for: .milliseconds(150))
    player.skipToNextCue()
    try await Task.sleep(for: .milliseconds(300))
    let observed = try await state()
    XCTAssertEqual(observed.requests, sent.requests)
  }

  func testLongRetryAfterStopsAndDroppingOwnerCancelsBlockedRequest() async throws {
    let client = try await configure(status: 503, retryAfter: "301")
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    var sender: PlaybackDiagnosticsSender? = PlaybackDiagnosticsSender(
      player: player, client: client, pollInterval: .milliseconds(50))
    weak var weakSender = sender
    player.skipToNextCue()
    _ = try await waitForRequests(1)
    player.pause()
    try await Task.sleep(for: .milliseconds(300))
    let observed = try await state()
    XCTAssertEqual(observed.requests, 1)
    sender = nil
    XCTAssertNil(weakSender)

    let blocked = try await configure(held: true)
    sender = PlaybackDiagnosticsSender(player: player, client: blocked, pollInterval: .milliseconds(50))
    player.skipToNextCue()
    _ = try await waitForRequests(1)
    sender = nil
    try await Task.sleep(for: .milliseconds(300))
    let unblocked = try await state()
    XCTAssertEqual(unblocked.waiting, 0)
  }

  func testAppModelSignOutCancelsBlockedUploadAndBackoff() async throws {
    for held in [true, false] {
      let client = try await configure(status: 503, retryAfter: "30", held: held)
      let model = AppModel(client: client, settings: MemoryClientSettings())
      model.audioPlayer.skipToNextCue()
      _ = try await waitForRequests(1)
      model.signOut()
      try await Task.sleep(for: .milliseconds(500))
      let captured = try await state()
      XCTAssertEqual(captured.requests, 1)
      XCTAssertEqual(captured.waiting, 0)
    }
  }

  func testPlaybackAdvancesWhileOneUploadIsBlocked() async throws {
    let client = try await configure(held: true)
    let player = AudioPlayer()
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer {
      sender.cancel()
      player.stop()
    }
    try await playFixture(on: player)
    _ = try await waitForRequests(1)
    let start = player.player?.currentTime().seconds ?? 0
    try await Task.sleep(for: .seconds(3))
    let end = player.player?.currentTime().seconds ?? 0
    XCTAssertGreaterThan(end, start + 1)
    let captured = try await state()
    XCTAssertEqual(captured.requests, 1)
    XCTAssertEqual(captured.waiting, 1)
    if case .failed = player.state { XCTFail("Upload failure must not fail playback") }
  }

  /// Plays the lane's seeded Set as real Ogg audio, silently.
  private func playFixture(on player: AudioPlayer) async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"].flatMap(URL.init(string:)),
      let token = environment["ORBIS_UI_TEST_TOKEN"]
    else { throw XCTSkip("Run through native-lanes") }
    let service = OrbisClient(address: address, token: token)
    let sets = try await service.library()
    let set = try XCTUnwrap(sets.first)
    var request = URLRequest(url: try seed().appending(path: "ready-ogg/\(set.id)"))
    request.httpMethod = "POST"
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
    player.play(set: set, baseURL: try seed().appending(path: "stream"), token: token)
    player.player?.volume = 0
  }
}
