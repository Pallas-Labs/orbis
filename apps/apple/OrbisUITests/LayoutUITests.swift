import XCTest

/// Every main screen in the layout the window's width gives it, while a Set plays: the tabs and the
/// column on a phone or a folded iPhone Duo, the sidebar and the wide layouts on an iPad or an
/// unfolded one. Each screen is a screenshot named after it, so one run per device or pose gives
/// the set to compare.
final class LayoutUITests: LibraryJourney {
  func testMainScreensWhileASetPlays() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Layout journey", url: "https://www.youtube.com/watch?v=layoutset01")
    try service.seedTracklist(seeded.id)
    let app = try launch()
    let window = app.windows.firstMatch
    try record("window", ["width": window.frame.width, "height": window.frame.height])
    capture("layout-home")

    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    capture("layout-library")
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    play.tap()
    let detailSeek = app.sliders["detail-seek"]
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: detailSeek) { $0 > 0 }], timeout: 8), .completed)
    capture("layout-set-page")

    app.navigationBars.buttons.firstMatch.tap()
    let openNowPlaying = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
    ).firstMatch
    XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))
    capture("layout-mini-player")
    openNowPlaying.tap()
    let title = app.staticTexts["now-playing-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    let seek = app.sliders["now-playing-seek"]
    XCTAssertEqual(XCTWaiter.wait(for: [elapsed(on: seek) { $0 > 0 }], timeout: 6), .completed)
    capture("layout-now-playing")

    // Up Next is a sheet in the column and a segment of the panel in the split.
    app.buttons["now-playing-queue"].tap()
    let sheet = app.descendants(matching: .any)["queue-screen"]
    let panel = app.descendants(matching: .any)["now-playing-up-next"]
    let shown = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in sheet.exists || panel.exists }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 10), .completed)
    capture("layout-up-next")
    let isPanel = panel.exists
    try record(
      "now-playing-layout",
      [
        "upNext": isPanel ? "panel" : "sheet",
        "width": window.frame.width, "height": window.frame.height,
      ])
    if !isPanel {
      app.buttons["queue-done"].tap()
      XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
    }
    app.buttons["now-playing-close"].tap()
    XCTAssertTrue(title.waitForNonExistence(timeout: 10))

    selectTab("Playlists", in: app, sidebarIdentifier: "sidebar-playlists")
    capture("layout-playlists")
    selectTab("People", in: app, sidebarIdentifier: "sidebar-people")
    capture("layout-people")
    let spot = openSearch(in: app)
    submitSearch("Layout", in: app, spot: spot)
    XCTAssertTrue(
      app.descendants(matching: .any)["search-list"].waitForExistence(timeout: 30),
      "Search must show its results\n\(app.debugDescription)")
    capture("layout-search")
  }
}
