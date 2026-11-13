import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

@MainActor
final class ShareCaptureTests: XCTestCase {
  func testSourceLinkAcceptsYouTubeAndSoundCloud() {
    XCTAssertEqual(
      ShareCapture.sourceLink(from: ["https://www.youtube.com/watch?v=abcdefghijk"])?
        .absoluteString,
      "https://www.youtube.com/watch?v=abcdefghijk"
    )
    XCTAssertEqual(
      ShareCapture.sourceLink(from: ["hear https://soundcloud.com/artist/track now"])?
        .host(),
      "soundcloud.com"
    )
    XCTAssertEqual(
      ShareCapture.sourceLink(from: ["Listen on #SoundCloud https://on.soundcloud.com/AbCdEf123"])?
        .host(),
      "on.soundcloud.com"
    )
  }

  /// What the Music app sends when an album or a song is shared to Orbis, on iPhone and on Mac.
  private struct MusicAppShares: Decodable {
    struct Share: Decodable {
      struct Attachment: Decodable { let value: String }
      let platform: String
      let item: String
      let attachments: [Attachment]
      let sourceLink: String
    }
    let shares: [Share]
  }

  func testSourceLinkFindsTheAppleMusicLinkInEachMusicAppShare() throws {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "MusicAppShares", withExtension: "json"))
    let fixture = try JSONDecoder().decode(MusicAppShares.self, from: Data(contentsOf: url))
    XCTAssertFalse(fixture.shares.isEmpty)
    for share in fixture.shares {
      // The extension reads each attachment's value in order, as `ShareExtensionPayloads` does.
      let link = ShareCapture.sourceLink(from: share.attachments.map(\.value))
      XCTAssertEqual(link?.absoluteString, share.sourceLink, "\(share.platform) \(share.item)")
      XCTAssertEqual(link.flatMap(SetSource.named(by:)), .appleMusic, "\(share.platform) \(share.item)")
    }
  }

  func testSourceLinkRejectsUnsupportedHosts() {
    XCTAssertNil(ShareCapture.sourceLink(from: ["https://example.com/mix"]))
    XCTAssertNil(ShareCapture.sourceLink(from: ["not a link"]))
    // Only Apple Music's own host; Apple's other sites are not a Source.
    XCTAssertNil(ShareCapture.sourceLink(from: ["https://www.apple.com/apple-music/"]))
    XCTAssertNil(ShareCapture.sourceLink(from: ["https://music.apple.com.example.test/us/album/x/1"]))
  }

  func testSaveReportsDuplicateWithoutTouchingClipboardPath() async throws {
    let settings = MemoryClientSettings()
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session { request in
      XCTAssertEqual(request.httpMethod, "POST")
      return (409, #"{"message":"This set is already in your library."}"#)
    }
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: try XCTUnwrap(URL(string: "https://www.youtube.com/watch?v=abcdefghijk")),
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings,
      client: client
    )
    XCTAssertEqual(outcome, .duplicate)
  }

  func testSaveReportsUnreachable() async throws {
    let settings = MemoryClientSettings()
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session(failure: URLError(.notConnectedToInternet))
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: try XCTUnwrap(URL(string: "https://www.youtube.com/watch?v=abcdefghijk")),
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings,
      client: client
    )
    guard case .unreachable = outcome else {
      return XCTFail("expected unreachable, got \(outcome)")
    }
  }

  func testSaveSucceedsAndCanRequestDownload() async throws {
    let settings = MemoryClientSettings()
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("POST", "/sets"):
        return (
          200,
          #"{"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk","title":"Night","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","metadataState":"ready","downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0}"#
        )
      case ("POST", "/sets/1/audio/download"):
        return (
          200,
          #"{"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk","title":"Night","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","metadataState":"ready","downloadState":"queued","playbackPositionSeconds":0,"listenCount":0,"finishCount":0}"#
        )
      default:
        return (500, "{}")
      }
    }
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: try XCTUnwrap(URL(string: "https://www.youtube.com/watch?v=abcdefghijk")),
      tags: ["techno"],
      playlistId: nil,
      downloadAfterSaving: true,
      settings: settings,
      client: client
    )
    guard case .saved(let set) = outcome else {
      return XCTFail("expected saved, got \(outcome)")
    }
    XCTAssertEqual(set.title, "Night")
  }

  func testNotConfiguredWhenPairingMissing() async throws {
    let settings = MemoryClientSettings()
    let outcome = await ShareCapture.save(
      url: try XCTUnwrap(URL(string: "https://www.youtube.com/watch?v=abcdefghijk")),
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings
    )
    XCTAssertEqual(outcome, .notConfigured)
  }

}
