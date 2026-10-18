import XCTest

final class PlaybackReportUITests: LibraryJourney {
  func testSettingsCopiesAPlaybackReport() throws {
    let app = try launch()
    let settings = app.buttons["settings-open"].firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 30), "Home must offer Settings")
    settings.tap()

    let copy = app.buttons["settings-copy-playback-report"]
    var swipes = 0
    while !(copy.exists && copy.isHittable), swipes < 8 {
      app.swipeUp()
      swipes += 1
    }
    XCTAssertTrue(copy.exists && copy.isHittable, "Settings must offer the playback report action")
    copy.tap()
    XCTAssertTrue(
      app.buttons["settings-copy-playback-report"].waitForExistence(timeout: 5),
      "The copy action must remain available")
    XCTAssertEqual(app.buttons["settings-copy-playback-report"].label, "Copied")
    capture("settings-playback-report-copied")
  }
}
