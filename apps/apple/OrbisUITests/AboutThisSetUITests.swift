import UIKit
import XCTest

/// About This Set on the iPhone Set page (PAL-2233). A measured Set's source line names its tempo
/// and opens the sheet: short on the tempo circle and the energy card, tall with the sections. A
/// Set the node has not measured keeps the plain line, which opens nothing.
final class AboutThisSetUITests: LibraryJourney {
  private func launchWithFlagsOn(_ arguments: [String] = []) throws -> XCUIApplication {
    let service = try LaneService()
    return launchOrbis(
      address: service.address, token: service.token, arguments: ["-flags", "all-on"] + arguments)
  }

  /// Saves a Set with the lane's analysis, left 12 minutes in, inside the first section.
  private func saveMeasuredSet(title: String, video: String) throws -> String {
    let service = try LaneService()
    let set = try service.saveReadySet(
      title: title, url: "https://www.youtube.com/watch?v=\(video)")
    addTeardownBlock { try? service.removeSet(set.id) }
    try service.seedAnalysis(set.id)
    try service.setPosition(of: set.id, to: 732)
    return set.id
  }

  /// Pulls the sheet up by its title to the tall detent.
  private func pullUp(in app: XCUIApplication) {
    app.staticTexts["About This Set"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      .press(
        forDuration: 0.1,
        thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
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
    let set = try saveMeasuredSet(title: "Stay On Sight", video: "laneAbout01")

    let app = try launchWithFlagsOn()
    openSet(set, in: app)

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
    pullUp(in: app)
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

  /// Under Reduce Motion the circle stands still, and a tempo change or a hold fades rather than
  /// springs. A test cannot turn on the simulator's setting, so the app forces it. Each step
  /// exports a run of frames, the record of how it settled.
  func testUnderReduceMotionATempoChangeAndAHoldFade() throws {
    try skipUnlessPhone()
    let set = try saveMeasuredSet(title: "Stand Still", video: "laneAbout03")

    let app = try launchWithFlagsOn(["-orbisReduceMotion", "YES"])
    openSet(set, in: app)
    let line = app.buttons["detail-source-line"]
    XCTAssertTrue(
      line.waitForExistence(timeout: 20),
      "a measured Set's source line must be a button\n\(app.debugDescription)")
    line.tap()
    let tempo = app.descendants(matching: .any)["about-this-set-tempo"]
    XCTAssertTrue(
      tempo.waitForExistence(timeout: 10), "the sheet must open\n\(app.debugDescription)")
    pullUp(in: app)
    let peak = app.buttons["about-this-set-section-2"]
    XCTAssertTrue(
      peak.waitForExistence(timeout: 10),
      "the tall sheet must list the sections\n\(app.debugDescription)")
    capture("about-this-set-04-reduce-motion-before")

    // A tempo change: 140 to the Peak's 160.
    peak.tap()
    captureFrames("about-this-set-05-reduce-motion-tempo")
    XCTAssertTrue(
      waitForLabel(of: tempo, containing: "160"),
      "the circle must move to the Peak's tempo; it read \(tempo.label)")
    XCTAssertTrue(peak.isSelected, "the picked section is the current one")

    // A hold and its release.
    tempo.press(forDuration: 1.5)
    captureFrames("about-this-set-06-reduce-motion-released")
    XCTAssertTrue(tempo.exists, "releasing the circle must leave the sheet open")
    XCTAssertTrue(tempo.label.contains("160"), "the circle read \(tempo.label)")

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

  /// Six screenshots taken as fast as the simulator gives them, so a fade or a spring shows
  /// between them.
  private func captureFrames(_ name: String) {
    for frame in 1...6 { capture("\(name)-\(frame)") }
  }

  private func waitForLabel(of element: XCUIElement, containing text: String) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)
    return XCTWaiter.wait(for: [expectation], timeout: 5) == .completed
  }
}
