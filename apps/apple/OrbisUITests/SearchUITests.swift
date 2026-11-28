import XCTest

/// Browsing and searching the Library.
final class SearchUITests: LibraryJourney {
  func testBrowsesAndSearchesTheLibrary() throws {
    let own = try saveOwnSet("Browse")
    let app = try launch()
    openLibrary(in: app)

    let row = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", own.title)).firstMatch
    XCTAssertTrue(
      row.waitForExistence(timeout: 60), "a saved Set must appear\n\(app.debugDescription)")
    capture("02-library-loaded")

    let searchSpot = openSearch(in: app)
    submitSearch(own.word, in: app, spot: searchSpot)
    XCTAssertTrue(row.waitForExistence(timeout: 30), "search must find the Set")
    capture("03-search-results")

    submitSearch("zzzznothing", in: app, spot: searchSpot)
    XCTAssertTrue(
      noResults(in: app).waitForExistence(timeout: 30),
      "an unmatched search must say so\n\(app.debugDescription)")
    capture("04-search-no-results")
  }

  /// A Set found by search is the reason to search, so the result has to open. The Library row
  /// in the same component opens the same page, on the same build, in the same pass.
  func testOpensASetFromASearchResult() throws {
    let own = try saveOwnSet("Result")
    let app = try launch()

    let spot = openSearch(in: app)
    submitSearch(own.word, in: app, spot: spot)

    let heading = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Results for")).firstMatch
    XCTAssertTrue(
      heading.waitForExistence(timeout: 30),
      "a submitted search must name the query it answers\n\(app.debugDescription)")

    let result = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", own.title)).firstMatch
    XCTAssertTrue(
      result.waitForExistence(timeout: 30),
      "search must list the Set it found\n\(app.debugDescription)")
    tapAtCentre(of: result, in: app)

    let title = app.staticTexts["detail-title"].firstMatch
    XCTAssertTrue(
      title.waitForExistence(timeout: 30),
      "a search result must open the Set's page\n\(app.debugDescription)")
    // The page names the Set twice: the header carries the title with its source, and the
    // title stands alone under it. Either identifies the Set that was opened.
    XCTAssertTrue(
      title.label.contains(own.title),
      "the page must show the Set that was opened, not another one: \(title.label)")
    capture("13-search-result-open")

    // The results and the query are where the person left them, so returning is not a reset.
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(
      heading.waitForExistence(timeout: 20),
      "returning from the page must keep the results\n\(app.debugDescription)")
    XCTAssertEqual(searchText(in: app), own.word, "returning must keep the query")
  }

  /// The sidebar lists each Playlist as a tab of its own. On an iPhone those tabs once reached
  /// the tab bar, which then held six and put Search under More, so Search went missing for
  /// anyone with a Playlist (PAL-2443).
  func testSearchStaysInTheTabBarWithAPlaylist() throws {
    let service = try LaneService()
    let name = "Tab bar \(UUID().uuidString.prefix(6))"
    let playlist = try service.createPlaylist(named: name)
    addTeardownBlock { try? service.deletePlaylist(playlist.id) }
    let app = try launch()

    let bar = app.tabBars.firstMatch
    guard bar.waitForExistence(timeout: 15) else {
      throw XCTSkip("this device shows a sidebar, not a tab bar")
    }
    // The Playlists load after the bar first draws, so the check waits until this one shows.
    selectTab("Playlists", in: app, sidebarIdentifier: "sidebar-playlists")
    let shown = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
    XCTAssertTrue(
      shown.waitForExistence(timeout: 30), "Playlists must list the new one\n\(app.debugDescription)")
    capture("16-tab-bar-with-a-playlist")
    XCTAssertTrue(
      bar.buttons["Search"].exists, "Search must stay in the tab bar\n\(app.debugDescription)")
    XCTAssertFalse(
      bar.buttons["More"].exists, "the tab bar must not overflow into More")
  }

  /// Clearing a search that found nothing is the one way out of the no-match state, so it has
  /// to empty the field and return the screen to the state it shows before any query. It once
  /// left the query in the field and the result area on Loading, forever.
  func testClearsANoMatchSearch() throws {
    let app = try launch()

    let spot = openSearch(in: app)
    submitSearch("zzzznothing", in: app, spot: spot)
    XCTAssertTrue(
      noResults(in: app).waitForExistence(timeout: 30),
      "an unmatched search must say so\n\(app.debugDescription)")

    app.buttons["Clear search"].tap()

    XCTAssertTrue(
      untouchedSearch(in: app).waitForExistence(timeout: 20),
      "clearing must return to the state before any query\n\(app.debugDescription)")
    XCTAssertFalse(noResults(in: app).exists, "the no-match state goes with the query")
    XCTAssertEqual(searchText(in: app), "", "clearing must empty the field")
    XCTAssertFalse(
      app.descendants(matching: .any).matching(identifier: "library-loading").firstMatch.exists,
      "clearing must not leave a loading state behind")
    capture("14-search-cleared")
  }
}
