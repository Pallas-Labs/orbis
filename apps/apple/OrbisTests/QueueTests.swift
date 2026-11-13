import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// The Listening Queue is what makes playback shared state: playing makes a Set active on the
/// service, and the queue that comes back is what the app shows. The requests each action makes
/// and the state that follows them are tested in OrbisKit with `swift test`, with no simulator.
/// These tests cover what only the app does with an answer: start and stop the player, ask for
/// Apple Music access, and read the Library again.
@MainActor
final class QueueTests: XCTestCase {
  /// Every request a model made, in order. `StubProtocol` keeps only the last one, and the order
  /// matters to a test that finishes a Set and watches what starts next.
  final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ request: URLRequest) {
      lock.withLock {
        entries.append("\(request.httpMethod ?? "") \(request.url?.path() ?? "")")
      }
    }

    var all: [String] { lock.withLock { entries } }
  }

  private nonisolated static func set(
    id: String,
    position: Int = 0,
    downloadState: String = "ready"
  ) -> String {
    """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=\(id)abcdefg","title":"Set \(id)",
    "source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"\(downloadState)","playlistIds":[],"playbackPositionSeconds":\(position),
    "listenCount":0,"finishCount":0,"lastListenedAt":null}
    """
  }

  private nonisolated static func queueBody(active: String?, entries: [String]) -> String {
    let activeJson = active.map { "\"\($0)\"" } ?? "null"
    return "{\"queue\":{\"activeSetId\":\(activeJson),\"entries\":[\(entries.joined(separator: ","))]}}"
  }

  private nonisolated static func appleMusicSet(id: String) -> String {
    """
    {"id":"\(id)","url":"https://music.apple.com/album/1440818839","title":"Set \(id)",
    "source":"apple-music","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"none","playlistIds":[],"playbackPositionSeconds":0,
    "listenCount":0,"finishCount":0,"lastListenedAt":null}
    """
  }

  /// How many times the model asked for Apple Music access, and the answer it gives.
  final class AccessRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var asked = 0
    var count: Int { lock.withLock { asked } }

    func authorization(answer: AppleMusicAccess) -> AppleMusicAuthorization {
      AppleMusicAuthorization(
        current: { .unknown },
        request: {
          self.lock.withLock { self.asked += 1 }
          return answer
        })
    }
  }

  /// The JSON a request carried, as fields, because `JSONEncoder` decides the order of keys and a
  /// test that compares raw text is testing the encoder rather than the request.
  private func body(_ data: Data?) -> [String: String] {
    guard let data,
      let fields = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else { return [:] }
    return fields
  }

  private func model(
    log: RequestLog? = nil,
    responder: @Sendable @escaping (URLRequest) -> (Int, String)
  ) throws -> AppModel {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(responder: { request in
        log?.record(request)
        return responder(request)
      })
    )
    return AppModel(client: client, settings: MemoryClientSettings())
  }

  private func queue(_ model: AppModel) -> ListeningQueue? {
    guard case .loaded(let loaded) = model.queue else { return nil }
    return loaded
  }

  func testPlayingASetMakesItTheActiveEntry() async throws {
    let model = try model { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("PUT", "/queue/active"):
        return (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
      default:
        return (200, "{}")
      }
    }

    await model.playSet("a")

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/queue/active")
    XCTAssertEqual(body(StubProtocol.lastBody), ["setId": "a"])
    XCTAssertEqual(queue(model)?.activeSetId, "a")
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["a"])
  }

  func testPlayNextIsSentAsAnInsertAfterTheActiveSet() async throws {
    let model = try model { request in
      if request.url?.path() == "/queue/entries" {
        return (
          201,
          Self.queueBody(
            active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }

    await model.playNext("b")

    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/queue/entries")
    XCTAssertEqual(body(StubProtocol.lastBody), ["placement": "next", "setId": "b"])
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["a", "b"])
    XCTAssertEqual(model.queueNotice, "Plays next")
  }

  /// A shuffle whose first Set is from Apple Music asks for access before that Set starts, as
  /// playing the Set by itself does. Refused, the queue is the Playlist's and nothing plays.
  func testShufflingIntoAnAppleMusicSetAsksForAccessFirst() async throws {
    let model = try model { request in
      if request.url?.path() == "/queue/playlist" {
        return (
          200,
          Self.queueBody(active: "am", entries: [Self.appleMusicSet(id: "am"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }
    let requests = AccessRequests()
    model.appleMusicAuthorization = requests.authorization(answer: .refused)

    await model.playPlaylist("closing", shuffled: true)

    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(model.appleMusicAccess, .refused)
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["am", "b"])
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  /// A Set with Retained Audio at the front needs no Apple Music access, so nothing asks.
  func testShufflingIntoASetWithRetainedAudioAsksNothing() async throws {
    let model = try model { request in
      if request.url?.path() == "/queue/playlist" {
        return (200, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.appleMusicSet(id: "am")]))
      }
      return (200, "{}")
    }
    let requests = AccessRequests()
    model.appleMusicAuthorization = requests.authorization(answer: .refused)

    await model.playPlaylist("closing", shuffled: true)

    XCTAssertEqual(requests.count, 0)
    XCTAssertEqual(model.audioPlayer.currentSetId, "a")
  }

  func testAPlaylistWithNothingPlayableStopsPlayback() async throws {
    let model = try model { request in
      if request.url?.path() == "/queue/playlist" {
        return (200, Self.queueBody(active: nil, entries: []))
      }
      return (200, "{}")
    }

    await model.playPlaylist("empty")

    XCTAssertEqual(queue(model)?.activeSetId, nil)
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  func testARefusedQueueActionSaysWhatTheServiceSaid() async throws {
    let model = try model { _ in
      (400, #"{"message":"Only sets with audio can be added to the queue."}"#)
    }

    await model.playNext("d")

    XCTAssertEqual(
      model.setFailure?.message.contains("Only sets with audio can be added to the queue."),
      true)
  }

  func testFinishingASetStartsTheNextEntry() async throws {
    let log = RequestLog()
    let model = try model(log: log) { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("POST", "/queue/completion"):
        return (200, Self.queueBody(active: "b", entries: [Self.set(id: "b")]))
      case ("GET", "/sets"):
        return (200, "{\"sets\":[\(Self.set(id: "b"))]}")
      default:
        return (200, "{}")
      }
    }

    await model.finishedPlaying("a")

    XCTAssertTrue(log.all.contains("POST /queue/completion"))
    XCTAssertTrue(log.all.contains("GET /sets"))
    XCTAssertEqual(queue(model)?.activeSetId, "b")
  }

  /// Answers `/queue/completion` from `answers` in order, and the Library after it, so a test can
  /// say what each try of a completion meets.
  private func finishingModel(log: RequestLog, answers: [(Int, String)]) throws -> AppModel {
    let remaining = Answers(answers)
    let model = try model(log: log) { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("POST", "/queue/completion"):
        return remaining.next()
      case ("GET", "/sets"):
        return (200, "{\"sets\":[\(Self.set(id: "b"))]}")
      default:
        return (200, "{}")
      }
    }
    // The waits of the service's retry schedule, shortened: the order is what is tested.
    model.completionWaits = [.milliseconds(1), .milliseconds(2), .milliseconds(4)]
    return model
  }

  /// Answers handed out one at a time, the last one standing once the rest are used.
  final class Answers: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [(Int, String)]

    init(_ answers: [(Int, String)]) { queue = answers }

    func next() -> (Int, String) {
      lock.withLock { queue.count > 1 ? queue.removeFirst() : queue[0] }
    }
  }

  private var nextQueue: (Int, String) {
    (200, Self.queueBody(active: "b", entries: [Self.set(id: "b")]))
  }

  func testACompletionRefusedWith503IsSentAgainAndTheQueueAdvances() async throws {
    let log = RequestLog()
    let model = try finishingModel(
      log: log, answers: [(503, #"{"message":"Try again."}"#), nextQueue])

    await model.finishedPlaying("a")

    XCTAssertEqual(log.all.filter { $0 == "POST /queue/completion" }.count, 2)
    XCTAssertEqual(queue(model)?.activeSetId, "b")
    XCTAssertEqual(model.audioPlayer.currentSetId, "b")
    XCTAssertNil(model.setFailure)
  }

  func testACompletionThatFailsFourTimesSaysSoAfterTheFourthRequest() async throws {
    let log = RequestLog()
    let failure = (503, #"{"message":"Try again."}"#)
    let model = try finishingModel(
      log: log, answers: [failure, failure, failure, failure, nextQueue])

    await model.finishedPlaying("a")

    XCTAssertEqual(log.all.filter { $0 == "POST /queue/completion" }.count, 4)
    XCTAssertEqual(model.setFailure?.message.contains("Try again."), true)
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  func testACompletionRefusedWith404IsSentOnce() async throws {
    let log = RequestLog()
    let model = try finishingModel(
      log: log, answers: [(404, #"{"message":"No such set."}"#), nextQueue])

    await model.finishedPlaying("a")

    XCTAssertEqual(log.all.filter { $0 == "POST /queue/completion" }.count, 1)
    XCTAssertEqual(model.setFailure?.message.contains("No such set."), true)
  }

  func testAnEmptyQueueAfterAFinishLeavesNothingPlaying() async throws {
    let model = try model { request in
      if request.url?.path() == "/queue/completion" {
        return (200, Self.queueBody(active: nil, entries: []))
      }
      if request.url?.path() == "/sets" {
        return (200, #"{"sets":[]}"#)
      }
      return (200, "{}")
    }

    await model.finishedPlaying("a")

    XCTAssertNil(queue(model)?.activeSetId)
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  func testTheQueueIsReadAgainWhenASetIsRemoved() async throws {
    let log = RequestLog()
    let model = try model(log: log) { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("DELETE", "/sets/a"):
        return (200, Self.set(id: "a"))
      case ("GET", "/queue"):
        return (200, Self.queueBody(active: nil, entries: [Self.set(id: "b")]))
      default:
        return (200, "{}")
      }
    }

    await model.remove("a")

    XCTAssertEqual(log.all, ["DELETE /sets/a", "GET /queue"])
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["b"])
  }

  func testSigningOutClearsTheQueue() async throws {
    let model = try model { _ in (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")])) }
    await model.loadQueue()
    XCTAssertEqual(queue(model)?.activeSetId, "a")

    model.signOut()

    XCTAssertNil(queue(model))
    if case .idle = model.queue {
    } else {
      XCTFail("the queue belonged to the service that was forgotten")
    }
    XCTAssertNil(model.queueNotice)
  }
}
