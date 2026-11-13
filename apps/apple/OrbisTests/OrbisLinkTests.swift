import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// An Orbis Link opens the Set it names (ADR 0023): its own page when the Library holds it, its
/// shared facts with Save when it does not, and the same once sign-in completes when the device
/// is signed out.
@MainActor
final class OrbisLinkTests: XCTestCase {
  nonisolated private static let id = "0f8e7c2a-5b1d-4e8f-9a3c-2d6b7e1f4a90"
  nonisolated private static let sourceLink = "https://www.youtube.com/watch?v=abcdefghijk"
  /// The link to this suite's Set, `https://orbis.p11a.xyz/s/<set id>`.
  nonisolated private static func link(to id: String) throws -> URL {
    try XCTUnwrap(URL(string: "https://orbis.p11a.xyz/s/\(id)"))
  }

  nonisolated private static let savedBody = """
    {"id":"\(id)","url":"\(sourceLink)","title":"Night session","source":"youtube","tags":[],
    "createdAt":"2026-01-01T00:00:00.000Z","releasedAt":null,"creator":"Ada Lovelace",
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched","downloadState":"none",
    "playlistIds":[],"playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
    "lastListenedAt":null}
    """
  nonisolated private static let sharedBody = """
    {"artworkUrl":"https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg","creator":"Ada Lovelace",
    "id":"\(id)","source":"youtube","title":"Night session","url":"\(sourceLink)"}
    """

