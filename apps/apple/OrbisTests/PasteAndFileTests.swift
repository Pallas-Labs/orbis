import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// Pasting is the shortcut, so what it refuses matters as much as what it files.
@MainActor
final class PasteAndFileTests: XCTestCase {
  private func model() throws -> AppModel {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(
        status: 201, body: Fixtures.savedSet(title: "Night session", tags: []))
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    // A loaded library keeps a successful filing from reloading, so the last request stays the save.
    model.library = .loaded([])
    return model
  }

  private func source(_ address: String) throws -> SetSource? {
    SetSource.named(by: try XCTUnwrap(URL(string: address)))
  }

  func testTheHostDecidesWhichServiceAndThePathStaysTheServicesBusiness() throws {
    XCTAssertEqual(try source("https://youtu.be/abcdefghijk"), .youtube)
    XCTAssertEqual(try source("https://music.youtube.com/watch?v=x"), .youtube)
    XCTAssertEqual(try source("https://m.soundcloud.com/a/b"), .soundcloud)
    XCTAssertEqual(try source("https://music.apple.com/us/album/dj-kicks-dj-mix/1046502556"), .appleMusic)
    XCTAssertNil(try source("https://example.com/watch?v=abcdefghijk"))
    XCTAssertNil(try source("https://spotify.com/track/x"))
    // A host that merely ends in the name is not the service.
    XCTAssertNil(try source("https://youtube.com.example.test/watch?v=a"))
    XCTAssertNil(try source("https://music.apple.com.example.test/us/album/x/1"))
  }

  func testAPastedYouTubeLinkIsFiledWithoutTypingAnything() async throws {
    let model = try model()
    await model.pasteAndFile("https://youtu.be/tPEMP9oYxTo")
    XCTAssertNil(model.pasteNotice)
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["url"] as? String, "https://youtu.be/tPEMP9oYxTo")
  }

  /// An Apple Music link is posted as it was pasted; the service reads the album.
  func testAPastedAppleMusicLinkIsFiled() async throws {
    let model = try model()
    let link = "https://music.apple.com/us/album/dj-kicks-dj-mix/1046502556"
    await model.pasteAndFile(link)
    XCTAssertNil(model.pasteNotice)
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["url"] as? String, link)
  }

  /// A paste Orbis cannot take is refused before the round trip, and the field is left alone
  /// because it holds what the person put there.
  func testAPasteThatIsNotALinkChangesNothing() async throws {
    let model = try model()
    model.linkToFile = "typed by hand"
    await model.pasteAndFile("https://open.spotify.com/track/abc")
    XCTAssertEqual(model.pasteNotice, "The clipboard holds no YouTube, SoundCloud, or Apple Music link.")
    XCTAssertNil(StubProtocol.lastRequest, "nothing is sent for a link Orbis does not take")
    XCTAssertEqual(model.linkToFile, "typed by hand")
  }
}
