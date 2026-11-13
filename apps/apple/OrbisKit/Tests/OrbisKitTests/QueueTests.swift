import Foundation
import OrbisKitTesting
import XCTest

@testable import OrbisKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The Listening Queue is what makes playback shared state: playing makes a Set active on the
/// service, and the queue that comes back is what the app shows. These tests assert the request
/// each action makes and the state that follows it, with no player and no simulator.
@MainActor
final class QueueTests: XCTestCase {
  /// Every request a store made, in order. `StubProtocol` keeps only the last one, and the order
  /// matters to a test that finishes a Set and watches what starts next.
  final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ request: URLRequest) {
      lock.withLock {
        entries.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
      }
    }

    var all: [String] { lock.withLock { entries } }
  }

  private nonisolated static func set(id: String, position: Int = 0) -> String {
    """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=\(id)abcdefg","title":"Set \(id)",
    "source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"ready","playlistIds":[],"playbackPositionSeconds":\(position),
    "listenCount":0,"finishCount":0,"lastListenedAt":null}
    """
  }

  private nonisolated static func queueBody(active: String?, entries: [String]) -> String {
    let activeJson = active.map { "\"\($0)\"" } ?? "null"
    return "{\"queue\":{\"activeSetId\":\(activeJson),\"entries\":[\(entries.joined(separator: ","))]}}"
  }

  /// The JSON a request carried, as fields, because `JSONEncoder` decides the order of keys and a
  /// test that compares raw text is testing the encoder rather than the request.
  private func body(_ data: Data?) -> [String: String] {
    guard let data,
      let fields = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else { return [:] }
    return fields
  }

  private func client(
    log: RequestLog? = nil,
    responder: @Sendable @escaping (URLRequest) -> (Int, String)
  ) throws -> OrbisClient {
    OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(responder: { request in
        log?.record(request)
        return responder(request)
      }))
  }

  private let signedIn: @MainActor () -> String? = { "token" }

  private func loaded(_ store: ListeningQueueStore) -> ListeningQueue? {
    guard case .loaded(let queue) = store.state else { return nil }
    return queue
  }

  func testPlayingASetMakesItTheActiveEntry() async throws {
    let client = try client { request in
      switch (request.httpMethod, request.url?.path) {
      case ("PUT", "/queue/active"):
        return (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
      default:
        return (200, "{}")
      }
    }
    let store = ListeningQueueStore()

    let outcome = await store.play("a", client: client, currentToken: signedIn)

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/queue/active")
    XCTAssertEqual(body(StubProtocol.lastBody), ["setId": "a"])
    XCTAssertEqual(loaded(store)?.activeSetId, "a")
    XCTAssertEqual(loaded(store)?.entries.map(\.id), ["a"])
    guard case .applied(let queue) = outcome else { return XCTFail("\(outcome)") }
    XCTAssertEqual(queue.active?.id, "a")
  }

  func testPlayNextIsSentAsAnInsertAfterTheActiveSet() async throws {
    let client = try client { request in
      if request.url?.path == "/queue/entries" {
        return (
          201, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }
    let store = ListeningQueueStore()

    _ = await store.playNext("b", client: client, currentToken: signedIn)

    XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/queue/entries")
    XCTAssertEqual(body(StubProtocol.lastBody), ["placement": "next", "setId": "b"])
    XCTAssertEqual(loaded(store)?.entries.map(\.id), ["a", "b"])
    XCTAssertEqual(store.notice, "Plays next")
  }

  func testAddToQueueIsSentAsAnAppend() async throws {
    let client = try client { request in
      if request.url?.path == "/queue/entries" {
        return (
          201, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }
    let store = ListeningQueueStore()

    _ = await store.addToEnd("b", client: client, currentToken: signedIn)

    XCTAssertEqual(body(StubProtocol.lastBody), ["placement": "end", "setId": "b"])
    XCTAssertEqual(store.notice, "Added to the queue")
  }

  func testPlayingAPlaylistReplacesTheQueue() async throws {
    let client = try client { request in
      if request.url?.path == "/queue/playlist" {
        return (
          200, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }
    let store = ListeningQueueStore()

    _ = await store.playPlaylist("closing", client: client, currentToken: signedIn)

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/queue/playlist")
    XCTAssertEqual(body(StubProtocol.lastBody), ["playlistId": "closing"])
    XCTAssertEqual(loaded(store)?.entries.map(\.id), ["a", "b"])
  }

  /// Shuffle asks the service for the whole Playlist in a random order in one request. Queueing
  /// the members one at a time behind `PUT /queue/active` kept the old queue around them.
  func testShufflingAPlaylistReplacesTheQueueInOneRequest() async throws {
    let log = RequestLog()
    let client = try client(log: log) { request in
      if request.url?.path == "/queue/playlist" {
        return (
          200,
          Self.queueBody(
            active: "c", entries: [Self.set(id: "c"), Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }
    let store = ListeningQueueStore()

    _ = await store.playPlaylist(
      "closing", shuffled: true, client: client, currentToken: signedIn)

    XCTAssertEqual(log.all.filter { $0.contains("/queue") }, ["PUT /queue/playlist"])
    XCTAssertEqual(body(StubProtocol.lastBody), ["order": "shuffled", "playlistId": "closing"])
    XCTAssertEqual(loaded(store)?.activeSetId, "c")
    XCTAssertEqual(loaded(store)?.entries.map(\.id), ["c", "a", "b"])
  }

  func testAPlaylistWithNothingPlayableLeavesTheQueueEmpty() async throws {
    let client = try client { request in
      if request.url?.path == "/queue/playlist" {
        return (200, Self.queueBody(active: nil, entries: []))
      }
      return (200, "{}")
    }
    let store = ListeningQueueStore()

    _ = await store.playPlaylist("empty", client: client, currentToken: signedIn)

    XCTAssertNil(loaded(store)?.activeSetId)
    XCTAssertEqual(loaded(store)?.text, "The queue is empty.")
  }

  func testARefusedQueueActionSaysWhatTheServiceSaid() async throws {
    let client = try client { _ in
      (400, #"{"message":"Only sets with audio can be added to the queue."}"#)
    }
    let store = ListeningQueueStore()

    let outcome = await store.playNext("d", client: client, currentToken: signedIn)

    XCTAssertEqual(
      outcome,
      .failed(.server(status: 400, message: "Only sets with audio can be added to the queue.")))
    XCTAssertNil(loaded(store), "a refusal changes nothing")
    XCTAssertNil(store.notice)
  }

  func testFinishingASetAdvancesTheQueue() async throws {
    let log = RequestLog()
    let client = try client(log: log) { request in
      switch (request.httpMethod, request.url?.path) {
      case ("POST", "/queue/completion"):
        return (200, Self.queueBody(active: "b", entries: [Self.set(id: "b")]))
      default:
        return (200, "{}")
      }
    }
    let store = ListeningQueueStore()

    let outcome = await store.finished("a", client: client, currentToken: signedIn)

    XCTAssertEqual(log.all, ["POST /queue/completion"])
    XCTAssertEqual(body(StubProtocol.lastBody), ["setId": "a"])
    guard case .applied(let queue) = outcome else { return XCTFail("\(outcome)") }
    XCTAssertEqual(queue.activeSetId, "b")
  }

  func testTheQueueIsReadWithAGet() async throws {
    let client = try client { _ in
      (200, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")]))
    }
    let store = ListeningQueueStore()

    await store.load(from: client)

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "GET")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/queue")
    XCTAssertEqual(loaded(store)?.text, "> a  Set a\n  b  Set b")
  }

  func testAFailedReadKeepsItsReasonAndTheAddress() async throws {
    let client = try client { _ in (500, #"{"message":"Broken."}"#) }
    let store = ListeningQueueStore()

    await store.load(from: client)

    XCTAssertEqual(
      store.state,
      .failed(.server(status: 500, message: "Broken."), address: client.address))
  }

  func testAReadCancelledByLeavingTheAppKeepsTheQueueOnShow() async throws {
    let good = try client { _ in (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")])) }
    let store = ListeningQueueStore()
    await store.load(from: good)

    let cancelled = OrbisClient(
      address: good.address, token: "token",
      session: StubProtocol.session(failure: URLError(.cancelled)))
    await store.load(from: cancelled)

    XCTAssertEqual(loaded(store)?.activeSetId, "a")
  }

  func testResettingClearsTheQueueAndItsNotice() async throws {
    let client = try client { _ in
      (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
    }
    let store = ListeningQueueStore()
    _ = await store.playNext("a", client: client, currentToken: signedIn)
    XCTAssertNotNil(loaded(store))
    XCTAssertNotNil(store.notice)

    store.reset()

    XCTAssertEqual(store.state, .idle, "the queue belonged to the service that was forgotten")
    XCTAssertNil(store.notice)
  }

  /// Two mutations asked back to back run in the order asked: the service sees the first request
  /// finish before the second starts, and only the second, the newer, may publish its answer.
  func testMutationsRunOneAtATimeAndOnlyTheNewestPublishes() async throws {
    let log = RequestLog()
    let client = try client(log: log) { request in
      switch request.url?.path {
      case "/queue/active":
        return (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
      default:
        return (
          201, Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
    }
    let store = ListeningQueueStore()

    let first = store.submit(currentToken: signedIn) { try await client.playSet("a") }
    let second = store.submit(currentToken: signedIn) {
      try await client.queueSet("b", placement: .end)
    }
    let firstAnswer = try await first.request.value
    let secondAnswer = try await second.request.value

    XCTAssertEqual(log.all, ["PUT /queue/active", "POST /queue/entries"])
    XCTAssertFalse(store.publish(firstAnswer, revision: first.revision), "the newer one owns it")
    XCTAssertNil(loaded(store))
    XCTAssertTrue(store.publish(secondAnswer, revision: second.revision))
    XCTAssertEqual(loaded(store)?.entries.map(\.id), ["a", "b"])
  }

  /// A key forgotten between the ask and the send must not reach the service: a device that
  /// signed out sends nothing with the old key.
  func testAMutationIsNotSentOnceTheDeviceSignedOut() async throws {
    let log = RequestLog()
    let client = try client(log: log) { _ in (200, "{}") }
    let store = ListeningQueueStore()
    final class Key: @unchecked Sendable { var token: String? = "token" }
    let key = Key()

    let reading: @MainActor () -> String? = { key.token }
    let submission = store.submit(currentToken: reading) { try await client.playSet("a") }
    key.token = nil

    do {
      _ = try await submission.request.value
      XCTFail("the request should not have been sent")
    } catch is CancellationError {
    }
    XCTAssertEqual(log.all, [])
  }

  /// Signing out ends every request in flight: an answer that arrives afterwards is not published.
  func testAnAnswerThatArrivesAfterSigningOutIsNotPublished() async throws {
    let client = try client { _ in
      (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
    }
    let store = ListeningQueueStore()
    let submission = store.submit(currentToken: signedIn) { try await client.playSet("a") }

    store.reset()
    let answer = try await submission.request.value

    XCTAssertFalse(store.publish(answer, revision: submission.revision))
    XCTAssertEqual(store.state, .idle)
  }
}
