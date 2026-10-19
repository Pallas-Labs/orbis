import Foundation
import XCTest

@testable import Orbis

@MainActor
final class PlaybackDiagnosticsSenderTests: XCTestCase {
  private struct FixtureState: Decodable {
    let requests: Int
    let waiting: Int
    let bodies: [PlaybackDiagnosticsUpload]
  }

  private func seed() throws -> URL {
    guard let value = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SEED_ADDRESS"],
      let url = URL(string: value)
    else { throw XCTSkip("Run through native-lanes with the real HTTP fixture") }
    return url
  }

  private func configure(status: Int = 200, retryAfter: String? = nil, held: Bool = false) async throws -> OrbisClient {
    let url = try seed()
    var request = URLRequest(url: url.appending(path: "diagnostics-control"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(Control(status: status, retryAfter: retryAfter, held: held))
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
    return OrbisClient(address: url, token: "native-probe-token")
  }

  private struct Control: Encodable {
    let status: Int
    let retryAfter: String?
    let held: Bool
  }

  private func state() async throws -> FixtureState {
    let (data, _) = try await URLSession.shared.data(from: try seed().appending(path: "diagnostics-state"))
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
      _ = try await waitForRequests(1)
      try await Task.sleep(for: .milliseconds(500))
      let observed = try await state()
      XCTAssertEqual(observed.requests, 1)
      sender.cancel()
    }
  }

  func testRetryableStatusesKeepOneFrozenBatchAndStopAtThreeAttempts() async throws {
    for status in [429, 503] {
      let client = try await configure(status: status, retryAfter: "0")
      let player = AudioPlayer(session: .init(start: { false }, end: {}))
      let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
      defer { sender.cancel() }
      player.skipToNextCue()
      let captured = try await waitForRequests(3)
      XCTAssertEqual(
        captured.bodies.map(\.throughSequence),
        Array(repeating: captured.bodies.first?.throughSequence ?? -1, count: 3))
      XCTAssertEqual(Set(captured.bodies.map(\.runId)).count, 1)
      try await Task.sleep(for: .milliseconds(300))
      let observed = try await state()
      XCTAssertEqual(observed.requests, 3)
    }
  }

  func testDroppedHistoryRemainsUnacknowledgedAndResetEndsSender() async throws {
    let client = try await configure(status: 500)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer { sender.cancel() }
    player.skipToNextCue()
    let first = try await waitForRequests(1)
    player.pause()
    let second = try await waitForRequests(2)
    XCTAssertEqual(second.bodies.last?.afterSequence, first.bodies.first?.afterSequence)
    XCTAssertGreaterThan(second.bodies.last?.throughSequence ?? 0, first.bodies.first?.throughSequence ?? 0)
    player.resetDiagnostics()
    try await Task.sleep(for: .milliseconds(150))
    player.skipToNextCue()
    try await Task.sleep(for: .milliseconds(200))
    let observed = try await state()
    XCTAssertEqual(observed.requests, 2)
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
    let player = AudioPlayer()
    let sender = PlaybackDiagnosticsSender(player: player, client: client, pollInterval: .milliseconds(50))
    defer {
      sender.cancel()
      player.stop()
    }
    player.play(set: set, baseURL: try seed().appending(path: "stream"), token: token)
    player.player?.volume = 0
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

}
