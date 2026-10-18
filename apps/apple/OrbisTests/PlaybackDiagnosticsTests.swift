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

  func testRoutineSamplesRetainAnIncidentAndFullSnapshotsStayBounded() throws {
    var snapshot = PlaybackDiagnostics.Snapshot()
    snapshot.state = .playing
    snapshot.itemState = .ready
    snapshot.actualTime = .init(123.456)
    snapshot.displayedTime = .init(123.456)
    snapshot.duration = .init(7_200)
    snapshot.rate = .init(1)
    snapshot.sessionReady = true
    snapshot.bufferRanges = (0..<8).map {
      .init(start: .init(Double($0) * 20.123456), duration: .init(10.123456))
    }
    snapshot.access = .init(
      bytesTransferred: 1_234_567, transferDuration: .init(12.3456),
      observedBitrate: .init(128_000.123), indicatedBitrate: .init(128_000),
      stalls: 1, downloadedDuration: .init(120.1234))

    let incidents = PlaybackDiagnostics()
    incidents.record(
      .discontinuity(.init(mediaDelta: .init(-1), wallDelta: .init(0.5), rate: .init(1), gap: .init(-1.5))),
      snapshot: snapshot)
    for _ in 0..<300 { incidents.record(.sample, snapshot: snapshot) }
    let incidentReport = try decode(incidents.report(current: snapshot))
    XCTAssertTrue(
      incidentReport.entries.contains { if case .discontinuity = $0.event { true } else { false } },
      "Routine samples must not evict the incident")

    let full = PlaybackDiagnostics()
    for index in 0..<256 {
      full.record(.command(.init(kind: .seek, origin: .app, target: .init(Double(index)))), snapshot: snapshot)
    }
    let text = full.report(current: snapshot)
    let report = try decode(text)
    XCTAssertLessThanOrEqual(text.utf8.count, PlaybackDiagnostics.reportByteLimit)
    XCTAssertLessThanOrEqual(report.entries.count, PlaybackDiagnostics.retainedEntryLimit)
    XCTAssertEqual(report.entries.last?.sequence, 256)
    let attachment = XCTAttachment(data: Data(text.utf8), uniformTypeIdentifier: "public.json")
    attachment.name = "full-playback-report-\(report.entries.count)-entries-\(text.utf8.count)-bytes"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
