import XCTest

/// Importing a YouTube playlist from the Add Set sheet. The lane's service reads it from the fake
/// Data API in `scripts/fixture.ts`: 60 entries over two pages, one of which YouTube no longer
/// serves. The second page answers late, so the import is seen part-way.
final class PlaylistImportUITests: PlaylistJourney {
  private static let laneMix = "https://music.youtube.com/playlist?list=PLorbisLaneMix"
  private static let laneMixTitles =
    ["Sunrise on the Pier", "Low Tide Dub", "Night Ferry", "Salt and Static", "Last Light Session"]
    + (6...59).map { "Lane Track \(String(format: "%04d", $0))" }
  private static let midway = "Importing 50 of 60"

  func testPastingAPlaylistImportsItAndOpensIt() throws {
    let service = try LaneService()
    let before = Set(try service.playlists().map(\.id))
    let app = launchOrbis(address: service.address, token: service.token)

    submit(Self.laneMix, in: app)
    let progress = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", Self.midway)).firstMatch
    XCTAssertTrue(
      progress.waitForExistence(timeout: 30),
      "a running import must count the playlist's entries\n\(app.debugDescription)")
    capture("import-02-progress")
    let progressLabel = progress.label

    let summary = app.descendants(matching: .any)["import-summary"]
    XCTAssertTrue(
      summary.waitForExistence(timeout: 60), "an import must end on its summary\n\(app.debugDescription)")
    XCTAssertTrue(summary.label.hasPrefix("Lane Mix"), "the summary must name the playlist: \(summary.label)")
    XCTAssertTrue(summary.label.hasSuffix("59 sets added"), "the summary must count the Sets: \(summary.label)")
    let skipped = app.descendants(matching: .any)["import-note-unavailable"]
    XCTAssertTrue(skipped.exists, "the track YouTube no longer serves must be reported")
    XCTAssertFalse(
      app.descendants(matching: .any)["import-note-over-limit"].exists, "no line is shown for a count of zero")
    // The count rolls up and the tiles land in under half a second.
    usleep(800_000)
    capture("import-03-summary")

    let created = try XCTUnwrap(
      try service.playlists().first { !before.contains($0.id) }, "the import must create a Playlist")
    let stored = try service.members(of: created.id).map(\.title)
    XCTAssertEqual(stored, Self.laneMixTitles, "the Playlist must keep the playlist's order")

    let summaryLabel = summary.label
    let skippedLabel = skipped.label
    app.buttons["import-open"].tap()
    // The rows load lazily, so the page's own count stands for the ones below the fold.
    let heading = app.staticTexts
      .matching(NSPredicate(format: "label BEGINSWITH %@", "59 sets")).firstMatch
    XCTAssertTrue(
      heading.waitForExistence(timeout: 30), "Open Playlist must open the new Playlist\n\(app.debugDescription)")
    let firstRow = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "playlist-member-")).firstMatch
    XCTAssertTrue(firstRow.waitForExistence(timeout: 30), "the imported Sets must be listed")
    XCTAssertTrue(app.staticTexts[Self.laneMixTitles[0]].exists, "the first track must lead the list")
    capture("import-04-playlist")

    try record(
      "playlist-import",
      [
        ["step": "progress", "label": progressLabel],
        ["step": "summary", "label": summaryLabel, "skippedNote": skippedLabel],
        [
          "step": "stored", "playlist": created.name, "count": stored.count,
          "first": stored.prefix(5).joined(separator: "|"),
        ],
        ["step": "opened", "heading": heading.label, "firstRow": firstRow.label],
      ])
  }

  func testAPrivatePlaylistSaysWhyAndOffersARetry() throws {
    let app = try launch()

    submit("https://www.youtube.com/playlist?list=PLprivateLane", in: app)
    let explanation = app.staticTexts
      .matching(NSPredicate(format: "label CONTAINS %@", "This playlist is private or no longer exists")).firstMatch
    XCTAssertTrue(
      explanation.waitForExistence(timeout: 60),
      "a private playlist must say why it cannot be imported\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["import-retry"].exists, "a failed import must offer Try Again")
    capture("import-05-private")
  }

  /// The Playlists screen's Import Playlist hosts the same import. Closing the sheet part-way
  /// leaves the import running: its Playlist shows the progress, and the sheet shows the summary
  /// when it opens again.
  func testImportPlaylistFromThePlaylistsScreen() throws {
    let app = try launch()
    openPlaylists(in: app)
    let entry = app.buttons["playlist-import"]
    XCTAssertTrue(entry.waitForExistence(timeout: 30), "Playlists must offer Import Playlist\n\(app.debugDescription)")
    entry.tap()
    let field = app.textFields["Paste a link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "Import Playlist must open with the paste field")
    tapAtCentre(of: field, in: app)
    field.typeText(Self.laneMix)
    app.buttons["Import"].tap()

    let progress = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", Self.midway)).firstMatch
    XCTAssertTrue(
      progress.waitForExistence(timeout: 30), "the sheet must show the import's progress\n\(app.debugDescription)")
    app.buttons["Close"].firstMatch.tap()
    let rowProgress = app.descendants(matching: .any)["playlist-import-progress"]
    XCTAssertTrue(
      rowProgress.waitForExistence(timeout: 10),
      "closing the sheet must leave the import running on its Playlist\n\(app.debugDescription)")
    let rowLabel = rowProgress.label
    capture("import-06-row-progress")

    entry.tap()
    let summary = app.descendants(matching: .any)["import-summary"]
    XCTAssertTrue(
      summary.waitForExistence(timeout: 60),
      "the reopened sheet must end on the import's summary\n\(app.debugDescription)")
    XCTAssertTrue(summary.label.hasSuffix("59 sets added"), "the summary must count the Sets: \(summary.label)")
    usleep(800_000)
    capture("import-07-from-playlists")
    let summaryLabel = summary.label
    let name = String(summaryLabel.split(separator: ",")[0])

    app.buttons["import-done"].tap()
    let row = app.descendants(matching: .any)["playlist-row-\(name)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 30), "Done must leave the new Playlist listed\n\(app.debugDescription)")
    XCTAssertFalse(summary.exists, "Done must close the sheet")
    XCTAssertFalse(rowProgress.exists, "a finished import shows no progress on its Playlist")
    capture("import-08-playlists-after-done")

    try record(
      "playlist-import-closed-midway",
      [
        ["step": "row", "label": rowLabel],
        ["step": "summary", "label": summaryLabel],
      ])
  }

  /// Opens Add Set from Home, types the link, and presses Import.
  private func submit(_ link: String, in app: XCUIApplication) {
    let file = app.buttons["home-file"]
    XCTAssertTrue(file.waitForExistence(timeout: 60), "Home must offer File a set\n\(app.debugDescription)")
    file.tap()
    let field = app.textFields["Paste a link"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "Add Set must open with the paste field")
    tapAtCentre(of: field, in: app)
    field.typeText(link)
    let importButton = app.buttons["Import"]
    let enabled = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND enabled == true"), object: importButton)
    XCTAssertEqual(
      XCTWaiter.wait(for: [enabled], timeout: 15), .completed,
      "a playlist link must turn File it into Import\n\(app.debugDescription)")
    capture("import-01-link")
    importButton.tap()
  }
}
