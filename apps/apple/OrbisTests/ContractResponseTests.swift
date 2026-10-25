import Foundation
import XCTest

@testable import Orbis

final class ContractResponseTests: XCTestCase {
  private struct Samples: Decodable {
    struct Tags: Decodable { let tags: [String] }

    let audioState: AudioState
    let library: LibraryResponse
    let me: Me
    let playlist: Playlist
    let playlists: PlaylistsResponse
    let playlistImports: [PlaylistImportJob]
    let queue: QueueResponse
    let savedSet: SavedSet
    let socialFilters: SocialFilters
    let tags: Tags
  }

  func testSwiftModelsDecodeServedContractResponses() throws {
    let file = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("Fixtures/contract-responses.json")
    let samples = try JSONDecoder().decode(Samples.self, from: Data(contentsOf: file))

    XCTAssertEqual(samples.library.sets.first?.id, samples.savedSet.id)
    XCTAssertEqual(samples.playlists.playlists.first?.id, samples.playlist.id)
    XCTAssertEqual(samples.audioState.state, "none")
    XCTAssertEqual(samples.queue.queue.entries.count, 0)
    XCTAssertEqual(samples.tags.tags, samples.savedSet.tags)
    XCTAssertEqual(samples.me.id, "host")
    XCTAssertTrue(samples.me.autoDownload)
    XCTAssertTrue(samples.me.host)
    XCTAssertTrue(samples.socialFilters.see)
    XCTAssertEqual(
      samples.playlistImports.map(\.state),
      [
        .running(processed: 50, total: 61),
        .done(.init(added: 58, downloading: 20, waiting: 38, unavailable: 2, overLimit: 0)),
        .failed(message: "YouTube is not answering. Try the import again."),
      ])
    XCTAssertEqual(samples.playlistImports.first?.playlist.id, samples.playlist.id)
  }
}
