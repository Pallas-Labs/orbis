import XCTest

/// Sharing a Set as an Orbis Link, and opening one (ADR 0023). The lane cannot verify the
/// universal link's domain, so the journeys open the `orbis://` form, which the app routes the same
/// way.
final class OrbisLinkUITests: LibraryJourney {
  private func youtubeURL() -> String {
    let letters = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    return "https://www.youtube.com/watch?v=" + String((0..<11).map { _ in letters.randomElement()! })
  }

  private func openLink(to id: String, in app: XCUIApplication) {
    app.open(URL(string: "orbis://s/\(id)")!)
  }

  func testShareOffersTheOrbisLinkFirst() throws {
    let service = try LaneService()
    let seeded = try service.saveSet(title: "Set to share", url: youtubeURL())
    defer { _ = try? service.removeSet(seeded.id) }
    let app = try launch()
    openLibrary(in: app)

    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60), "the saved Set must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)
    XCTAssertTrue(
      app.staticTexts["detail-title"].waitForExistence(timeout: 30),
      "the row must open the Set's page\n\(app.debugDescription)")

    app.buttons["detail-actions"].tap()
    // A context menu drops the identifiers of a submenu and of a ShareLink, so the choices are
    // found by their words.
    let share = app.buttons["Share"]
    XCTAssertTrue(share.waitForExistence(timeout: 5), "the menu must offer Share\n\(app.debugDescription)")
    share.tap()
    let orbisLink = app.buttons["Orbis Link"]
    let sourceLink = app.buttons["YouTube Link"]
    XCTAssertTrue(
      orbisLink.waitForExistence(timeout: 5), "Share must offer the Orbis Link\n\(app.debugDescription)")
    XCTAssertTrue(sourceLink.exists, "Share must offer the Source Link\n\(app.debugDescription)")
    XCTAssertLessThan(orbisLink.frame.minY, sourceLink.frame.minY, "the Orbis Link comes first")
    capture("orbis-link-01-share-choice")

    orbisLink.tap()
    let address = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "orbis.p11a.xyz")).firstMatch
    XCTAssertTrue(
      address.waitForExistence(timeout: 15),
      "the share sheet must carry the Orbis Link\n\(app.debugDescription)")
    capture("orbis-link-02-share-sheet")
  }

  func testAnOrbisLinkOpensASavedSet() throws {
    let service = try LaneService()
    let seeded = try service.saveSet(title: "Set from a link", url: youtubeURL())
    defer { _ = try? service.removeSet(seeded.id) }
    let app = try launch()
    XCTAssertTrue(
      app.tabBars.buttons["Home"].waitForExistence(timeout: 60),
      "the app must open signed in\n\(app.debugDescription)")

    openLink(to: seeded.id, in: app)

    let title = app.staticTexts["detail-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 30), "the link must open the Set's page\n\(app.debugDescription)")
    XCTAssertTrue(title.label.hasPrefix("Set from a link"), title.label)
    XCTAssertTrue(app.buttons["detail-actions"].exists, "a saved Set's page offers its actions")
    XCTAssertFalse(app.buttons["linked-save"].exists, "a saved Set is not offered for saving")
    capture("orbis-link-03-opened-saved-set")
  }

  /// A friend's Set, outside this Library, opens on its shared facts with Save, and Save makes it
  /// this Library's own.
  func testAnOrbisLinkToAnotherLibrarysSetOffersSave() throws {
    let service = try LaneService()
    let friend = try LaneService.settingsPerson()
    let shared = try friend.saveSet(title: "Friend's set", url: youtubeURL())
    defer {
      _ = try? service.removeSet(shared.id)
      _ = try? friend.removeSet(shared.id)
    }
    XCTAssertNil(try service.set(id: shared.id), "the Set starts outside this Library")
    let app = try launch()
    XCTAssertTrue(
      app.tabBars.buttons["Home"].waitForExistence(timeout: 60),
      "the app must open signed in\n\(app.debugDescription)")

    openLink(to: shared.id, in: app)

    let save = app.buttons["linked-save"]
    XCTAssertTrue(
      save.waitForExistence(timeout: 30),
      "a Set outside the Library must offer Save\n\(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["detail-title"].exists, "the page names the Set")
    capture("orbis-link-04-not-saved")

    save.tap()

    XCTAssertTrue(
      app.buttons["detail-actions"].waitForExistence(timeout: 30),
      "Save must turn the page into the Set's own\n\(app.debugDescription)")
    XCTAssertFalse(save.exists, "a saved Set is not offered for saving again")
    XCTAssertNotNil(try service.set(id: shared.id), "Save must reach this Person's Library")
    capture("orbis-link-05-saved")
  }

  func testAnUnknownOrbisLinkSaysTheSetIsNotAvailable() throws {
    let app = try launch()
    XCTAssertTrue(
      app.tabBars.buttons["Home"].waitForExistence(timeout: 60),
      "the app must open signed in\n\(app.debugDescription)")

    openLink(to: UUID().uuidString.lowercased(), in: app)

    XCTAssertTrue(
      app.descendants(matching: .any)["linked-unavailable"].waitForExistence(timeout: 30),
      "an unknown Set must say it is not available\n\(app.debugDescription)")
    capture("orbis-link-06-not-available")
  }
}
