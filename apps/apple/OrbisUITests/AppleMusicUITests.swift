import XCTest

/// Apple Music Sets (ADR 0021): saving an album from Add Set, and playing one without access. The
/// lane's service reads each album from the recorded Apple Music answers in
/// `apps/server/src/fixtures/apple-music`, which `scripts/fixture.ts` serves.
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

  /// An Apple Music Set on a device that cannot play it. MusicKit does not play in the simulator,
  /// and the simulator has no Apple Music subscription, so the journey proves the path a Person
  /// without access or a subscription takes: the page offers Play, the first Play asks for Apple
  /// Music access, and once the answer is no, the page shows the Tracklist and Open in Apple Music
  /// instead of Play. Playing a real mix is the device check on the issue.
  func testAnAppleMusicSetAsksOnFirstPlayThenOffersOpenInAppleMusic() throws {
    // The lane's second Person plays this one. The Search and Filter journeys look for the
    // host's seeded Set near the top of the host's Library, which every journey in the run shares.
    let service = try LaneService.settingsPerson()
    let seeded = try service.saveAppleMusicSet(title: "Apple Music DJ mix")
    addTeardownBlock { try? service.removeSet(seeded.id) }
    // Every run asks afresh, whatever an earlier run answered on this simulator.
    XCUIApplication().resetAuthorizationStatus(for: .mediaLibrary)
    let app = launchOrbis(address: service.address, token: service.token)
    openLibrary(in: app)

    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 60),
      "the saved Apple Music Set must appear in the Library\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(
      play.waitForExistence(timeout: 30),
      "an Apple Music Set offers Play before Apple Music access is asked\n\(app.debugDescription)")
    XCTAssertFalse(
      app.descendants(matching: .any)["detail-download"].exists,
      "an Apple Music Set never offers Download")
    let thirdSong = app.descendants(matching: .any)["cue-2"]
    XCTAssertTrue(
      thirdSong.waitForExistence(timeout: 30),
      "the page shows the album's songs as the Tracklist\n\(app.debugDescription)")
    capture("apple-music-play-01-set-page")

    play.tap()
    // The system asks for Apple Music access. The answer is no, as for a Person who refuses; a
    // simulator that answers without asking reads as no subscription and lands in the same place.
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let refuse = springboard.alerts.buttons.matching(
      NSPredicate(format: "label BEGINSWITH 'Don'")
    ).firstMatch
    var asked = false
    if refuse.waitForExistence(timeout: 15) {
      asked = true
      capture("apple-music-play-02-access-prompt")
      refuse.tap()
    }

    let open = app.buttons["detail-open-apple-music"]
    XCTAssertTrue(
      open.waitForExistence(timeout: 30),
      "without access the page offers Open in Apple Music\n\(app.debugDescription)")
    XCTAssertFalse(play.exists, "without access the page offers no Play")
    XCTAssertTrue(app.staticTexts["detail-apple-music-note"].exists, "the page says why")
    XCTAssertTrue(thirdSong.exists, "the Tracklist stays on the page")
    capture("apple-music-play-03-open-in-apple-music")
    try record("apple-music-journey", ["setId": seeded.id, "askedForAccess": asked])
  }
}
