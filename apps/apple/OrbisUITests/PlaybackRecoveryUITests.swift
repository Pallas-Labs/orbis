import XCTest

final class PlaybackRecoveryUITests: LibraryJourney {
  func testDetailPlayRetriesAFailedAudioItem() throws {
    try recoverPlayback(on: .detail, sourceId: "retrydet001")
  }

  func testNowPlayingPlayRetriesAFailedAudioItem() throws {
    try recoverPlayback(on: .nowPlaying, sourceId: "retrynow001")
  }

  private enum Surface: String {
    case detail
    case nowPlaying = "now-playing"
  }

  private func recoverPlayback(on surface: Surface, sourceId: String) throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Retry \(surface.rawValue)", url: "https://www.youtube.com/watch?v=\(sourceId)")
    try service.markAudioUnavailable(seeded.id)
    XCTAssertEqual(try service.audioState(seeded.id).state, "ready")
    let app = try launch()
    var observations: [[String: Any]] = []
    defer {
      capture("\(surface.rawValue)-retry-final")
      do {
        try record(
          "\(surface.rawValue)-retry",
          ["setId": seeded.id, "surface": surface.rawValue, "observations": observations])
      } catch {
        XCTFail("Could not record playback retry observations: \(error)")
      }
    }
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    tapAtCentre(of: row, in: app)
    let detailPlay = app.buttons["detail-play-toggle"]
    XCTAssertTrue(detailPlay.waitForExistence(timeout: 30))
    detailPlay.tap()
    let failure = app.staticTexts["This audio would not play."]
    XCTAssertTrue(failure.waitForExistence(timeout: 30), "The unavailable file must fail playback")
    capture("\(surface.rawValue)-retry-failed-item")

    switch surface {
    case .detail:
      break
    case .nowPlaying:
      app.navigationBars.buttons.firstMatch.tap()
      let openNowPlaying = app.buttons.matching(
        NSPredicate(
          format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
      ).firstMatch
      XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))
      openNowPlaying.tap()
      XCTAssertTrue(app.staticTexts["now-playing-title"].waitForExistence(timeout: 10))
      XCTAssertTrue(failure.waitForExistence(timeout: 5))
    }

    let seek = app.sliders["\(surface.rawValue)-seek"]
    XCTAssertTrue(seek.waitForExistence(timeout: 10))
    let beforeRetry = Self.elapsedSeconds(seek.value as? String) ?? 0
    observations.append([
      "phase": "failed", "elapsedSeconds": beforeRetry, "failureVisible": failure.exists,
    ])
    try service.restoreReadyAudio(seeded.id)
    let play = app.buttons["\(surface.rawValue)-play-toggle"]
    XCTAssertEqual(play.label, "Play")
    play.tap()
    let firstAdvance = XCTWaiter.wait(
      for: [elapsed(on: seek) { $0 > beforeRetry }], timeout: 12)
    let resumedAt = Self.elapsedSeconds(seek.value as? String) ?? -1
    observations.append([
      "phase": "after-retry", "elapsedSeconds": resumedAt, "failureVisible": failure.exists,
    ])
    XCTAssertEqual(firstAdvance, .completed, "Retry must replace the failed item and play audio")
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { $0 >= resumedAt + 2 }], timeout: 8),
      .completed, "The recovered playback timeline must keep advancing")
    observations.append([
      "phase": "advancing", "elapsedSeconds": Self.elapsedSeconds(seek.value as? String) ?? -1,
      "failureVisible": failure.exists,
    ])
    XCTAssertFalse(failure.exists, "A successful retry must clear the playback failure")
    XCTAssertEqual(play.label, "Pause")
    capture("\(surface.rawValue)-retry-playing")
    play.tap()
    XCTAssertEqual(play.label, "Play")
  }

}
