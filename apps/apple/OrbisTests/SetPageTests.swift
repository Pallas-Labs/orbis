import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// The Set page changes one Set at a time. What a refusal leaves behind matters as much as what
/// a success does, because the person is looking at the Set when it happens.
@MainActor
final class SetPageTests: XCTestCase {
  private func set(
    id: String = "1",
    title: String = "Night session",
    tags: [String] = [],
    playlists: [String] = []
  ) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: title,
      source: .youtube,
      tags: tags,
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: nil,
      creator: nil,
      artworkUrl: nil,
      artworkLargeUrl: nil,
      durationSeconds: nil,
      metadataState: "enriched",
      downloadState: "none",
      playlistIds: playlists,
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }

  private func model(
    sets: [SavedSet],
    status: Int = 200,
    body: String = Fixtures.savedSet(title: "Night session", tags: []),
    failure: URLError? = nil
  ) throws -> AppModel {
    let session =
      failure.map { StubProtocol.session(failure: $0) }
      ?? StubProtocol.session(status: status, body: body)
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: session
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    model.library = .loaded(sets)
    return model
  }

  func testEachTabKeepsItsOwnOpenSet() throws {
    let model = try model(sets: [set(), set(id: "2", title: "Other")])
    model.destination = .home
    model.openSet("1")

    model.destination = .library
    XCTAssertNil(model.openedSetId, "a Set opened from Home must not appear under Library")
    model.openSet("2")

    model.destination = .home
    XCTAssertEqual(model.openedSetId, "1", "Home keeps the page it had open")
    model.destination = .library
    XCTAssertEqual(model.openedSetId, "2")
  }

  func testRemovingASetClosesItInEveryTab() async throws {
    let model = try model(sets: [set(), set(id: "2", title: "Other")])
    model.destination = .home
    model.openSet("1")
    model.destination = .search
    model.openSet("1")

    await model.remove("1")

    XCTAssertNil(model.openedSetId)
    model.destination = .home
    XCTAssertNil(model.openedSetId)
  }

  /// The Set stays on screen with the reason beside it, so the removal can be tried again
  /// rather than leaving a person wondering whether it worked.
  func testARefusedRemovalKeepsTheSetAndSaysWhy() async throws {
    let model = try model(
      sets: [set()], status: 500, body: #"{"message":"The library is busy."}"#)

    await model.remove("1")

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.id), ["1"])
    XCTAssertEqual(
      model.setFailure?.message,
      OrbisError.server(status: 500, message: "The library is busy.").failure().message
    )
  }

  func testAnEmptyTitleIsNeverSent() async throws {
    let model = try model(sets: [set()])
    await model.rename("1", to: "   ")
    XCTAssertNil(StubProtocol.lastRequest)
  }

  func testReplacingTagsSendsTheWholeList() async throws {
    let model = try model(sets: [set(tags: ["techno"])])

    await model.replaceTags("1", with: ["techno", "live"])

    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/tags")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["tags"] as? [String], ["techno", "live"])
  }

  /// Orbis holds a Set in one Playlist, so choosing another states the whole membership and
  /// leaves the Playlist it came from.
  func testMovingASetStatesTheWholeMembership() async throws {
    let model = try model(sets: [set(playlists: ["old"])])

    await model.move("1", to: "new")

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/playlists")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["playlistIds"] as? [String], ["new"])
  }

  func testTakingASetOutOfEveryPlaylistSendsNothing() async throws {
    let model = try model(sets: [set(playlists: ["old"])])

    await model.move("1", to: nil)

    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["playlistIds"] as? [String], [])
  }

  /// While the Library is showing one playlist, a Set that moves out of it must leave the
  /// list; keeping the row would say the move did nothing.
  func testMovingASetOutOfThePlaylistBeingViewedTakesItsRowWithIt() async throws {
    let model = try model(
      sets: [set(id: "1", playlists: ["viewed"]), set(id: "2", title: "Stays", playlists: ["viewed"])]
    )
    model.selectedPlaylistId = "viewed"

    await model.move("1", to: nil)

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.id), ["2"], "the row must leave with the playlist it moved out of")
  }

  /// A change that does not touch membership keeps the row where it was.
  func testRenamingASetInThePlaylistBeingViewedKeepsItsRow() async throws {
    let body = Fixtures.savedSet(title: "Renamed", tags: []).replacingOccurrences(
      of: "\"playlistIds\":[]", with: "\"playlistIds\":[\"viewed\"]")
    let model = try model(sets: [set(id: "1", playlists: ["viewed"])], body: body)
    model.selectedPlaylistId = "viewed"

    await model.rename("1", to: "Renamed")

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.title), ["Renamed"], "membership is unchanged, so the row stays")
  }

  private nonisolated static let cues =
    #"[{"position":1,"startSeconds":0,"artist":"A","title":"One"},"#
    + #"{"position":2,"startSeconds":300,"artist":"B","title":"Two"}]"#

  private func tracklistModel(
    responder: @Sendable @escaping (URLRequest) -> (Int, String)
  ) throws -> AppModel {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(responder: responder)
    )
    return AppModel(client: client, settings: MemoryClientSettings())
  }

  /// The service keeps a Set's Cues through a failed refresh, so the page must too: the seek
  /// rows stay usable and the page does not say "Tracklist unavailable".
  func testARefreshThatCannotReachTheServiceKeepsTheCues() async throws {
    let model = try tracklistModel { request in
      request.httpMethod == "POST"
        ? (500, #"{"message":"The library is busy."}"#)
        : (200, #"{"state":"ready","cues":\#(Self.cues)}"#)
    }
    await model.loadTracklist("1")

    await model.retryTracklist("1")

    XCTAssertEqual(model.tracklists["1"]?.state, .ready)
    XCTAssertEqual(model.tracklists["1"]?.cues.map(\.title), ["One", "Two"])
  }

  /// A refresh leaves the Tracklist pending with its Cues while Versos works. A failed poll
  /// in that state must not drop them.
  func testAFailedPollDuringARefreshKeepsTheCues() async throws {
    let model = try tracklistModel { request in
      request.httpMethod == "POST"
        ? (200, #"{"state":"pending","cues":\#(Self.cues)}"#)
        : (500, #"{"message":"The library is busy."}"#)
    }

    await model.retryTracklist("1")

    XCTAssertEqual(model.tracklists["1"]?.state, .ready)
    XCTAssertEqual(model.tracklists["1"]?.cues.map(\.title), ["One", "Two"])
  }

  /// With no Cues to keep, a failed refresh still says the Tracklist is unavailable.
  func testAFailedRefreshWithNoCuesShowsTheFailure() async throws {
    let model = try tracklistModel { _ in (500, #"{"message":"The library is busy."}"#) }

    await model.retryTracklist("1")

    XCTAssertEqual(model.tracklists["1"], Tracklist(state: .failed, cues: []))
  }
}
