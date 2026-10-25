import XCTest

/// Saving an Apple Music album from Add Set. The lane's service reads the album from the recorded
/// Apple Music answers in `apps/server/src/fixtures/apple-music`, which `scripts/fixture.ts` serves.
final class AppleMusicUITests: LibraryJourney {
  private static let link = "https://music.apple.com/us/album/dj-kicks-dj-mix/1046502556"
  private static let title = "DJ-Kicks (DJ Mix)"

  func testAddSetSavesAnAppleMusicAlbumWithItsTracklist() throws {
    let service = try LaneService()
    let app = try launch()
    openLibrary(in: app)

    let file = app.buttons["library-file"]
    XCTAssertTrue(file.waitForExistence(timeout: 60), "the Library must offer File a set\n\(app.debugDescription)")
    file.tap()
    let field = app.textFields["Paste a link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "Add Set must open with the paste field")
    tapAtCentre(of: field, in: app)
    field.typeText(Self.link)
    let fileIt = app.buttons["File it"]
    let enabled = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND enabled == true"), object: fileIt)
    XCTAssertEqual(
      XCTWaiter.wait(for: [enabled], timeout: 15), .completed,
      "an Apple Music link must enable File it\n\(app.debugDescription)")
    capture("apple-music-01-link")
    fileIt.tap()

    // The service read the album during the save, so the naming step already has its title.
    let titleField = app.textFields["reveal-title"]
    XCTAssertTrue(
      titleField.waitForExistence(timeout: 60), "filing must open the naming step\n\(app.debugDescription)")
    let named = titleField.value as? String
    XCTAssertEqual(named, Self.title, "the naming step must show the album's title")
    capture("apple-music-02-naming-step")
    app.buttons["reveal-dismiss"].tap()
    XCTAssertTrue(
      app.staticTexts["file-confirmation"].waitForExistence(timeout: 30),
      "leaving the naming step must say what was filed\n\(app.debugDescription)")
    app.buttons["Close"].firstMatch.tap()

    let saved = try XCTUnwrap(
      try service.library().first { $0.title == Self.title }, "the service must keep the album as a Set")
    let row = app.descendants(matching: .any)["set-row-\(saved.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30), "the saved Set must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)

    let heading = app.staticTexts["detail-title"]
    XCTAssertTrue(heading.waitForExistence(timeout: 30), "a row must open the Set's page\n\(app.debugDescription)")
    // The heading reads the title with its Source stamp.
    XCTAssertEqual(heading.label, "\(Self.title), Apple Music")
    let tracklist = app.descendants(matching: .any)["tracklist"]
    XCTAssertTrue(
      tracklist.waitForExistence(timeout: 30), "the album's songs must be the Tracklist\n\(app.debugDescription)")
    let firstCue = app.descendants(matching: .any)["cue-0"]
    XCTAssertTrue(firstCue.waitForExistence(timeout: 15), "the Tracklist must list the first song")
    XCTAssertFalse(app.buttons["detail-download"].exists, "an Apple Music Set must not offer Download")
    XCTAssertFalse(app.buttons["detail-retry-download"].exists, "an Apple Music Set must not offer Download")
    capture("apple-music-03-set-page")

    try record(
      "apple-music-add-set",
      [
        "link": Self.link,
        "namingStepTitle": named ?? "",
        "setId": saved.id,
        "pageTitle": heading.label,
        "firstCue": firstCue.label,
        "offersDownload": app.buttons["detail-download"].exists,
      ])
  }
}
