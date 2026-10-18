import Foundation
import XCTest

@testable import Orbis

@MainActor
final class PlaybackDiagnosticsTests: XCTestCase {
  private func decode(_ text: String) throws -> PlaybackDiagnostics.Report {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(PlaybackDiagnostics.Report.self, from: Data(text.utf8))
  }

  func testReportCapsEntriesBytesAndNonFiniteNumbers() throws {
    let diagnostics = PlaybackDiagnostics(maxReportBytes: 4_096)
    var snapshot = PlaybackDiagnostics.Snapshot()
    snapshot.actualTime = .init(.nan)
    snapshot.displayedTime = .init(.infinity)
    snapshot.rate = .init(-.infinity)

    for index in 0..<300 {
      diagnostics.record(
        .command(.init(kind: .seek, origin: .app, target: .init(Double(index)))),
        snapshot: snapshot,
        wallTime: Date(timeIntervalSince1970: Double(index)), uptime: Double(index))
    }

    let text = diagnostics.report(current: snapshot)
    let report = try decode(text)
    XCTAssertLessThanOrEqual(Data(text.utf8).count, 4_096)
    XCTAssertLessThanOrEqual(report.entries.count, 256)
    XCTAssertGreaterThan(report.evictedCount, 44)
    XCTAssertEqual(report.entries.map(\.sequence), report.entries.map(\.sequence).sorted())
    XCTAssertEqual(report.entries.last?.sequence, 300)
    XCTAssertNil(report.current.actualTime.value)
    XCTAssertNil(report.current.displayedTime.value)
    XCTAssertNil(report.current.rate.value)
  }

  func testPrivatePlaybackValuesAndSDKErrorTextNeverEnterAReport() throws {
    let privateSetID = "private-set-7381"
    let privateTitle = "Private Sunday mix"
    let privateToken = "secret-token-9917"
    let privateAddress = "https://private.example.test/secret"
    let localized = "Could not load \(privateAddress)?token=\(privateToken)"
    let error = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
      userInfo: [NSLocalizedDescriptionKey: localized])
    let described = AudioPlayer.describe(error)
    XCTAssertFalse(described.contains(localized))
    XCTAssertFalse(described.contains(privateAddress))
    XCTAssertFalse(described.contains(privateToken))

    let set = SavedSet(
      id: privateSetID, url: privateAddress, title: privateTitle, source: .youtube, tags: [],
      createdAt: "2026-01-01T00:00:00.000Z", releasedAt: nil, creator: nil,
      artworkUrl: nil, artworkLargeUrl: nil, durationSeconds: 30, metadataState: "enriched",
      downloadState: "ready", playlistIds: [], playbackPositionSeconds: 0, listenCount: 0,
      finishCount: 0, lastListenedAt: nil)
    let player = AudioPlayer(session: .init(start: { false }, end: {}))
    defer { player.stop() }
    player.play(
      set: set, baseURL: URL(string: privateAddress)!, token: privateToken, autoplay: false)
    player.recordError(error)
    let report = player.playbackReport()
    for privateValue in [privateSetID, privateTitle, privateToken, privateAddress, localized] {
      XCTAssertFalse(report.contains(privateValue), "Report leaked \(privateValue)")
    }
    XCTAssertNoThrow(try decode(report))
  }
}
