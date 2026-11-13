import UIKit
import XCTest

/// About This Set on the iPhone Set page (PAL-2233). A measured Set's source line names its tempo
/// and opens the sheet: short on the tempo circle and the energy card, tall with the sections. A
/// Set the node has not measured keeps the plain line, which opens nothing.
final class AboutThisSetUITests: LibraryJourney {
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

  /// Only an iPhone draws the Set page that carries the sheet; an iPad keeps today's.
  private func skipUnlessPhone() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("About This Set opens from the iPhone Set page")
    }
  }

  func testAMeasuredSetOpensAboutThisSetAtBothHeights() throws {
    try skipUnlessPhone()
    let service = try LaneService()
    let set = try service.saveReadySet(
      title: "Stay On Sight", url: "https://www.youtube.com/watch?v=laneAbout01")
    addTeardownBlock { try? service.removeSet(set.id) }
    try service.seedAnalysis(set.id)
    // Left 12 minutes in, inside the first section.
    try service.setPosition(of: set.id, to: 732)

    let app = try launchWithFlagsOn()
    openSet(set.id, in: app)

    // The line names the median tempo and opens the sheet.
    let line = app.buttons["detail-source-line"]
    XCTAssertTrue(
      line.waitForExistence(timeout: 20),
      "a measured Set's source line must be a button\n\(app.debugDescription)")
    XCTAssertTrue(line.label.contains("140 BPM"), "the line read \(line.label)")
    line.tap()

    // Short: the title, the tempo circle at the first section's tempo, and the energy card.
    let tempo = app.descendants(matching: .any)["about-this-set-tempo"]
    XCTAssertTrue(
      tempo.waitForExistence(timeout: 10), "the sheet must open\n\(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["About This Set"].exists)
    XCTAssertTrue(app.buttons["about-this-set-close"].exists)
    XCTAssertTrue(tempo.label.contains("140"), "the circle read \(tempo.label)")
    let energy = app.descendants(matching: .any)["about-this-set-energy"]
    XCTAssertTrue(energy.exists, "the energy card must show")
    XCTAssertTrue(energy.label.contains("Loud, even"), "the energy card read \(energy.label)")
    XCTAssertTrue(energy.label.contains("-13.5 LUFS"), "the energy card read \(energy.label)")
    let peak = app.buttons["about-this-set-section-2"]
    XCTAssertFalse(peak.exists, "the sections wait for the tall sheet")
    capture("about-this-set-01-short")

    // Tall: pulled up, the sections fade in below.
    let title = app.staticTexts["About This Set"]
    title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      .press(
        forDuration: 0.1,
        thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
    XCTAssertTrue(
      peak.waitForExistence(timeout: 10),
      "the tall sheet must list the sections\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["about-this-set-section-0"].isSelected, "the Set sits in Locked in")
    XCTAssertTrue(peak.label.contains("Peak"), "the third section read \(peak.label)")
    XCTAssertTrue(peak.label.contains("160 BPM"), "the third section read \(peak.label)")

    // Tapping a section moves the circle to its tempo.
    peak.tap()
    XCTAssertTrue(
      waitForLabel(of: tempo, containing: "160"),
      "the circle must move to the Peak's tempo; it read \(tempo.label)")
    XCTAssertTrue(peak.isSelected, "the picked section is the current one")
    capture("about-this-set-02-tall")

    app.buttons["about-this-set-close"].tap()
    XCTAssertTrue(tempo.waitForNonExistence(timeout: 10), "Close must dismiss the sheet")
  }

  func testASetWithNoAnalysisKeepsAPlainLine() throws {
    try skipUnlessPhone()
    let service = try LaneService()
    let set = try service.saveReadySet(
      title: "Not Yet Measured", url: "https://www.youtube.com/watch?v=laneAbout02")
    addTeardownBlock { try? service.removeSet(set.id) }

    let app = try launchWithFlagsOn()
    openSet(set.id, in: app)

    let line = app.staticTexts["detail-source-line"]
    XCTAssertTrue(line.waitForExistence(timeout: 20), "the source line must show")
    XCTAssertFalse(line.label.contains("BPM"), "the line read \(line.label)")
    XCTAssertFalse(app.buttons["detail-source-line"].exists, "the line is not a button")
    line.tap()
    XCTAssertFalse(
      app.descendants(matching: .any)["about-this-set-tempo"].waitForExistence(timeout: 3),
      "the line must open nothing\n\(app.debugDescription)")
    capture("about-this-set-03-no-analysis")
  }

  private func waitForLabel(of element: XCUIElement, containing text: String) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)
    return XCTWaiter.wait(for: [expectation], timeout: 5) == .completed
  }
}
