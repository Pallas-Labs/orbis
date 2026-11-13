import UIKit
import XCTest

/// The iPhone Set page behind `set-page-v2` (PAL-2060), launched with every flag on. The journey
/// proves the controls sit directly under the words on the first screen (PAL-2293), and that the
/// sections below arrive on scroll in their order, each only when the Set has something to show.
final class SetPageV2UITests: LibraryJourney {
  private func launchWithFlagsOn() throws -> XCUIApplication {
    let service = try LaneService()
    return launchOrbis(
      address: service.address, token: service.token, arguments: ["-flags", "all-on"])
  }

  private func openSet(_ id: String, in app: XCUIApplication) {
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(id)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 60), "the seeded Set must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)
    XCTAssertTrue(
      app.staticTexts["detail-title"].waitForExistence(timeout: 30),
      "pressing a row must open the Set's page\n\(app.debugDescription)")
  }

  /// Only an iPhone draws the redesigned page; an iPad keeps today's.
  private func skipUnlessPhone() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("set-page-v2 is an iPhone page")
    }
  }

  /// The controls start just under the source line, with no empty band and no seek bar between
  /// them: Now Playing has the seek bar, and Resume shows the position.
  private func assertControlsFollowTheWords(
    play: XCUIElement, sourceLine: XCUIElement, in app: XCUIApplication,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let gap = play.frame.minY - sourceLine.frame.maxY
    XCTAssertGreaterThan(gap, 0, "Play sits below the source line", file: file, line: line)
    XCTAssertLessThan(gap, 48, "no empty band above Play: gap \(gap)", file: file, line: line)
    XCTAssertFalse(app.sliders["detail-seek"].exists, "no seek bar", file: file, line: line)
  }

  func testFirstScreenHoldsTheControlsAndTheRestFollowsOnScroll() throws {
    try skipUnlessPhone()
    let service = try LaneService()
    // The fixture names both videos' creator Kai Moreno, so the page has more from them, and gives
    // this one landscape artwork. Each is saved untitled, because a title given at save keeps the
    // service from reading the creator.
    let set = try service.saveReadySet(
      title: "", url: "https://www.youtube.com/watch?v=laneSetPg01", tags: ["house", "sunrise"])
    let other = try service.saveSet(title: "", url: "https://www.youtube.com/watch?v=laneSetPg02")
    addTeardownBlock {
      try? service.removeSet(set.id)
      try? service.removeSet(other.id)
    }
    XCTAssertEqual(try service.named(set.id)?.creator, "Kai Moreno")
    XCTAssertEqual(try service.named(other.id)?.creator, "Kai Moreno")
    // A title that repeats the creator, as many uploads do.
    try service.rename(set.id, to: "Kai Moreno - Sunrise Session")
    try service.seedTracklist(set.id)
    // A position part-way in, so Play from Beginning is offered beside Resume.
    try service.setPosition(of: set.id, to: 600)

    let app = try launchWithFlagsOn()
    openSet(set.id, in: app)
    let window = app.windows.firstMatch.frame

    // The title drops the "<creator> - " the creator line already says.
    let title = app.staticTexts["detail-title"]
    XCTAssertTrue(title.label.hasPrefix("Sunrise Session"), "title read \(title.label)")
    XCTAssertTrue(app.buttons["detail-creator"].exists, "the creator must sit under the title")
    let sourceLine = app.staticTexts["detail-source-line"]
    XCTAssertTrue(sourceLine.exists, "the source line must show")

    // Tags is an icon in the top bar, beside More.
    let tagsButton = app.navigationBars.buttons["detail-tags-button"]
    let more = app.navigationBars.buttons["detail-actions"]
    XCTAssertTrue(tagsButton.waitForExistence(timeout: 10), "\(app.debugDescription)")
    XCTAssertTrue(more.exists)
    XCTAssertLessThan(tagsButton.frame.maxX, more.frame.minX + 1, "Tags must sit before More")

    // Every control shows on the first screen, without scrolling.
    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 15), "Resume must show")
    capture("set-page-v2-01-first-screen-landscape-artwork")
    assertControlsFollowTheWords(play: play, sourceLine: sourceLine, in: app)
    let controls = [
      play,
      app.buttons["detail-play-from-beginning"],
      app.buttons["detail-queue-actions"],
      // The route picker is a system view, so it is not reported as a button.
      app.descendants(matching: .any)["airplay"],
    ]
    for control in controls {
      XCTAssertTrue(
        control.waitForExistence(timeout: 10), "\(control) must show\n\(app.debugDescription)")
      XCTAssertTrue(control.isHittable, "\(control.identifier) must be hittable without scrolling")
      XCTAssertLessThanOrEqual(control.frame.maxY, window.maxY, "\(control.identifier) on screen")
    }
    // The tab bar covers none of them.
    let tabBar = app.tabBars.firstMatch
    if tabBar.exists {
      for control in controls {
        XCTAssertLessThanOrEqual(control.frame.maxY, tabBar.frame.minY, "\(control.identifier)")
      }
    }

    // Below, in order: the Tracklist, more from the creator, the Tags, the facts.
    let tracklist = app.descendants(matching: .any)["tracklist"]
    let moreFrom = app.descendants(matching: .any)["more-from-creator"]
    let tags = app.descendants(matching: .any)["detail-tags-section"]
    let facts = app.descendants(matching: .any)["detail-facts"]
    for _ in 0..<12 where !facts.isHittable { app.swipeUp() }
    XCTAssertTrue(facts.isHittable, "the facts must end the page\n\(app.debugDescription)")
    XCTAssertTrue(tracklist.exists, "the Tracklist must show")
    XCTAssertTrue(moreFrom.exists, "More from Kai Moreno must show")
    XCTAssertTrue(app.staticTexts["More from Kai Moreno"].exists)
    XCTAssertTrue(app.buttons["more-from-creator-see-all"].exists, "the rail must offer See All")
    XCTAssertTrue(app.buttons["more-from-creator-card-\(other.id)"].exists)
    XCTAssertFalse(app.buttons["more-from-creator-card-\(set.id)"].exists, "not the Set itself")
    XCTAssertTrue(tags.exists, "a Set with Tags shows them")
    XCTAssertTrue(app.buttons["detail-tag-house"].exists)
    XCTAssertLessThan(tracklist.frame.minY, moreFrom.frame.minY)
    XCTAssertLessThan(moreFrom.frame.minY, tags.frame.minY)
    XCTAssertLessThan(tags.frame.minY, facts.frame.minY)
    capture("set-page-v2-02-scrolled")

    // See All shows the creator's Sets in the Library.
    app.buttons["more-from-creator-see-all"].tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["creator-filter"].waitForExistence(timeout: 15),
      "See All must filter the Library by the creator\n\(app.debugDescription)")
    capture("set-page-v2-03-see-all")
  }

  func testASetWithNothingMoreSaysNothingAndOffersFindTracklist() throws {
    try skipUnlessPhone()
    let service = try LaneService()
    let set = try service.saveReadySet(
      title: "", url: "https://www.youtube.com/watch?v=laneSetPg03")
    addTeardownBlock { try? service.removeSet(set.id) }
    XCTAssertEqual(try service.named(set.id)?.creator, "Lone Creator")
    try service.seedNoTracklist(set.id)
    XCTAssertEqual(try service.set(id: set.id)?.tracklistState, "none")

    let app = try launchWithFlagsOn()
    openSet(set.id, in: app)
    // The fixture gives this Set portrait artwork. The controls still follow the words.
    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 15), "Play must show")
    capture("set-page-v2-06-first-screen-portrait-artwork")
    assertControlsFollowTheWords(
      play: play, sourceLine: app.staticTexts["detail-source-line"], in: app)
    XCTAssertTrue(play.isHittable, "Play must show without scrolling")
    for _ in 0..<6 { app.swipeUp() }

    // No Tracklist, no other Sets by the creator, and no Tags: the page says nothing of them.
    XCTAssertTrue(app.descendants(matching: .any)["detail-facts"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["No tracklist found"].exists)
    XCTAssertFalse(app.buttons["tracklist-refresh"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["more-from-creator"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["detail-tags-section"].exists)
    capture("set-page-v2-04-nothing-more")

    // More asks for the Tracklist instead.
    app.navigationBars.buttons["detail-actions"].tap()
    let find = app.buttons["detail-find-tracklist"]
    XCTAssertTrue(find.waitForExistence(timeout: 5), "More must offer Find Tracklist")
    capture("set-page-v2-05-find-tracklist")
    find.tap()
    XCTAssertFalse(
      app.staticTexts["detail-error"].waitForExistence(timeout: 5),
      "asking for the Tracklist must not fail\n\(app.debugDescription)")
  }
}
