import XCTest

/// Find on Apple Music in Add Set. The lane's service answers from the Apple Music searches and
/// albums recorded in `apps/server/src/fixtures/apple-music`, through the fake in
/// `scripts/fixture.ts`, so nothing reaches Apple. "Radiohead" finds four DJ mixes ahead of the
/// band's own albums.
final class AppleMusicSearchUITests: XCTestCase {
  private static let firstMix = "Boiler Room: Thom Yorke in London, Oct 11, 2011 (DJ Mix)"
  private static let mixes = [
    firstMix,
    "Tomorrowland Around The World 2020: Lost Frequencies (DJ Mix)",
    "Tomorrowland Around The World 2020: Alan Walker (DJ Mix)",
    "LXM Festival: Paul Kalkbrenner in Lisbon, Dec 14, 2019 (DJ Mix)",
  ]
  private static let studioAlbum = "OK Computer"

  func testSearchingShowsDJMixesFirstAndSavesTheChosenOne() throws {
    let service = try LaneService()
    let app = launchOrbis(address: service.address, token: service.token)

    let file = app.buttons["home-file"]
    XCTAssertTrue(file.waitForExistence(timeout: 60), "Home must offer File a set\n\(app.debugDescription)")
    file.tap()
    let field = app.textFields["apple-music-field"]
    XCTAssertTrue(
      field.waitForExistence(timeout: 15), "Add Set must offer Find on Apple Music\n\(app.debugDescription)")
    field.tap()
    field.typeText("Radiohead\n")

    XCTAssertTrue(
      app.buttons[Self.firstMix].waitForExistence(timeout: 30),
      "the search must list the first DJ mix\n\(app.debugDescription)")
    let djMixes = resultLabels(in: app, atLeast: Self.mixes.count + 1)
    XCTAssertEqual(djMixes, Self.mixes, "by default the search shows only DJ mixes, in Apple's order")
    scrollToTop(of: app, showing: app.buttons[Self.firstMix])
    capture("apple-music-01-dj-mixes")

    app.buttons[Self.firstMix].tap()
    let titleField = app.textFields["reveal-title"]
    XCTAssertTrue(
      titleField.waitForExistence(timeout: 30), "choosing a result must save it as a Set\n\(app.debugDescription)")
    XCTAssertEqual(titleField.value as? String, Self.firstMix, "the Set must carry the album's title")
    capture("apple-music-02-saved-set")

    let saved = try XCTUnwrap(
      try service.library().first { $0.title == Self.firstMix }, "the service must hold the chosen album")
    XCTAssertEqual(saved.source, "apple-music")
    XCTAssertEqual(saved.metadataState, "enriched")
    XCTAssertTrue(
      saved.url.hasPrefix("https://music.apple.com/album/"), "the Set must keep the album's Source Link: \(saved.url)")

    app.buttons["reveal-dismiss"].tap()
    let marked = app.buttons[Self.firstMix]
    XCTAssertTrue(marked.waitForExistence(timeout: 15), "the results must stay after the save\n\(app.debugDescription)")
    XCTAssertEqual(marked.value as? String, "In Library", "the saved album must carry the saved mark")
    XCTAssertFalse(marked.isEnabled, "a saved album cannot be saved twice")
    capture("apple-music-03-saved-mark")

    let allAlbums = app.switches["apple-music-all-albums"]
    XCTAssertTrue(allAlbums.exists, "the results must offer All Albums")
    allAlbums.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    let everything = resultLabels(in: app, atLeast: Self.mixes.count + 1)
    XCTAssertEqual(
      Array(everything.prefix(Self.mixes.count + 1)), Self.mixes + [Self.studioAlbum],
      "All Albums must keep the DJ mixes first, then the band's own albums")
    capture("apple-music-04-all-albums")

    let record = try JSONSerialization.data(
      withJSONObject: [
        "journey": "apple-music-search",
        "query": "Radiohead",
        "djMixes": djMixes,
        "allAlbumsFirst": Array(everything.prefix(Self.mixes.count + 1)),
        "saved": ["id": saved.id, "title": saved.title, "url": saved.url, "source": saved.source],
      ], options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: record, uniformTypeIdentifier: "public.json")
    attachment.name = "apple-music-search.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// The result titles in screen order, scrolling until `wanted` are read or no new one appears.
  /// The list is lazy, so rows below the fold are not in the tree until scrolled to.
  private func resultLabels(in app: XCUIApplication, atLeast wanted: Int) -> [String] {
    var seen: [String] = []
    for _ in 0..<10 {
      let rows = app.buttons.matching(identifier: "apple-music-result")
      let before = seen.count
      for index in 0..<rows.count {
        let label = rows.element(boundBy: index).label
        if !seen.contains(label) { seen.append(label) }
      }
      if seen.count >= wanted || (seen.count == before && before > 0) { break }
      app.collectionViews.firstMatch.swipeUp()
    }
    return seen
  }

  private func scrollToTop(of app: XCUIApplication, showing element: XCUIElement) {
    for _ in 0..<5 where !element.isHittable {
      app.collectionViews.firstMatch.swipeDown()
    }
  }
}
