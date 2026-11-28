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

  // MARK: - Resuming after another device saved (PAL-2130)

  // The fixture's audio is 30 s long, and a place within 5 s of the end starts the Set over, so
  // these tests pause early and the other device saves at most 18 s.

  /// Holds one answer from the service, for a forward that waits on another thread.
  private final class Forwarded: @unchecked Sendable {
    private let lock = NSLock()
    private var answer = (502, "")
    func set(_ value: (Int, String)) { lock.withLock { answer = value } }
    var value: (Int, String) { lock.withLock { answer } }
  }

  /// Holds the first Listening Queue read until the test releases it, and counts the reads that
  /// started and finished.
  private final class QueueReadGate: @unchecked Sendable {
    private let lock = NSLock()
    private let gate = DispatchSemaphore(value: 0)
    private var counts = (started: 0, finished: 0)
    var started: Int { lock.withLock { counts.started } }
    var finished: Int { lock.withLock { counts.finished } }
    /// Answers true for the first read, which waits for `release()`.
    func begin() -> Bool {
      lock.withLock {
        counts.started += 1
        return counts.started == 1
      }
    }
    func wait() { gate.wait() }
    func end() { lock.withLock { counts.finished += 1 } }
    func release() { gate.signal() }
  }

  /// Sends one request on to the real service and answers what it said.
  nonisolated private static func forward(_ request: URLRequest) -> (Int, String) {
    let forwarded = Forwarded()
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, _ in
      forwarded.set(
        (
          (response as? HTTPURLResponse)?.statusCode ?? 502,
          String(decoding: data ?? Data(), as: UTF8.self)
        ))
      done.signal()
    }.resume()
    done.wait()
    return forwarded.value
  }

  /// Loses the answer to each Playback Position report while told to: the report reaches the
  /// service, and the app hears a 503. Records the seconds of each lost report, and the stored
  /// seconds of each answer the app hears.
  private final class PositionAnswers: @unchecked Sendable {
    private let lock = NSLock()
    private var losing = false
    private var lostSeconds: [Int] = []
    private var heardSeconds: [Int] = []
    func lose(_ value: Bool) { lock.withLock { losing = value } }
    var lost: [Int] { lock.withLock { lostSeconds } }
    var heard: [Int] { lock.withLock { heardSeconds } }
    /// Answers true when this report's answer is to be lost.
    func record(seconds: Int?, stored: Int?) -> Bool {
      lock.withLock {
        if losing {
          if let seconds { lostSeconds.append(seconds) }
          return true
        }
        if let stored { heardSeconds.append(stored) }
        return false
      }
    }
  }

  nonisolated private static func isPositionReport(_ request: URLRequest) -> Bool {
    request.httpMethod == "PUT" && request.url?.path().hasSuffix("/position") == true
  }

  nonisolated private static func seconds(in data: Data?) -> Int? {
    guard let data,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return (object["seconds"] ?? object["playbackPositionSeconds"]) as? Int
  }

  /// A session that sends each request on to the real service, and loses the answers to Playback
  /// Position reports while `answers` is told to.
  private static func sessionLosingPositionAnswers(_ answers: PositionAnswers) -> URLSession {
    StubProtocol.session(responder: { request in
      let forwarded = forward(request)
      guard isPositionReport(request) else { return forwarded }
      let lost = answers.record(
        seconds: seconds(in: request.httpBody), stored: seconds(in: Data(forwarded.1.utf8)))
      return lost ? (503, "{}") : forwarded
    })
  }

  nonisolated private static func isQueueRead(_ request: URLRequest) -> Bool {
    request.httpMethod == "GET" && request.url?.path() == "/queue"
  }

  /// A session that sends each request on to the real service, except the Listening Queue read,
  /// which fails. The audio itself streams through AVPlayer, outside this session.
  private static func sessionFailingTheQueueRead() -> URLSession {
    StubProtocol.session(responder: { request in
      isQueueRead(request) ? (500, "{}") : forward(request)
    })
  }

  /// A session that sends each request on to the real service, and holds the first Listening
  /// Queue read at `gate` before it sends it, so the read answers what the service holds then.
  private static func sessionHoldingTheFirstQueueRead(_ gate: QueueReadGate) -> URLSession {
    StubProtocol.session(responder: { request in
      guard isQueueRead(request) else { return forward(request) }
      if gate.begin() { gate.wait() }
      defer { gate.end() }
      return forward(request)
    })
  }

  private func servicePosition(_ fixture: Fixture) async throws -> Int {
    let library = try await fixture.client.library()
    return try XCTUnwrap(library.first { $0.id == fixture.set.id }).playbackPositionSeconds
  }

  /// Polls the service until its position for the Set passes `check`, for up to 15 s, and
  /// answers the last position read.
  @discardableResult
  private func waitForService(
    _ fixture: Fixture, _ message: String, _ check: (Int) -> Bool
  ) async throws -> Int {
    let deadline = ContinuousClock.now + .seconds(15)
    var seconds = try await servicePosition(fixture)
    while !check(seconds), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(200))
      seconds = try await servicePosition(fixture)
    }
    XCTAssertTrue(check(seconds), "\(message): the service holds \(seconds) s")
    return seconds
  }

  /// Plays the fixture's Set through the model, silent.
  private func start(_ model: AppModel, _ fixture: Fixture) async throws {
    await model.playSet(fixture.set.id)
    try await waitUntil("The Set must play") {
      model.audioPlayer.state == .playing && (model.audioPlayer.player?.currentTime().seconds ?? 0) > 0.3
    }
    model.audioPlayer.player?.volume = 0
  }

  /// Moves the playing Set to `seconds`, pauses it with the mini player's button, and waits until
  /// the service holds the paused place. Answers that place.
  private func pause(
    _ model: AppModel, at seconds: TimeInterval, _ fixture: Fixture
  ) async throws -> Int {
    model.audioPlayer.seek(to: seconds)
    try await waitUntil("The seek to \(seconds) s must land") {
      model.audioPlayer.settledPosition.map { $0 >= seconds && $0 < seconds + 1 } ?? false
    }
    model.togglePlayback()
    try await waitUntil("The Set must pause") { model.audioPlayer.state == .paused }
    let paused = Int(try XCTUnwrap(model.audioPlayer.settledPosition).rounded())
    return try await waitForService(fixture, "The pause must reach the service") {
      abs($0 - paused) <= 1
    }
  }

  /// Waits until the resumed Set plays half a second past its pause, and answers where it plays.
  private func resumed(_ model: AppModel, after paused: Int) async throws -> TimeInterval {
    try await waitUntil("The Set must play again") {
      model.audioPlayer.state == .playing
        && (model.audioPlayer.player?.currentTime().seconds ?? 0) > Double(paused) + 0.5
    }
    return try XCTUnwrap(model.audioPlayer.player?.currentTime().seconds)
  }

  /// The mini player's button and Play on the Set in the player both resume where another device
  /// saved since the pause, and this device's next report keeps that place.
  func testAResumeFollowsAPlaceAnotherDeviceSavedLater() async throws {
    let fixture = try await fixture()
    let model = AppModel(client: fixture.client, settings: MemoryClientSettings())
    defer { model.signOut() }
    let otherDevice = OrbisClient(address: fixture.client.address, token: fixture.client.token)
    try await start(model, fixture)

    let togglePause = try await pause(model, at: 3, fixture)
    _ = try await otherDevice.reportPosition(fixture.set.id, seconds: 15)
    model.togglePlayback()
    let toggled = try await resumed(model, after: togglePause)
    XCTAssertGreaterThanOrEqual(toggled, 15, "togglePlayback resumed at its own pause")
    XCTAssertLessThan(toggled, 18)
    let afterToggle = try await waitForService(fixture, "The next report must keep 15 s") {
      $0 >= 15
    }

    let playPause = try await pause(model, at: 5, fixture)
    _ = try await otherDevice.reportPosition(fixture.set.id, seconds: 18)
    await model.playSet(fixture.set.id)
    let played = try await resumed(model, after: playPause)
    XCTAssertGreaterThanOrEqual(played, 18, "playSet resumed at its own pause")
    XCTAssertLessThan(played, 21)
    let afterPlay = try await waitForService(fixture, "The next report must keep 18 s") {
      $0 >= 18
    }
    try record(
      "resume-follows-other-device",
      [
        "togglePlayback": [
          "pausedAt": togglePause, "otherDevice": 15, "resumedAt": toggled,
          "serviceAfterNextReport": afterToggle,
        ] as [String: Any],
        "playSet": [
          "pausedAt": playPause, "otherDevice": 18, "resumedAt": played,
          "serviceAfterNextReport": afterPlay,
        ] as [String: Any],
      ])
  }

  /// With no save from another device, both paths resume where this device paused.
  func testAResumeWithNoOtherSavePlaysFromItsOwnPause() async throws {
    let fixture = try await fixture()
    let model = AppModel(client: fixture.client, settings: MemoryClientSettings())
    defer { model.signOut() }
    try await start(model, fixture)

    let togglePause = try await pause(model, at: 6, fixture)
    model.togglePlayback()
    let toggled = try await resumed(model, after: togglePause)
    XCTAssertLessThan(toggled, Double(togglePause) + 3)

    let playPause = try await pause(model, at: 9, fixture)
    await model.playSet(fixture.set.id)
    let played = try await resumed(model, after: playPause)
    XCTAssertLessThan(played, Double(playPause) + 3)
    try record(
      "resume-own-pause",
      [
        "togglePlayback": ["pausedAt": togglePause, "resumedAt": toggled] as [String: Any],
        "playSet": ["pausedAt": playPause, "resumedAt": played] as [String: Any],
      ])
  }

  /// When the position read fails, the Set still plays, from where this device paused.
  func testAResumeWhoseReadFailsPlaysFromItsOwnPlace() async throws {
    let fixture = try await fixture()
    let client = OrbisClient(
      address: fixture.client.address, token: fixture.client.token,
      session: Self.sessionFailingTheQueueRead())
    let model = AppModel(client: client, settings: MemoryClientSettings())
    defer { model.signOut() }
    try await start(model, fixture)

    let togglePause = try await pause(model, at: 4, fixture)
    _ = try await fixture.client.reportPosition(fixture.set.id, seconds: 15)
    model.togglePlayback()
    let toggled = try await resumed(model, after: togglePause)
    XCTAssertLessThan(toggled, Double(togglePause) + 3)

    let playPause = try await pause(model, at: 7, fixture)
    _ = try await fixture.client.reportPosition(fixture.set.id, seconds: 18)
    await model.playSet(fixture.set.id)
    let played = try await resumed(model, after: playPause)
    XCTAssertLessThan(played, Double(playPause) + 3)
    try record(
      "resume-read-failed",
      [
        "togglePlayback": ["pausedAt": togglePause, "otherDevice": 15, "resumedAt": toggled] as [String: Any],
        "playSet": ["pausedAt": playPause, "otherDevice": 18, "resumedAt": played] as [String: Any],
      ])
  }

  /// The pause's report reaches the service, but its answer is lost, so this device does not know
  /// what the service holds. The report goes again once the service answers, so this device hears
  /// the pause. Another device then saves the place this device last heard before the loss: only
  /// a device that heard the resent pause sees that save as newer, and resumes there (PAL-3192).
  func testAPauseWhoseAnswerIsLostIsSentAgain() async throws {
    let fixture = try await fixture()
    let answers = PositionAnswers()
    let client = OrbisClient(
      address: fixture.client.address, token: fixture.client.token,
      session: Self.sessionLosingPositionAnswers(answers))
    let model = AppModel(client: client, settings: MemoryClientSettings())
    defer { model.signOut() }
    let otherDevice = OrbisClient(address: fixture.client.address, token: fixture.client.token)
    try await start(model, fixture)

    model.audioPlayer.seek(to: 3)
    try await waitUntil("A report must be heard") { !answers.heard.isEmpty }
    answers.lose(true)
    let heard = try XCTUnwrap(answers.heard.last)
    model.audioPlayer.seek(to: 14)
    try await waitUntil("The seek to 14 s must land") {
      model.audioPlayer.settledPosition.map { $0 >= 14 && $0 < 15 } ?? false
    }
    model.togglePlayback()
    try await waitUntil("The Set must pause") { model.audioPlayer.state == .paused }
    let paused = Int(try XCTUnwrap(model.audioPlayer.settledPosition).rounded(.down))
    try await waitUntil("The pause must reach the service unheard") {
      answers.lost.contains(paused)
    }
    XCTAssertNotEqual(heard, paused)
    let heardBeforeAnswering = answers.heard.count
    answers.lose(false)
    try await waitUntil("The pause must be sent again and heard") {
      answers.heard.dropFirst(heardBeforeAnswering).contains(paused)
    }

    _ = try await otherDevice.reportPosition(fixture.set.id, seconds: heard)
    model.togglePlayback()
    try await waitUntil("The Set must resume at the other device's \(heard) s") {
      let at = model.audioPlayer.player?.currentTime().seconds ?? 0
      return model.audioPlayer.state == .playing && at >= Double(heard) && at < Double(heard) + 3
    }
    let resumedAt = try XCTUnwrap(model.audioPlayer.player?.currentTime().seconds)
    try record(
      "pause-answer-lost",
      [
        "heardBeforeLoss": heard, "pausedAt": paused, "lost": answers.lost,
        "heard": answers.heard, "otherDevice": heard, "resumedAt": resumedAt,
      ])
  }

  /// A pause while the resume's read is out drops that resume. The read's answer then changes
  /// nothing, so the next resume still finds the place another device saved, and this device's
  /// next report keeps it.
  func testAResumeDroppedByAPauseLeavesTheNewerPlaceForTheNextResume() async throws {
    let fixture = try await fixture()
    let gate = QueueReadGate()
    let client = OrbisClient(
      address: fixture.client.address, token: fixture.client.token,
      session: Self.sessionHoldingTheFirstQueueRead(gate))
    let model = AppModel(client: client, settings: MemoryClientSettings())
    defer {
      gate.release()
      model.signOut()
    }
    try await start(model, fixture)

    let paused = try await pause(model, at: 5, fixture)
    _ = try await fixture.client.reportPosition(fixture.set.id, seconds: 18)
    model.togglePlayback()
    try await waitUntil("The resume must read the queue") { gate.started == 1 }
    model.togglePlayback()
    try await waitUntil("The second press must pause") { model.audioPlayer.state == .paused }
    gate.release()
    try await waitUntil("The dropped read must answer") { gate.finished == 1 }
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(model.audioPlayer.state, .paused, "The dropped read must not play the Set")
    let stillPaused = try XCTUnwrap(model.audioPlayer.player?.currentTime().seconds)
    XCTAssertLessThan(stillPaused, Double(paused) + 1, "The dropped read must not move the Set")

    model.togglePlayback()
    let played = try await resumed(model, after: paused)
    XCTAssertGreaterThanOrEqual(played, 18, "The next resume played from its own pause")
    XCTAssertLessThan(played, 21)
    let after = try await waitForService(fixture, "The next report must keep 18 s") { $0 >= 18 }
    try record(
      "resume-dropped-by-pause",
      [
        "pausedAt": paused, "otherDevice": 18, "afterDroppedRead": stillPaused,
        "resumedAt": played, "serviceAfterNextReport": after,
      ])
  }
}
