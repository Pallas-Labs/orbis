import AVFoundation
import MediaPlayer
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// Audio downloads and streaming, end to end at the seams: the client speaks the four
/// audio routes, the model carries download state into the library, and the player
/// builds an authenticated asset and publishes Now Playing without ever playing
/// network audio inside a test.
@MainActor
final class AudioDownloadTests: XCTestCase {
  /// Pure string builders, callable from the stub responder's nonisolated closure.
  nonisolated private static func setJSON(
    id: String, state: String, tracklist: String = "none"
  ) -> String {
    """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=abcdefghijk",
    "title":"Seeded set","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z",
    "creator":null,"artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"\(state)","tracklistState":"\(tracklist)","playlistIds":[],
    "playbackPositionSeconds":0,"listenCount":0,"finishCount":0,"lastListenedAt":null}
    """
  }

  /// Runs the model's waits `scale` times faster than they ask, so a ten-minute timeline takes a
  /// second. `elapsed` is the time the model believes has passed.
  final class FastClock: Sendable {
    let scale: Double
    private let start = ContinuousClock.now

    init(scale: Double) { self.scale = scale }

    var elapsed: Duration { (ContinuousClock.now - start) * scale }

    func sleep(_ duration: Duration) async throws {
      try await Task.sleep(for: duration / scale)
    }
  }

  /// Set when a task the test started has returned.
  @MainActor final class Flag {
    var value = false
  }

