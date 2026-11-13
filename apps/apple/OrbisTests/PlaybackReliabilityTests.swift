import AVFoundation
import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

@MainActor
final class PlaybackReliabilityTests: XCTestCase {
  private struct Fixture {
    let client: OrbisClient
    let set: SavedSet
  }

  private final class ActivationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String] = []
    func record(_ id: String) { lock.withLock { ids.append(id) } }
    var all: [String] { lock.withLock { ids } }
  }

  private final class PlayingPositions: @unchecked Sendable {
    private let lock = NSLock()
    private var positions: [Double] = []

    func observe(_ player: AVPlayer) {
      guard player.timeControlStatus == .playing else { return }
      lock.withLock { positions.append(player.currentTime().seconds) }
    }

    var first: Double? { lock.withLock { positions.first } }
  }

  private func fixture() async throws -> Fixture {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"].flatMap(URL.init(string:)),
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty,
      let seedAddress = environment["ORBIS_UI_TEST_SEED_ADDRESS"]
    else { throw XCTSkip("Run through native-lanes with the real HTTP audio fixture") }
    let client = OrbisClient(address: address, token: token)
    let video = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(11))
    let saved = try await client.save(url: "https://www.youtube.com/watch?v=\(video)")
    let endpoint = try XCTUnwrap(URL(string: "\(seedAddress)/ready-audio/\(saved.id)"))
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
    let library = try await client.library()
    let ready = try XCTUnwrap(library.first { $0.id == saved.id })
    XCTAssertEqual(ready.downloadState, "ready")
    XCTAssertEqual(ready.durationSeconds, 30)
    return Fixture(client: client, set: ready)
  }

  private func waitUntil(_ message: String, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(15)
    while !condition(), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(condition(), message)
  }

  private func record(_ name: String, _ values: [String: Any]) throws {
    let data = try JSONSerialization.data(
      withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func playbackReport(_ player: AudioPlayer) throws -> PlaybackDiagnostics.Report {
    let text = player.playbackReport()
    let attachment = XCTAttachment(data: Data(text.utf8), uniformTypeIdentifier: "public.json")
    attachment.name = "playback-report.json"
    attachment.lifetime = .keepAlways
    add(attachment)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(PlaybackDiagnostics.Report.self, from: Data(text.utf8))
  }

  func testReportFollowsRealAdvancementPauseAndSeek() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    defer { player.stop() }
    player.play(set: fixture.set, baseURL: fixture.client.address, token: fixture.client.token)
    player.player?.volume = 0
    try await waitUntil("The real stream must advance before the report") {
      player.state == .playing && (player.player?.currentTime().seconds ?? 0) > 0.5
    }
    player.pause()
    player.seek(to: 12)
    try await waitUntil("The report seek must land") {
      player.settledPosition.map { abs($0 - 12) < 0.25 } ?? false
    }

    let report = try playbackReport(player)
    let commands = report.entries.compactMap { entry -> PlaybackDiagnostics.CommandEvent? in
      guard case .command(let command) = entry.event else { return nil }
      return command
    }
    XCTAssertEqual(commands.suffix(2).map(\.kind), [.pause, .seek])
    let result = try XCTUnwrap(
      report.entries.compactMap { entry -> PlaybackDiagnostics.SeekEvent? in
        guard case .seekResult(let result) = entry.event else { return nil }
        return result
      }.last)
    XCTAssertTrue(result.finished)
    XCTAssertEqual(try XCTUnwrap(result.target.value), 12, accuracy: 0.01)
    XCTAssertEqual(try XCTUnwrap(result.actual.value), 12, accuracy: 0.25)
    XCTAssertEqual(try XCTUnwrap(report.current.displayedTime.value), 12, accuracy: 0.25)
    let installed = try XCTUnwrap(
      report.entries.last { entry in
        if case .item(let item) = entry.event { return item.phase == .installed }
        return false
      })
    let itemEntries = report.entries.filter { $0.sequence >= installed.sequence }
    XCTAssertEqual(Set(itemEntries.map(\.snapshot.playbackGeneration)).count, 1)
  }

  func testInitialSeekFinishesBeforeAudioStarts() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    defer { player.stop() }
    player.play(
      set: fixture.set, baseURL: fixture.client.address, token: fixture.client.token, startAt: 12)
    let engine = try XCTUnwrap(player.player)
    let positions = PlayingPositions()
    let observation = engine.observe(\.timeControlStatus, options: [.initial, .new]) { engine, _ in
      positions.observe(engine)
    }
    defer { observation.invalidate() }
    try await waitUntil("The real HTTP stream must start playing") { positions.first != nil }
    let first = try XCTUnwrap(positions.first)
    try record("initial-seek-before-audio", ["requestedSeconds": 12, "firstPlayingSeconds": first])
    XCTAssertGreaterThanOrEqual(first, 11.8, "No audio before the requested start may play")
    XCTAssertLessThan(first, 14)
  }

  func testAColdExplicitCueNearTheEndKeepsItsTimestamp() async throws {
    let fixture = try await fixture()
    let model = AppModel(client: fixture.client, settings: MemoryClientSettings())
    defer { model.signOut() }
    let cue = Cue(
      position: 0, startSeconds: 26, artist: "Artist", title: "Late Cue", appleMusicId: nil,
      artworkUrl: nil)
    await model.playCue(cue, in: fixture.set.id)
    XCTAssertEqual(model.audioPlayer.elapsed, 26, accuracy: 0.2)
    try await waitUntil("The selected Cue must play") { model.audioPlayer.state == .playing }
    let actual = try XCTUnwrap(model.audioPlayer.player?.currentTime().seconds)
    try record("cold-explicit-cue", ["requestedSeconds": 26, "actualPlayingSeconds": actual])
    XCTAssertGreaterThanOrEqual(actual, 25.8)
    XCTAssertLessThan(actual, 29)
  }

  func testLatestSeekWinsAndPauseSurvivesItsCompletion() async throws {
    let fixture = try await fixture()
    let player = AudioPlayer()
    defer { player.stop() }
    player.play(set: fixture.set, baseURL: fixture.client.address, token: fixture.client.token)
    try await waitUntil("The stream must play before seeking") { player.state == .playing }
    player.seek(to: 24)
    player.seek(to: 8)
    player.pause()
    try await waitUntil("The latest seek must land while paused") {
      guard let position = player.player?.currentTime().seconds else { return false }
      return abs(position - 8) < 0.2 && abs(player.elapsed - position) < 0.2
    }
    XCTAssertEqual(player.state, .paused)
    XCTAssertEqual(player.player?.rate, 0)
    let paused = try XCTUnwrap(player.player?.currentTime().seconds)
    player.resume()
    try await waitUntil("Resume must play from the latest seek") { player.state == .playing }
    let resumed = try XCTUnwrap(player.player?.currentTime().seconds)
    try record("latest-seek-pause", ["pausedSeconds": paused, "resumedSeconds": resumed])
    XCTAssertGreaterThanOrEqual(resumed, 7.8)
    XCTAssertLessThan(resumed, 10)
  }

  func testRetryAfterARealHTTPItemFailurePlaysAgain() async throws {
    let fixture = try await fixture()
    let model = AppModel(client: fixture.client, settings: MemoryClientSettings())
    defer { model.signOut() }
    model.audioPlayer.play(
      set: fixture.set, baseURL: fixture.client.address, token: "invalid-lane-token")
    try await waitUntil("A rejected audio request must fail") {
      if case .failed = model.audioPlayer.state { return true }
      return false
    }
    model.togglePlayback()
    try await waitUntil("Retry with the valid device token must play") {
      model.audioPlayer.state == .playing
    }
    try await waitUntil("The retried audio timeline must advance") {
      (model.audioPlayer.player?.currentTime().seconds ?? 0) > 0.2
    }
    try record(
      "failed-item-retry", ["setId": fixture.set.id, "elapsedSeconds": model.audioPlayer.elapsed])
    XCTAssertEqual(model.audioPlayer.currentSetId, fixture.set.id)
  }

  #if !os(macOS)
    func testAMediaServicesResetWaitsForPlayBeforeReplacingThePlayer() async throws {
      try await assertMediaServicesResetRecovery(paused: false)
    }

    func testAMediaServicesResetKeepsAPausedSetQuiet() async throws {
      try await assertMediaServicesResetRecovery(paused: true)
    }

    @concurrent nonisolated private static func postMediaServicesReset() async {
      NotificationCenter.default.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    private func assertMediaServicesResetRecovery(paused: Bool) async throws {
      let fixture = try await fixture()
      let model = AppModel(client: fixture.client, settings: MemoryClientSettings())
      defer { model.signOut() }
      await model.playSet(fixture.set.id, startAt: 12)
      let player = model.audioPlayer
      player.player?.volume = 0
      try await waitUntil("The stream must play before media services reset") { player.state == .playing }
      if paused { player.pause() }
      let oldEngine = try XCTUnwrap(player.player)
      let position = oldEngine.currentTime().seconds
      await Self.postMediaServicesReset()
      guard case .failed = player.state else {
        XCTFail("A media-services reset must require an explicit Play to recover")
        return
      }
      XCTAssertEqual(oldEngine.rate, 0)
      XCTAssertEqual(player.currentSetId, fixture.set.id)
      XCTAssertEqual(player.elapsed, position, accuracy: 0.3)
      try await Task.sleep(for: .milliseconds(200))
      XCTAssertEqual(oldEngine.rate, 0, "Old callbacks must not resume the invalid player")
      model.togglePlayback()
      try await waitUntil("Play must replace the invalid player and resume") { player.state == .playing }
      let recovered = try XCTUnwrap(player.player)
      XCTAssertFalse(recovered === oldEngine)
      let resumed = recovered.currentTime().seconds
      XCTAssertGreaterThanOrEqual(resumed, position - 0.2)
      XCTAssertLessThan(resumed, position + 2)
      try await waitUntil("The recovered stream must keep advancing") {
        recovered.currentTime().seconds > resumed + 0.3
      }
      try record(
        "media-services-reset-\(paused ? "paused" : "playing")",
        [
          "positionBeforeReset": position, "resumedPosition": resumed, "replacedPlayer": recovered !== oldEngine,
        ])
    }
  #endif

  func testACueOnTheCurrentSetSupersedesADelayedPlayOfAnotherSet() async throws {
    let a = Fixtures.savedSet(title: "Current Set", tags: [], downloadState: "ready")
      .replacingOccurrences(of: "\"id\":\"1\"", with: "\"id\":\"a\"")
    let b = a.replacingOccurrences(of: "\"id\":\"a\"", with: "\"id\":\"b\"")
    let set = try JSONDecoder().decode(SavedSet.self, from: Data(a.utf8))
    let requests = QueueTests.RequestLog()
    let activations = ActivationLog()
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "http://10.255.255.1:9")), token: "token",
        session: StubProtocol.session(
          responder: { request in
            requests.record(request)
            guard request.url?.path() == "/queue/active" else { return (200, "{}") }
            let fields = try? JSONDecoder().decode(
              [String: String].self, from: request.httpBody ?? Data())
            guard let id = fields?["setId"] else { return (400, "{}") }
            activations.record(id)
            return (200, "{\"queue\":{\"activeSetId\":\"\(id)\",\"entries\":[\(a),\(b)]}}")
          },
          holding: { $0.url?.path() == "/queue/active" ? 0.5 : 0 }
        )), settings: MemoryClientSettings())
    defer { model.signOut() }
    model.audioPlayer.play(
      set: set, baseURL: try XCTUnwrap(URL(string: "http://10.255.255.1:9")), token: "token")
    model.audioPlayer.pause()
    let older = Task { await model.playSet("b") }
    try await waitUntil("The older play request must be in flight") {
      requests.all.contains("PUT /queue/active")
    }
    let cue = Cue(
      position: 0, startSeconds: 12, artist: "Artist", title: "Cue", appleMusicId: nil,
      artworkUrl: nil)
    await model.playCue(cue, in: "a")
    await older.value
    try await waitUntil("The shared queue must follow the latest Cue selection") {
      if case .loaded(let queue) = model.queue { return queue.activeSetId == "a" }
      return false
    }
    try record(
      "warm-cue-supersession",
      ["expectedSetId": "a", "actualSetId": model.audioPlayer.currentSetId ?? "none"])
    XCTAssertEqual(
      model.audioPlayer.currentSetId, "a", "The most recent Cue selection must keep control")
    XCTAssertEqual(activations.all, ["b", "a"])
    XCTAssertEqual(model.audioPlayer.elapsed, 12, accuracy: 0.2)
  }

  func testPausingAPendingSelectionDoesNotActivateItAgain() async throws {
    let set = Fixtures.savedSet(title: "Pending Set", tags: [], downloadState: "ready")
    let log = QueueTests.RequestLog()
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "http://10.255.255.1:9")), token: "token",
        session: StubProtocol.session(
          responder: { request in
            log.record(request)
            return (200, "{\"queue\":{\"activeSetId\":\"1\",\"entries\":[\(set)]}}")
          },
          holding: { $0.url?.path() == "/queue/active" ? 0.5 : 0 }
        )), settings: MemoryClientSettings())
    defer { model.signOut() }
    let initial = Task { await model.playSet("1") }
    try await waitUntil("The selection request must be pending") {
      StubProtocol.lastRequest?.url?.path() == "/queue/active"
    }
    model.togglePlayback("1")
    await initial.value
    try await waitUntil("The selected Set must be installed") {
      model.audioPlayer.currentSetId == "1"
    }
    XCTAssertEqual(log.all.filter { $0 == "PUT /queue/active" }.count, 1)
    XCTAssertEqual(model.audioPlayer.state, .paused)
    XCTAssertEqual(model.audioPlayer.player?.rate, 0)
    let report = try playbackReport(model.audioPlayer)
    let activations = report.entries.compactMap { entry -> PlaybackDiagnostics.ActivationEvent? in
      guard case .activation(let activation) = entry.event else { return nil }
      return activation
    }
    XCTAssertEqual(activations.map(\.phase), [.began, .intentChanged, .accepted])
    XCTAssertEqual(Set(activations.map(\.generation)).count, 1)
    XCTAssertEqual(activations.last?.wantsSound, false)
    XCTAssertNotNil(activations.last?.requestDuration.value)
  }
}
