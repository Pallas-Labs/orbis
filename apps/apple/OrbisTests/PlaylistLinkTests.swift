import XCTest

@testable import Orbis

/// The app decides on its own whether a pasted link is filed or imported, so it must agree with
/// the service's `youTubePlaylistId`. Each test rules out one way the two could disagree:
///
/// - a `/playlist?list=` link is filed as a Set, and the service refuses it with a 400
/// - a video played from a playlist is imported whole instead of filed
/// - a YouTube Music or `youtu.be` link is classed differently from the same link on youtube.com
/// - a host that only ends in a YouTube name, or a SoundCloud link with `list`, is imported
/// - a `list` the service would refuse (too short, too long, other characters) is imported
/// - spaces around a pasted link change the answer
final class PlaylistLinkTests: XCTestCase {
  func testAPlaylistPageIsImported() {
    XCTAssertEqual(PlaylistLink.kind(of: "https://www.youtube.com/playlist?list=PLabc123"), .playlist)
    XCTAssertEqual(PlaylistLink.kind(of: "https://music.youtube.com/playlist?list=OLAK5uy_k"), .playlist)
    XCTAssertEqual(PlaylistLink.kind(of: "https://m.youtube.com/playlist?list=PLabc123&si=x"), .playlist)
    XCTAssertEqual(PlaylistLink.kind(of: "  https://youtube.com/playlist?list=PLabc123\n"), .playlist)
    XCTAssertEqual(PlaylistLink.id(in: "https://www.youtube.com/playlist?list=PLabc123"), "PLabc123")
  }

  func testAVideoPlayedFromAPlaylistIsStillASet() {
    XCTAssertEqual(
      PlaylistLink.kind(of: "https://www.youtube.com/watch?v=abcdefghijk&list=PLabc123"), .setInPlaylist)
    XCTAssertEqual(
      PlaylistLink.kind(of: "https://music.youtube.com/watch?v=abcdefghijk&list=RDAMVM"), .setInPlaylist)
    XCTAssertEqual(PlaylistLink.kind(of: "https://youtu.be/abcdefghijk?list=PLabc123"), .setInPlaylist)
    XCTAssertEqual(
      PlaylistLink.id(in: "https://youtu.be/abcdefghijk?list=PLabc123&t=30"), "PLabc123")
  }

  func testALinkWithoutAPlaylistIsASet() {
    XCTAssertEqual(PlaylistLink.kind(of: "https://www.youtube.com/watch?v=abcdefghijk"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "https://youtu.be/abcdefghijk"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "https://soundcloud.com/artist/set"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "https://soundcloud.com/artist/sets/mix?list=PLabc123"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "https://youtube.com.example.test/playlist?list=PLabc123"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "ftp://www.youtube.com/playlist?list=PLabc123"), .set)
    XCTAssertEqual(PlaylistLink.kind(of: "not a link"), .set)
  }

  func testAListTheServiceWouldRefuseIsNotImported() {
    XCTAssertNil(PlaylistLink.id(in: "https://www.youtube.com/playlist?list=P"))
    XCTAssertNil(PlaylistLink.id(in: "https://www.youtube.com/playlist?list=" + String(repeating: "a", count: 65)))
    XCTAssertNotNil(PlaylistLink.id(in: "https://www.youtube.com/playlist?list=" + String(repeating: "a", count: 64)))
    XCTAssertNil(PlaylistLink.id(in: "https://www.youtube.com/playlist?list=PL%2Fabc"))
    XCTAssertNil(PlaylistLink.id(in: "https://www.youtube.com/playlist?list="))
    XCTAssertEqual(PlaylistLink.kind(of: "https://www.youtube.com/playlist?list=P"), .set)
  }
}
