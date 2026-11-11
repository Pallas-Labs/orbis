import Foundation
import XCTest

@testable import Orbis

/// Bulk import reads many links out of one paste and files each one on its own.
///
/// Ways it could fail, each covered below:
/// - a separator other than a newline (space, comma, semicolon) glues two links into one;
/// - words, punctuation, or brackets around a link become a row, or hide the link;
/// - two forms of one video file it twice, or a Set already in the Library is filed again;
/// - a link on another host, or a playlist page with no single Set, is filed and refused;
/// - one link's refusal or failure stops the links after it, or lands on the wrong row;
/// - the batch's Tags reach only some saves, or a skipped row still sends a request.
@MainActor
final class BulkImportTests: XCTestCase {
  private func verdicts(_ text: String, filed: [String] = []) -> [String] {
    BulkLinks.parse(text, filed: filed).map { link in
      switch link.verdict {
      case .importable: "import \(link.link)"
      case .repeated: "repeated \(link.link)"
      case .inLibrary: "library \(link.link)"
      case .unsupported(let reason): "unsupported \(link.link) \(reason)"
      }
    }
  }

  func testLinksSplitOnNewlinesSpacesCommasAndSemicolons() {
    let text = """
      https://youtu.be/aaaaaaaaaaa
      https://www.youtube.com/watch?v=bbbbbbbbbbb https://soundcloud.com/artist/track,https://music.apple.com/us/album/mix/123;https://youtu.be/ccccccccccc ,  https://youtu.be/ddddddddddd
      """
    XCTAssertEqual(
      verdicts(text),
      [
        "import https://youtu.be/aaaaaaaaaaa",
        "import https://www.youtube.com/watch?v=bbbbbbbbbbb",
        "import https://soundcloud.com/artist/track",
        "import https://music.apple.com/us/album/mix/123",
        "import https://youtu.be/ccccccccccc",
        "import https://youtu.be/ddddddddddd",
      ])
  }

  func testWordsAroundLinksAreIgnoredAndWrappingIsTrimmed() {
    let text = """
      Mixes from the weekend, e.g. these two: <https://youtu.be/aaaaaaaaaaa>
      (https://soundcloud.com/artist/track). Thanks!! mail me at dj@example.com
      also youtu.be/bbbbbbbbbbb and "https://youtu.be/ccccccccccc"
      - [Mix](https://youtu.be/ddddddddddd), link:https://youtu.be/eeeeeeeeeee
      """
    XCTAssertEqual(
      verdicts(text),
      [
        "import https://youtu.be/aaaaaaaaaaa",
        "import https://soundcloud.com/artist/track",
        "import https://youtu.be/bbbbbbbbbbb",
        "import https://youtu.be/ccccccccccc",
        "import https://youtu.be/ddddddddddd",
        "import https://youtu.be/eeeeeeeeeee",
      ])
  }

  func testTheSameSetTwiceIsMarkedAndALibrarySetIsMarked() {
    let text = """
      https://youtu.be/aaaaaaaaaaa?t=30
      https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLx
      https://m.youtube.com/shorts/aaaaaaaaaaa
      https://soundcloud.com/artist/track
      https://m.soundcloud.com/artist/track/?ref=share
      https://music.apple.com/album/123
      https://music.apple.com/us/album/a-mix/123?i=9
      https://youtu.be/bbbbbbbbbbb
      """
    XCTAssertEqual(
      verdicts(text, filed: ["https://www.youtube.com/watch?v=bbbbbbbbbbb"]),
      [
        "import https://youtu.be/aaaaaaaaaaa?t=30",
        "repeated https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLx",
        "repeated https://m.youtube.com/shorts/aaaaaaaaaaa",
        "import https://soundcloud.com/artist/track",
        "repeated https://m.soundcloud.com/artist/track/?ref=share",
        "import https://music.apple.com/album/123",
        "repeated https://music.apple.com/us/album/a-mix/123?i=9",
        "library https://youtu.be/bbbbbbbbbbb",
      ])
  }

  func testOtherHostsAndPagesWithNoSingleSetAreUnsupported() {
    let text = """
      https://example.com/mix https://vimeo.com/123
      https://www.youtube.com/playlist?list=PLorbis https://www.youtube.com/@channel
      https://soundcloud.com/artist/sets https://soundcloud.com/artist
      https://music.apple.com/us/playlist/x/pl.123
      ftp://youtu.be/aaaaaaaaaaa
      """
    let host = BulkLinks.unsupportedHost
    let shape = BulkLinks.notASet
    XCTAssertEqual(
      verdicts(text),
      [
        "unsupported https://example.com/mix \(host)",
        "unsupported https://vimeo.com/123 \(host)",
        "unsupported https://www.youtube.com/playlist?list=PLorbis \(shape)",
        "unsupported https://www.youtube.com/@channel \(shape)",
        "unsupported https://soundcloud.com/artist/sets \(shape)",
        "unsupported https://soundcloud.com/artist \(shape)",
        "unsupported https://music.apple.com/us/playlist/x/pl.123 \(shape)",
      ])
  }

  func testOneFailureLandsOnItsRowAndTheOthersAreStillFiled() async throws {
    let session = StubProtocol.session { request in
      let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) }
      let fields = body as? [String: Any]
      let url = fields?["url"] as? String ?? ""
      XCTAssertEqual(fields?["tags"] as? [String], ["Friday"])
      if url.contains("fail") {
        return (500, #"{"message":"The provider did not answer."}"#)
      }
      if url.contains("dupe") {
        return (409, #"{"message":"This set is already in your library."}"#)
      }
      let saved = OrbisClientTests.savedSet(title: "Filed \(url.suffix(11))", tags: ["Friday"])
      return (201, String(saved.dropLast()) + #","autoDownloadResult":"queued"}"#)
    }
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://vanta.example.ts.net")), token: "token",
      session: session)
    let importer = BulkImport()
    importer.text = """
      https://youtu.be/okfirst0001
      https://youtu.be/failsecond2
      https://example.com/skip
      https://youtu.be/dupethird3x
      https://youtu.be/okfourth004
      """
    importer.tags = ["Friday"]

    await importer.run(client: client, filed: [])

    XCTAssertEqual(
      importer.results?.map(\.outcome),
      [
        .filed(title: "Filed okfirst0001", download: "Downloading"),
        .failed(OrbisError.server(status: 500, message: "The provider did not answer.").message),
        .skipped(BulkLinks.unsupportedHost),
        .skipped("Already in your Library"),
        .filed(title: "Filed okfourth004", download: "Downloading"),
      ])
    XCTAssertFalse(importer.isImporting)

    importer.startOver()
    XCTAssertNil(importer.results)
    XCTAssertEqual(importer.text, "")
    XCTAssertEqual(importer.tags, ["Friday"])
  }
}
