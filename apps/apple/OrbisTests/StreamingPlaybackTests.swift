import AVFoundation
import Foundation
import XCTest

@testable import Orbis

@MainActor
final class StreamingPlaybackTests: XCTestCase {
  private struct Fixture {
    let client: OrbisClient
    let set: SavedSet
    let seed: URL

    var streamAddress: URL { seed.appending(path: "stream") }
  }

  private struct StreamState: Decodable {
    let held: Bool
    let waiting: Int
    let requests: Int
    let bytesSent: Int
  }

  private enum Failure: Error {
    case timedOut(String)
  }

  private var samples: [[String: Any]] = []

  private func fixture() async throws -> Fixture {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"].flatMap(URL.init(string:)),
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty,
      let seed = environment["ORBIS_UI_TEST_SEED_ADDRESS"].flatMap(URL.init(string:))
    else { throw XCTSkip("Run through native-lanes with the real HTTP audio fixture") }
    let client = OrbisClient(address: address, token: token)
    let video = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(11))
    let saved = try await client.save(url: "https://www.youtube.com/watch?v=\(video)")
    try await control("ready-ogg", id: saved.id, seed: seed)
    let library = try await client.library()
    let ready = try XCTUnwrap(library.first { $0.id == saved.id })
    XCTAssertEqual(ready.durationSeconds, 600)
    return Fixture(client: client, set: ready, seed: seed)
  }

  private func control(_ action: String, id: String, seed: URL) async throws {
    var request = URLRequest(url: seed.appending(path: "\(action)/\(id)"))
    request.httpMethod = "POST"
    request.timeoutInterval = action.hasPrefix("ready-") ? 120 : 30
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
  }

  private func streamState(_ fixture: Fixture) async throws -> StreamState {
    let (data, response) = try await URLSession.shared.data(
      from: fixture.seed.appending(path: "stream-state/\(fixture.set.id)"))
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let state = try JSONDecoder().decode(StreamState.self, from: data)
    samples.append([
      "uptimeSeconds": ProcessInfo.processInfo.systemUptime,
      "held": state.held, "waitingResponses": state.waiting,
      "requests": state.requests, "bytesSent": state.bytesSent,
    ])
    return state
  }

  private func sample(_ player: AudioPlayer, phase: String) {
    let engine = player.player
    let raw = engine?.currentTime().seconds ?? .nan
    samples.append([
      "phase": phase,
      "uptimeSeconds": ProcessInfo.processInfo.systemUptime,
      "rawMediaSeconds": raw.isFinite ? raw as Any : NSNull(),
      "displayedSeconds": player.elapsed,
      "state": String(describing: player.state),
      "timeControlStatus": engine?.timeControlStatus.rawValue ?? -1,
      "waitingReason": engine?.reasonForWaitingToPlay?.rawValue ?? "none",
      "rate": engine?.rate ?? 0,
      "bufferEmpty": engine?.currentItem?.isPlaybackBufferEmpty ?? false,
      "likelyToKeepUp": engine?.currentItem?.isPlaybackLikelyToKeepUp ?? false,
      "itemStatus": engine?.currentItem?.status.rawValue ?? -1,
      "loadedRanges": engine?.currentItem?.loadedTimeRanges.map {
        ["start": $0.timeRangeValue.start.seconds, "duration": $0.timeRangeValue.duration.seconds]
      } ?? [],
    ])
  }

  private func retain(_ name: String) {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
    else {
      XCTFail("Streaming samples must be valid JSON")
      return
    }
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitUntil(
    _ message: String, player: AudioPlayer, seconds: Double = 30,
    _ condition: () async throws -> Bool
  ) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
      sample(player, phase: message)
      if try await condition() { return }
      try await Task.sleep(for: .milliseconds(50))
    } while ProcessInfo.processInfo.systemUptime < deadline
    XCTFail(message)
    throw Failure.timedOut(message)
  }

  private func observe(_ player: AudioPlayer, phase: String, seconds: Double = 1) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
      sample(player, phase: phase)
      try await Task.sleep(for: .milliseconds(50))
    } while ProcessInfo.processInfo.systemUptime < deadline
  }

  private func report(_ player: AudioPlayer) throws -> PlaybackDiagnostics.Report {
    let text = player.playbackReport()
    let attachment = XCTAttachment(data: Data(text.utf8), uniformTypeIdentifier: "public.json")
    attachment.name = "held-stream-playback-report.json"
    attachment.lifetime = .keepAlways
    add(attachment)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(PlaybackDiagnostics.Report.self, from: Data(text.utf8))
  }

  private func decodedReport(_ player: AudioPlayer) throws -> PlaybackDiagnostics.Report {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(
      PlaybackDiagnostics.Report.self, from: Data(player.playbackReport().utf8))
  }

  func testOrdinaryOggStreamingAdvancesWithoutTimelineJumps() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    defer {
      retain("ordinary-ogg-streaming-timeline")
      player.stop()
    }
    player.play(set: fixture.set, baseURL: fixture.streamAddress, token: fixture.client.token)
    player.player?.volume = 0
    try await waitUntil("The long Ogg stream must first advance", player: player) {
      player.player?.timeControlStatus == .playing
        && (player.player?.currentTime().seconds ?? 0) > 0.5
    }
    let engine = try XCTUnwrap(player.player)
    let start = engine.currentTime().seconds
    var previousMedia = start
    var previousUptime = ProcessInfo.processInfo.systemUptime
    let deadline = previousUptime + 10
    repeat {
      sample(player, phase: "ordinary uninterrupted streaming")
      let media = engine.currentTime().seconds
      let uptime = ProcessInfo.processInfo.systemUptime
      XCTAssertGreaterThanOrEqual(
        media - previousMedia, -0.15, "Ordinary streaming must not repeat its timeline")
      XCTAssertLessThanOrEqual(
        media - previousMedia, uptime - previousUptime + 0.3,
        "Ordinary streaming must not skip ahead on its timeline")
      previousMedia = media
      previousUptime = uptime
      try await Task.sleep(for: .milliseconds(50))
    } while ProcessInfo.processInfo.systemUptime < deadline
    XCTAssertGreaterThan(
      engine.currentTime().seconds, start + 8, "The stream must actually progress")
  }

  func testALateOggSeekMovesTheActualStreamingTimeline() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    defer {
      retain("late-ogg-seek-timeline")
      player.stop()
    }
    player.play(
      set: fixture.set, baseURL: fixture.client.address, token: fixture.client.token, startAt: 480)
    player.player?.volume = 0
    try await waitUntil("The late Ogg seek must play at the requested media time", player: player) {
      guard let engine = player.player else { return false }
      return engine.timeControlStatus == .playing && engine.currentTime().seconds >= 479.5
    }
    let engine = try XCTUnwrap(player.player)
    let landed = engine.currentTime().seconds
    XCTAssertLessThan(landed, 483)
    try await waitUntil("The late Ogg stream must advance after its seek", player: player) {
      engine.currentTime().seconds >= landed + 0.5
    }
    XCTAssertEqual(player.elapsed, engine.currentTime().seconds, accuracy: 0.6)
  }

  func testAPauseDuringAnHTTPBodyWaitSurvivesReadiness() async throws {
    let fixture = try await fixture()
    try await control("hold-stream", id: fixture.set.id, seed: fixture.seed)
    let player = AudioPlayer()
    defer {
      retain("pause-during-stream-loading")
      player.stop()
    }
    player.play(set: fixture.set, baseURL: fixture.streamAddress, token: fixture.client.token)
    player.player?.volume = 0
    try await waitUntil("The audio request must reach the body gate", player: player) {
      guard try await self.streamState(fixture).waiting > 0 else { return false }
      return try self.decodedReport(player).entries.contains { entry in
        if case .waiting = entry.event { return true }
        return false
      }
    }
    let heldReport = try report(player)
    XCTAssertEqual(heldReport.current.state, .loading)
    XCTAssertTrue(heldReport.entries.contains { entry in
      if case .waiting = entry.event { return true }
      return false
    })
    player.pause()
    try await control("release-stream", id: fixture.set.id, seed: fixture.seed)
    try await waitUntil("The released item must become ready while paused", player: player) {
      player.player?.currentItem?.status == .readyToPlay
    }
    let engine = try XCTUnwrap(player.player)
    let paused = engine.currentTime().seconds
    try await observe(player, phase: "paused after body release")
    XCTAssertEqual(engine.currentTime().seconds, paused, accuracy: 0.1)
    XCTAssertEqual(player.state, .paused)
    XCTAssertEqual(engine.rate, 0)
    player.resume()
    try await waitUntil("The released stream must advance after resume", player: player) {
      engine.timeControlStatus == .playing && engine.currentTime().seconds > paused + 0.5
    }
  }

  func testANaturalOggEndFinishesExactlyOnce() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    var finishes = 0
    player.onFinished = { [weak player] _ in
      finishes += 1
      if let player { self.sample(player, phase: "natural Ogg completion") }
    }
    defer {
      retain("natural-ogg-end-timeline")
      player.stop()
    }
    player.play(
      set: fixture.set, baseURL: fixture.client.address, token: fixture.client.token, startAt: 590)
    player.player?.volume = 0
    try await waitUntil("The Ogg Set must finish at its real end", player: player, seconds: 25) {
      finishes > 0
    }
    try await observe(player, phase: "after natural Ogg completion", seconds: 3)
    XCTAssertEqual(finishes, 1, "One natural audio end must finish the Listen exactly once")
  }

  func testARealBufferUnderrunHoldsPositionAndRecoversWithoutSkipping() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    var finishes = 0
    player.onFinished = { _ in finishes += 1 }
    defer {
      retain("ogg-buffer-underrun-recovery-timeline")
      player.stop()
    }
    player.play(set: fixture.set, baseURL: fixture.streamAddress, token: fixture.client.token)
    player.player?.volume = 0
    try await waitUntil("The controlled stream must first advance", player: player) {
      player.player?.timeControlStatus == .playing
        && (player.player?.currentTime().seconds ?? 0) > 0.5
    }
    try await control("hold-stream", id: fixture.set.id, seed: fixture.seed)
    try await waitUntil(
      "Withheld bytes must exhaust the real player buffer", player: player, seconds: 45
    ) {
      let state = try await self.streamState(fixture)
      return state.waiting > 0 && player.player?.timeControlStatus != .playing
    }
    let engine = try XCTUnwrap(player.player)
    let held = engine.currentTime().seconds
    try await observe(player, phase: "real buffer underrun")
    XCTAssertEqual(engine.currentTime().seconds, held, accuracy: 0.15)
    XCTAssertEqual(player.state, .loading, "Buffering must preserve the request to play")
    XCTAssertEqual(finishes, 0, "An early stream end must not finish the Listen")
    let releasedAt = ProcessInfo.processInfo.systemUptime
    var previousMedia = held
    var previousUptime = releasedAt
    try await control("release-stream", id: fixture.set.id, seed: fixture.seed)
    try await waitUntil("The real stream must recover after bytes resume", player: player) {
      let media = engine.currentTime().seconds
      let uptime = ProcessInfo.processInfo.systemUptime
      XCTAssertGreaterThanOrEqual(
        media - previousMedia, -0.15, "Recovery must not repeat audio time")
      XCTAssertLessThanOrEqual(media - previousMedia, uptime - previousUptime + 0.3)
      previousMedia = media
      previousUptime = uptime
      return engine.timeControlStatus == .playing && player.state == .playing && media > held + 0.5
    }
    let advanced = engine.currentTime().seconds - held
    let wallTime = ProcessInfo.processInfo.systemUptime - releasedAt
    XCTAssertLessThanOrEqual(advanced, wallTime + 0.3, "Recovery must not jump the media timeline")
    XCTAssertEqual(player.state, .playing)
    XCTAssertEqual(finishes, 0, "Recovery must keep the current Listen open")
  }
}