  /// Every request a model made, with the time on its clock when the request went out.
  final class TimedRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(request: String, at: Duration)] = []
    private let clock: FastClock

    init(clock: FastClock) { self.clock = clock }

    /// Records the request and says how many requests went to its path before it.
    @discardableResult
    func record(_ request: URLRequest) -> Int {
      let entry = "\(request.httpMethod ?? "") \(request.url?.path() ?? "")"
      let at = clock.elapsed
      return lock.withLock {
        defer { entries.append((entry, at)) }
        return entries.count(where: { $0.request == entry })
      }
    }

    /// The times of the requests whose method and path end with `suffix`, such as `/audio/state`
    /// or `GET /sets`.
    func times(endingWith suffix: String) -> [Duration] {
      lock.withLock { entries.filter { $0.request.hasSuffix(suffix) }.map(\.at) }
    }
  }

  nonisolated private static func libraryJSON(state: String) -> String {
    "{\"sets\":[\(setJSON(id: "1", state: state))]}"
  }

  private func client() throws -> OrbisClient {
    OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(responder: { request in
        switch (request.httpMethod, request.url?.path()) {
        case ("POST", "/sets/1/audio/download"):
          (202, Self.setJSON(id: "1", state: "queued"))
        case ("GET", "/sets/1/audio/state"):
          (
            200,
            "{\"state\":\"downloading\",\"bytesReceived\":10,\"bytesTotal\":100,\"format\":null}"
          )
        case ("DELETE", "/sets/1/audio/download"):
          (200, Self.setJSON(id: "1", state: "none"))
        default:
          (404, "{\"message\":\"Set not found.\"}")
        }
      })
    )
  }

  func testCancelDownloadDecodesSet() async throws {
    let updated = try await client().cancelAudioDownload("1")
    XCTAssertEqual(updated.downloadState, "none")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "DELETE")
  }

  func testDownloadUpdatesLibraryState() async throws {
    let model = AppModel(
      client: try client(), settings: MemoryClientSettings()
    )
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self,
        from: Data(Self.setJSON(id: "1", state: "none").utf8)
      )
    ])
    await model.downloadAudio("1")
    XCTAssertEqual(model.savedSet("1")?.downloadState, "queued")
    XCTAssertNil(model.setFailure)
  }

  func testFailedDownloadSurfacesPageFailure() async throws {
    let failing = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(status: 500, body: "{}")
    )
    let model = AppModel(client: failing, settings: MemoryClientSettings())
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self,
        from: Data(Self.setJSON(id: "1", state: "none").utf8)
      )
    ])
    await model.downloadAudio("1")
    XCTAssertNotNil(model.setFailure)
    XCTAssertEqual(model.savedSet("1")?.downloadState, "none")
  }

  func testRefreshStoresProgressAndReloadsOnTerminal() async throws {
    func modelForResponder(
      _ responder: @Sendable @escaping (URLRequest) -> (Int, String)
    ) throws -> AppModel {
      let client = OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(responder: responder)
      )
      let model = AppModel(client: client, settings: MemoryClientSettings())
      model.library = .loaded([
        try JSONDecoder().decode(
          SavedSet.self,
          from: Data(Self.setJSON(id: "1", state: "downloading").utf8)
        )
      ])
      return model
    }
    let running = try modelForResponder { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("GET", "/sets/1/audio/state"):
        (
          200,
          "{\"state\":\"downloading\",\"bytesReceived\":10,\"bytesTotal\":100,\"format\":null}"
        )
      case ("GET", "/sets"):
        (200, Self.libraryJSON(state: "downloading"))
      default:
        (404, "{\"message\":\"Set not found.\"}")
      }
    }
    await running.refreshAudioState("1")
    XCTAssertEqual(running.audioStates["1"]?.bytesReceived, 10)
    XCTAssertEqual(running.savedSet("1")?.downloadState, "downloading")
    let finished = try modelForResponder { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("GET", "/sets/1/audio/state"):
        (
          200,
          "{\"state\":\"ready\",\"bytesReceived\":99,\"bytesTotal\":99,\"format\":\"mp3\"}"
        )
      case ("GET", "/sets"):
        (200, Self.libraryJSON(state: "ready"))
      default:
        (404, "{\"message\":\"Set not found.\"}")
      }
    }
    await finished.refreshAudioState("1")
    XCTAssertNil(finished.audioStates["1"])
    XCTAssertEqual(finished.savedSet("1")?.downloadState, "ready")
  }

  func testPlayerAssetCarriesBearerToken() {
    let options = AudioPlayer.assetOptions(token: "secret-token")
    let fields = options[AudioPlayer.assetHeaderFieldsKey] as? [String: String]
    XCTAssertEqual(fields?["Authorization"], "Bearer secret-token")
  }

  func testPlayerBuildsFileURLFromSetID() throws {
    // The player once loaded the service root, which answers 404, instead of the
    // Set's file: this pins the exact URL play() hands the asset, with and
    // without a trailing slash on the service address.
    for base in [
      "https://orbis.example.test:8444", "https://orbis.example.test:8444/",
    ] {
      XCTAssertEqual(
        AudioPlayer.fileURL(setID: "1", baseURL: try XCTUnwrap(URL(string: base))).absoluteString,
        "https://orbis.example.test:8444/sets/1/audio"
      )
    }
  }

  func testNowPlayingInfoHasTitleDurationAndRate() {
    let playing = AudioPlayer.nowPlayingInfo(
      title: "Seeded set", duration: 5400, elapsed: 12, isPlaying: true
    )
    XCTAssertEqual(playing[MPMediaItemPropertyTitle] as? String, "Seeded set")
    XCTAssertEqual(
      playing[MPMediaItemPropertyPlaybackDuration] as? TimeInterval, 5400
    )
    XCTAssertEqual(
      playing[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? TimeInterval, 12
    )
    XCTAssertEqual(playing[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1.0)
    let paused = AudioPlayer.nowPlayingInfo(
      title: "Seeded set", duration: nil, elapsed: 12, isPlaying: false
    )
    XCTAssertEqual(paused[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0.0)
    XCTAssertNil(paused[MPMediaItemPropertyPlaybackDuration])
  }

  func testLetterboxedThumbnailsAreCroppedToTheirPicture() throws {
    let letterboxed = try XCTUnwrap(solidImage(width: 480, height: 360))
    let cropped = AudioPlayer.widescreen(letterboxed)
    XCTAssertEqual(cropped.width, 480)
    XCTAssertEqual(cropped.height, 270, "a 4:3 frame keeps its middle 16:9 band")

    let widescreen = try XCTUnwrap(solidImage(width: 1280, height: 720))
    XCTAssertEqual(AudioPlayer.widescreen(widescreen).height, 720, "16:9 is left alone")
    let wider = try XCTUnwrap(solidImage(width: 1000, height: 400))
    XCTAssertEqual(AudioPlayer.widescreen(wider).height, 400, "wider than 16:9 is left alone")
  }

  private func solidImage(width: Int, height: Int) -> CGImage? {
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    context?.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context?.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context?.makeImage()
  }

  func testRemoteCommandsRegisteredAndEnabled() {
    do {
      // The player keeps its command targets alive; leaving the scope tears them
      // down again so no test leaks a handler into the next one.
      let player = AudioPlayer()
      _ = player
      XCTAssertTrue(MPRemoteCommandCenter.shared().playCommand.isEnabled)
      XCTAssertTrue(MPRemoteCommandCenter.shared().pauseCommand.isEnabled)
    }
    XCTAssertFalse(MPRemoteCommandCenter.shared().playCommand.isEnabled)
    XCTAssertFalse(MPRemoteCommandCenter.shared().pauseCommand.isEnabled)
  }

  /// A download is watched by the model rather than by the page that asked for it, so a download
  /// that the service finishes while the person is somewhere else still lands in the Library.
  /// Nothing here polls the page: this is the watch doing the work on its own.
  func testADownloadThatFinishesElsewhereStillLandsInTheLibrary() async throws {
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(responder: { request in
          switch (request.httpMethod, request.url?.path()) {
          case ("POST", "/sets/1/audio/download"):
            (202, Self.setJSON(id: "1", state: "queued"))
          case ("GET", "/sets/1/audio/state"):
            (200, "{\"state\":\"ready\",\"bytesReceived\":99,\"bytesTotal\":99,\"format\":\"mp3\"}")
          case ("GET", "/sets"):
            (200, Self.libraryJSON(state: "ready"))
          default:
            (404, "{\"message\":\"Set not found.\"}")
          }
        })
      ), settings: MemoryClientSettings())
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self, from: Data(Self.setJSON(id: "1", state: "none").utf8))
    ])

    await model.downloadAudio("1")

    var waited = 0
    while model.savedSet("1")?.downloadState != "ready", waited < 200 {
      try await Task.sleep(for: .milliseconds(20))
      waited += 1
    }
    XCTAssertEqual(
      model.savedSet("1")?.downloadState, "ready",
      "the watch must land a finished download in the Library without the page asking again")
    XCTAssertNil(model.audioStates["1"], "a finished download holds no running progress")
  }

  /// A playlist import queues fifteen Sets while no node is connected, and no Set page is open.
  /// Nothing on screen shows their progress, so the app may only check the Library now and then
  /// for a download that ends. Before this was fixed, each Set was asked about every second.
  func testQueuedSetsWithNoPageOpenCostAFewRequestsAMinute() async throws {
    let clock = FastClock(scale: 600)
    let log = TimedRequestLog(clock: clock)
    let ids = (1...15).map(String.init)
    let sets = ids.map { Self.setJSON(id: $0, state: "queued", tracklist: "pending") }
    let library = "{\"sets\":[" + sets.joined(separator: ",") + "]}"
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(responder: { request in
          log.record(request)
          return switch (request.httpMethod, request.url?.path()) {
          case ("GET", "/sets"):
            (200, library)
          case ("GET", let path?) where path.hasSuffix("/audio/state"):
            (200, "{\"state\":\"queued\",\"bytesReceived\":0,\"bytesTotal\":null,\"format\":null}")
          case ("GET", let path?) where path.hasSuffix("/tracklist"):
            (200, "{\"state\":\"pending\",\"cues\":[]}")
          default:
            (404, "{\"message\":\"Set not found.\"}")
          }
        })
      ), settings: MemoryClientSettings())
    model.sleep = { try await clock.sleep($0) }

    await model.loadLibrary()
    // Ten minutes on the model's clock.
    try await Task.sleep(for: .seconds(1.05))
    model.signOut()
    let atSignOut = clock.elapsed

    let polls = ["/audio/state", "/tracklist", "GET /sets"].flatMap { log.times(endingWith: $0) }
    let minutes = (1..<10).map { minute in
      polls.filter { $0 >= .seconds(60 * minute) && $0 < .seconds(60 * (minute + 1)) }.count
    }
    XCTAssertLessThanOrEqual(
      minutes.max() ?? 0, 6,
      "after the first minute, at most 6 requests a minute in total; each minute: \(minutes)")

    // Two more minutes after sign-out. A request already on its way may still land, but no
    // watch starts another.
    try await Task.sleep(for: .seconds(0.2))
    let late = ["/audio/state", "/tracklist", "GET /sets"]
      .flatMap { log.times(endingWith: $0) }
      .filter { $0 > atSignOut + .seconds(30) }
    XCTAssertEqual(late, [], "sign-out ends every watch")
  }

  /// An open Set page shows its download moving: while the bytes grow, each answer lands within
  /// two seconds of the last. Once the page closes, nothing asks about that Set again.
  func testAnOpenPageFollowsItsDownloadUntilItCloses() async throws {
    let clock = FastClock(scale: 5)
    let log = TimedRequestLog(clock: clock)
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(responder: { request in
          switch (request.httpMethod, request.url?.path()) {
          case ("GET", "/sets/1/audio/state"):
            let received = 10 * (log.record(request) + 1)
            return (
              200,
              "{\"state\":\"downloading\",\"bytesReceived\":\(received),\"bytesTotal\":1000,\"format\":null}"
            )
          case ("GET", "/sets"):
            return (200, Self.libraryJSON(state: "downloading"))
          default:
            return (404, "{\"message\":\"Set not found.\"}")
          }
        })
      ), settings: MemoryClientSettings())
    model.sleep = { try await clock.sleep($0) }
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self, from: Data(Self.setJSON(id: "1", state: "downloading").utf8))
    ])

    let page = Task { await model.followDownload("1") }
    var changes: [Duration] = []
    var shown: AudioState?
    let deadline = ContinuousClock.now + .seconds(10)
    while changes.count < 8, ContinuousClock.now < deadline {
      if let live = model.audioStates["1"], live != shown {
        shown = live
        changes.append(clock.elapsed)
      }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(changes.count, 8, "the open page sees the bytes grow")
    let gaps = zip(changes, changes.dropFirst()).map { $1 - $0 }
    XCTAssertLessThanOrEqual(
      gaps.max() ?? .zero, .seconds(2), "the progress moves at least every 2 s: \(gaps)")

    page.cancel()
    await page.value
    XCTAssertNil(model.audioStates["1"], "a closed page leaves no progress behind")
    let atClose = log.times(endingWith: "/sets/1/audio/state").count
    // Ten more seconds on the model's clock, ten times the wait between two reads that move.
    try await Task.sleep(for: .seconds(2))
    XCTAssertEqual(
      log.times(endingWith: "/sets/1/audio/state").count, atClose,
      "a closed page asks nothing more about its Set")
  }

  /// Another device cancels a download this page follows. The service then answers `none`, or
  /// the legacy `canceled`, while the cached library still holds the Set as `downloading`. That
  /// read ends the download here: the library reloads, the progress clears, and the page stops
  /// following on that read, with no wait for the library watch. Every wait in this model lasts an
  /// hour, so only a read that ends the download itself lets the page return.
  func testACancelFromAnotherDeviceEndsTheOpenPageOnTheNextRead() async throws {
    for live in ["none", "canceled"] {
      let clock = FastClock(scale: 1)
      let log = TimedRequestLog(clock: clock)
      let model = AppModel(
        client: OrbisClient(
          address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
          token: "token",
          session: StubProtocol.session(responder: { request in
            log.record(request)
            switch (request.httpMethod, request.url?.path()) {
            case ("GET", "/sets/1/audio/state"):
              return (
                200,
                "{\"state\":\"\(live)\",\"bytesReceived\":0,\"bytesTotal\":null,\"format\":null}"
              )
            case ("GET", "/sets"):
              return (200, Self.libraryJSON(state: live))
            default:
              return (404, "{\"message\":\"Set not found.\"}")
            }
          })
        ), settings: MemoryClientSettings())
      model.sleep = { _ in try await Task.sleep(for: .seconds(3600)) }
      model.library = .loaded([
        try JSONDecoder().decode(
          SavedSet.self, from: Data(Self.setJSON(id: "1", state: "downloading").utf8))
      ])

      let ended = Flag()
      let page = Task {
        await model.followDownload("1")
        ended.value = true
      }
      let deadline = ContinuousClock.now + .seconds(2)
      while !ended.value, ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(5))
      }
      XCTAssertTrue(ended.value, "\(live): the page stops following on the read")
      XCTAssertEqual(model.savedSet("1")?.downloadState, live, "\(live): the library reloads")
      XCTAssertNil(model.audioStates["1"], "\(live): the progress clears")
      XCTAssertEqual(
        log.times(endingWith: "/sets/1/audio/state").count, 1,
        "\(live): one read ends the download")
      XCTAssertEqual(log.times(endingWith: "GET /sets").count, 1, "\(live): one library read")
      page.cancel()
      await page.value
      model.signOut()
    }
  }

  /// A pending Tracklist is read while a screen shows it, less often while the answer stays the
  /// same, and not at all once no screen asks for it.
  func testAPendingTracklistIsReadOnlyWhileAScreenWantsIt() async throws {
    let clock = FastClock(scale: 60)
    let log = TimedRequestLog(clock: clock)
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(responder: { request in
          log.record(request)
          return (200, "{\"state\":\"pending\",\"cues\":[]}")
        })
      ), settings: MemoryClientSettings())
    model.sleep = { try await clock.sleep($0) }

    let screen = Task { await model.loadTracklist("1") }
    // Five minutes on the model's clock.
    try await Task.sleep(for: .seconds(5))
    let whileOpen = log.times(endingWith: "/sets/1/tracklist").count
    XCTAssertGreaterThan(whileOpen, 1, "an open screen keeps reading a pending Tracklist")
    XCTAssertLessThanOrEqual(
      whileOpen, 20, "a pending answer that does not change is read less and less often")

    screen.cancel()
    await screen.value
    let atClose = log.times(endingWith: "/sets/1/tracklist").count
    // Two more minutes, longer than the longest wait between reads.
    try await Task.sleep(for: .seconds(2))
    XCTAssertEqual(
      log.times(endingWith: "/sets/1/tracklist").count, atClose,
      "no screen asks for the Tracklist, so no read goes out")
  }
}
