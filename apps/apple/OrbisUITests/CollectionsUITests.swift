import XCTest

/// A Person makes a Collection from a filter over their listening, and it opens with the Sets
/// that pass: here, a Tag keeps one of two Sets heard for the same time.
final class CollectionsUITests: LibraryJourney {
  func testATagCollectionShowsOnlyItsHeardSets() throws {
    let service = try LaneService()
    let tag = "dusk-\(UUID().uuidString.prefix(6).lowercased())"
    let tagged = try service.saveSet(
      title: "Collection: tagged", url: "https://www.youtube.com/watch?v=collect0001", tags: [tag])
    let other = try service.saveSet(
      title: "Collection: other", url: "https://www.youtube.com/watch?v=collect0002")
    let name = "Dusk \(tag.suffix(6))"
    addTeardownBlock {
      for collection in (try? service.collections()) ?? [] where collection.name == name {
        try? service.deleteCollection(collection.id)
      }
      for set in [tagged, other] { _ = try? service.removeSet(set.id) }
    }
    // Both over the two-minute floor, so only the Tag decides.
    let saves = try service.listen([(tagged.id, 140), (other.id, 140)])
    try record("listening", ["saves": saves])

    let app = try launch()
    selectTab("Playlists", in: app, sidebarIdentifier: "sidebar-playlists")
    let create = app.buttons["collection-create"]
    XCTAssertTrue(create.waitForExistence(timeout: 15), "Playlists offers a new collection")
    create.tap()

    let field = app.textFields["collection-name"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "the editor opens\n\(app.debugDescription)")
    field.tap()
    field.typeText(name)
    let tagPicker = app.buttons["collection-tag"]
    XCTAssertTrue(tagPicker.waitForExistence(timeout: 5))
    tagPicker.tap()
    let option = app.buttons[tag].firstMatch
    XCTAssertTrue(option.waitForExistence(timeout: 5), "the Tag is offered\n\(app.debugDescription)")
    option.tap()
    capture("collection-editor")
    app.buttons["collection-save"].tap()

    // Saving opens the new Collection.
    let member = app.descendants(matching: .any)["rotation-member-\(tagged.id)"]
    XCTAssertTrue(
      member.waitForExistence(timeout: 30), "the Collection lists the tagged Set\n\(app.debugDescription)")
    XCTAssertFalse(app.descendants(matching: .any)["rotation-member-\(other.id)"].exists)
    XCTAssertTrue(app.staticTexts["collection-title"].exists)
    XCTAssertTrue(app.buttons["rotation-play"].isEnabled)
    capture("collection-page")

    let saved = try XCTUnwrap(try service.collections().first { $0.name == name })
    let served = try service.sets(in: saved.id)
    XCTAssertEqual(served, [tagged.id], "the service holds the same filter")
    try record("collection", ["name": name, "tag": tag, "sets": served])
  }
}