  /// Answers the service's routes the link flow uses. `library` is what `GET /sets` holds and
  /// `share` is the status of `GET /share/sets/:id`.
  nonisolated private static func responder(
    log: RequestLog, library: @escaping @Sendable () -> [String], share: @escaping @Sendable () -> Int
  ) -> @Sendable (URLRequest) -> (Int, String) {
    { request in
      log.record(request)
      let path = request.url?.path() ?? ""
      switch (request.httpMethod ?? "GET", path) {
      case ("POST", let path) where path.hasSuffix("/sign-in/code"):
        return (200, #"{"key":"synthetic-new-key","person":{"id":"p1","username":"ada"}}"#)
      case ("GET", let path) where path.hasSuffix("/sets"):
        return (200, #"{"sets":["# + library().joined(separator: ",") + "]}")
      case ("POST", let path) where path.hasSuffix("/sets"):
        return (201, savedBody)
      case ("GET", let path) where path.hasSuffix("/share/sets/\(id)"):
        let status = share()
        return status == 200 ? (200, sharedBody) : (status, #"{"message":"No set has that id."}"#)
      case ("GET", let path) where path.hasSuffix("/playlists"):
        return (200, #"{"playlists":[]}"#)
      default:
        return (500, "{}")
      }
    }
  }

  private func signedIn(
    log: RequestLog, library: [String], share: Int = 200
  ) async throws -> AppModel {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")), token: "token",
      session: StubProtocol.session(
        responder: Self.responder(log: log, library: { library }, share: { share })))
    let model = AppModel(client: client, settings: MemoryClientSettings())
    await model.loadLibrary()
    log.clear()
    return model
  }

  func testTheParserTakesBothFormsOfALink() throws {
    let accepted = [
      "https://orbis.p11a.xyz/s/\(Self.id)",
      "https://orbis.p11a.xyz/s/\(Self.id)/",
      "https://ORBIS.P11A.XYZ/s/\(Self.id)",
      "https://orbis.p11a.xyz/s/\(Self.id)?from=imessage",
      "orbis://s/\(Self.id)",
      "orbis://s/\(Self.id)/",
    ]
    for text in accepted {
      XCTAssertEqual(OrbisLink.setId(in: try XCTUnwrap(URL(string: text))), Self.id, text)
    }
  }

  func testTheParserRefusesEveryOtherAddress() throws {
    let refused = [
      "http://orbis.p11a.xyz/s/\(Self.id)",
      "https://orbis.p11a.xyz.example.com/s/\(Self.id)",
      "https://example.com/s/\(Self.id)",
      "https://orbis.p11a.xyz/api/s/\(Self.id)",
      "https://orbis.p11a.xyz/x/\(Self.id)",
      "https://orbis.p11a.xyz/s/",
      "https://orbis.p11a.xyz/s",
      "https://orbis.p11a.xyz/s/\(Self.id)/page",
      "https://orbis.p11a.xyz/s/..",
      "https://orbis.p11a.xyz/s/a%2Fb",
      "orbis://x/\(Self.id)",
      "orbis://s",
      "orbis://s/a%2Fb",
      Self.sourceLink,
    ]
    for text in refused {
      XCTAssertNil(OrbisLink.setId(in: try XCTUnwrap(URL(string: text))), text)
    }
  }

  func testTheLinkSharedForASetIsTheOneThatOpensIt() {
    let shared = OrbisLink.url(forSet: Self.id)
    XCTAssertEqual(shared.absoluteString, "https://orbis.p11a.xyz/s/\(Self.id)")
    XCTAssertEqual(OrbisLink.setId(in: shared), Self.id)
  }

  func testALinkToASavedSetOpensItsPage() async throws {
    let log = RequestLog()
    let model = try await signedIn(log: log, library: [Self.savedBody])
    model.destination = .library

    await model.open(try Self.link(to: Self.id))

    XCTAssertEqual(model.openedSetId, Self.id, "the link must push the Set's page")
    XCTAssertEqual(model.savedSet(Self.id)?.title, "Night session", "the page shows the saved Set")
    XCTAssertNil(model.openedLink, "a saved Set needs nothing more from the link")
    XCTAssertFalse(log.contains("/share/sets/"), "a saved Set must not be read as a shared one")
  }

  /// People has no Set pages, so a link opened there would push into nothing.
  func testALinkOpenedOnPeopleOpensOnHome() async throws {
    let model = try await signedIn(log: RequestLog(), library: [Self.savedBody])
    model.destination = .people

    await model.open(try XCTUnwrap(URL(string: "orbis://s/\(Self.id)")))

    XCTAssertEqual(model.destination, .home)
    XCTAssertEqual(model.openedSets[.home], Self.id)
  }

  func testALinkToASetOutsideTheLibraryShowsItsSharedFactsAndSavesIt() async throws {
    let log = RequestLog()
    let model = try await signedIn(log: log, library: [])
    model.destination = .library

    await model.open(try Self.link(to: Self.id))

    XCTAssertEqual(model.openedSetId, Self.id)
    XCTAssertTrue(log.contains("GET /share/sets/\(Self.id)"), log.all.joined(separator: "\n"))
    guard case .shared(let shared) = model.openedLink?.state else {
      return XCTFail(
        "a Set outside the Library must show its shared facts, not \(String(describing: model.openedLink))")
    }
    XCTAssertEqual(shared.title, "Night session")
    XCTAssertEqual(shared.creator, "Ada Lovelace")
    XCTAssertEqual(shared.source, .youtube)

    await model.saveOpenedLink()

    XCTAssertTrue(log.contains("POST /sets"))
    let sent = try JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["url"] as? String, Self.sourceLink, "Save sends the Source Link")
    XCTAssertEqual(model.savedSet(Self.id)?.title, "Night session", "the saved Set joins the Library")
    XCTAssertNil(model.openedLink, "the page becomes the Set's own")
    XCTAssertEqual(model.openedSetId, Self.id)
    XCTAssertNil(model.setFailure)
  }

  func testAnUnknownLinkSaysTheSetIsNotAvailable() async throws {
    let model = try await signedIn(log: RequestLog(), library: [], share: 404)

    await model.open(try Self.link(to: Self.id))

    XCTAssertEqual(model.openedSetId, Self.id, "the page opens to say so")
    XCTAssertEqual(model.openedLink?.state, .unavailable)
  }

  /// A failed read is not a missing Set: it says why and can be tried again.
  func testALinkThatCannotBeReadOffersToTryAgain() async throws {
    let share = ShareStatus(503)
    let log = RequestLog()
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")), token: "token",
      session: StubProtocol.session(
        responder: Self.responder(log: log, library: { [] }, share: { share.value })))
    let model = AppModel(client: client, settings: MemoryClientSettings())
    await model.loadLibrary()

    await model.open(try Self.link(to: Self.id))

    guard case .failed(let failure) = model.openedLink?.state else {
      return XCTFail("a refused read must say so, not \(String(describing: model.openedLink))")
    }
    XCTAssertTrue(failure.isRetryable)

    share.value = 200
    await model.retryOpenedLink()

    guard case .shared = model.openedLink?.state else {
      return XCTFail("trying again must read the shared facts")
    }
  }

  /// A link that arrives while the Library is still loading cannot yet tell a saved Set from an
  /// unsaved one, so it waits for the Library instead of reading the shared facts.
  func testALinkWaitsForTheLibraryBeforeDeciding() async throws {
    let log = RequestLog()
    let model = try await signedIn(log: log, library: [Self.savedBody])
    model.library = .loading

    await model.open(try Self.link(to: Self.id))

    XCTAssertEqual(model.openedLink?.state, .opening)
    XCTAssertFalse(log.contains("/share/sets/"))

    await model.loadLibrary()

    XCTAssertNil(model.openedLink, "the arriving Library holds the Set")
    XCTAssertEqual(model.openedSetId, Self.id)
    XCTAssertFalse(log.contains("/share/sets/"))
  }

  func testASignedOutLinkOpensTheSetAfterSignIn() async throws {
    let log = RequestLog()
    let model = AppModel(
      settings: MemoryClientSettings(),
      session: StubProtocol.session(
        responder: Self.responder(log: log, library: { [Self.savedBody] }, share: { 200 })))
    XCTAssertFalse(model.isConfigured)

    await model.open(try Self.link(to: Self.id))

    XCTAssertEqual(model.openedLink, AppModel.OpenedLink(setId: Self.id, state: .awaitingSignIn))
    XCTAssertTrue(model.openedSets.isEmpty, "nothing opens behind the sign-in screen")
    XCTAssertTrue(log.all.isEmpty, "a signed-out device asks the service nothing")

    await model.signIn(.code("abcd efgh"))

    XCTAssertTrue(model.isConfigured)
    XCTAssertEqual(model.openedSets[.home], Self.id, "the kept link opens once signed in")
    XCTAssertEqual(model.savedSet(Self.id)?.title, "Night session")
    XCTAssertNil(model.openedLink)
  }

  func testASignedOutLinkToAnUnsavedSetShowsItsSharedFactsAfterSignIn() async throws {
    let model = AppModel(
      settings: MemoryClientSettings(),
      session: StubProtocol.session(
        responder: Self.responder(log: RequestLog(), library: { [] }, share: { 200 })))

    await model.open(try Self.link(to: Self.id))
    await model.signIn(.code("abcd efgh"))

    XCTAssertEqual(model.openedSets[.home], Self.id)
    guard case .shared(let shared) = model.openedLink?.state else {
      return XCTFail("the kept link must show the shared facts, not \(String(describing: model.openedLink))")
    }
    XCTAssertEqual(shared.id, Self.id)
  }

  func testSigningOutForgetsTheLink() async throws {
    let model = try await signedIn(log: RequestLog(), library: [], share: 404)
    await model.open(try Self.link(to: Self.id))

    model.signOut()

    XCTAssertNil(model.openedLink, "the next Person must not land on this one's link")
  }

  /// Every request a stubbed session answered, as "METHOD /path".
  private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ request: URLRequest) {
      let entry = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
      lock.withLock { entries.append(entry) }
    }

    func clear() { lock.withLock { entries.removeAll() } }

    var all: [String] { lock.withLock { entries } }

    func contains(_ text: String) -> Bool { all.contains { $0.contains(text) } }
  }

  /// The share route's status, which a test changes between two requests.
  private final class ShareStatus: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Int

    init(_ value: Int) { stored = value }

    var value: Int {
      get { lock.withLock { stored } }
      set { lock.withLock { stored = newValue } }
    }
  }
}
