import UIKit
import XCTest

/// Every main screen in the layout the window's width gives it, while a Set plays: the tabs and the
/// column on a phone or a folded iPhone Duo, the sidebar and the wide layouts on an iPad or an
/// unfolded one. Each screen is a screenshot named after it, so one run per device or pose gives
/// the set to compare.
final class LayoutUITests: LibraryJourney {
  func testMainScreensWhileASetPlays() throws {
    try walkMainScreens(named: "layout", video: "layoutset01")
  }

  /// An iPad turned on its side: the width that gives the grids an even count and Search its
  /// column. A phone keeps its portrait run only.
  func testMainScreensInLandscape() throws {
    try XCTSkipUnless(
      UIDevice.current.userInterfaceIdiom == .pad, "landscape is an iPad pose here")
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    try walkMainScreens(named: "layout-landscape", video: "layoutland1")
  }

  /// Each pose saves its own Set, so the two runs never share one in the lane service.
  private func walkMainScreens(named prefix: String, video: String) throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Layout journey", url: "https://www.youtube.com/watch?v=\(video)")
    try service.seedTracklist(seeded.id)
    let app = try launch()
    let window = app.windows.firstMatch
    // Whether the shell opens on its tab bar or its sidebar, which the pose decides.
    try record(
      "\(prefix)-window",
      [
        "width": window.frame.width, "height": window.frame.height,
        "tabBar": app.tabBars.firstMatch.waitForExistence(timeout: 8),
      ])
    capture("\(prefix)-home")

    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    capture("\(prefix)-library")
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    play.tap()
    let detailSeek = app.sliders["detail-seek"]
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: detailSeek) { $0 > 0 }], timeout: 8), .completed)
    capture("\(prefix)-set-page")

    // Another tab, not Back: where the bars sit, and so where Back is, depends on the pose.
    selectTab("Home", in: app, sidebarIdentifier: "sidebar-home")
    let openNowPlaying = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
    ).firstMatch
    XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))
    capture("\(prefix)-mini-player")
    openNowPlaying.tap()
    let title = app.staticTexts["now-playing-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    let seek = app.sliders["now-playing-seek"]
    XCTAssertEqual(XCTWaiter.wait(for: [elapsed(on: seek) { $0 > 0 }], timeout: 6), .completed)
    capture("\(prefix)-now-playing")

    // Up Next is a sheet in the column and a segment of the panel in the split.
    app.buttons["now-playing-queue"].tap()
    let sheet = app.descendants(matching: .any)["queue-screen"]
    let panel = app.descendants(matching: .any)["now-playing-up-next"]
    let shown = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in sheet.exists || panel.exists }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 10), .completed)
    capture("\(prefix)-up-next")
    let isPanel = panel.exists
    try record(
      "\(prefix)-now-playing-layout",
      [
        "upNext": isPanel ? "panel" : "sheet",
        "width": window.frame.width, "height": window.frame.height,
      ])
    if !isPanel {
      app.buttons["queue-done"].tap()
      XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
    }
    app.buttons["now-playing-close"].tap()
    // The player stays built while the Set plays, folded into the mini player.
    XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))

    selectTab("Playlists", in: app, sidebarIdentifier: "sidebar-playlists")
    capture("\(prefix)-playlists")
    selectTab("People", in: app, sidebarIdentifier: "sidebar-people")
    capture("\(prefix)-people")
    let spot = openSearch(in: app)
    submitSearch("Layout", in: app, spot: spot)
    XCTAssertTrue(
      app.descendants(matching: .any)["search-list"].waitForExistence(timeout: 30),
      "Search must show its results\n\(app.debugDescription)")
    capture("\(prefix)-search")
  }
}
