import XCTest

/// Home's Heavy Rotation shelf, filled by listening: Playback Positions saved as a playing device
/// saves them become Listening Time, and the service ranks the Sets heard most.
final class HeavyRotationUITests: LibraryJourney {
  func testListeningPutsTheMostHeardSetsOnHome() throws {
    let service = try LaneService()
    let longest = try service.saveSet(
      title: "Rotation: the long one", url: "https://www.youtube.com/watch?v=rotation001")
    let middle = try service.saveSet(
      title: "Rotation: the middle one", url: "https://www.youtube.com/watch?v=rotation002")
    let shortest = try service.saveSet(
      title: "Rotation: the short one", url: "https://www.youtube.com/watch?v=rotation003")
    addTeardownBlock {
      for set in [longest, middle, shortest] { _ = try? service.removeSet(set.id) }
    }
    // Each over the two-minute floor with room for a late save, ten seconds apart, so the order
    // is the rank.
    try service.listen([(middle.id, 150), (longest.id, 160), (shortest.id, 140)])
    let ranked = try service.heavyRotation()
    let ours = ranked.filter { [longest.id, middle.id, shortest.id].contains($0) }
    XCTAssertEqual(
      ours, [longest.id, middle.id, shortest.id],
      "the service ranks by listening time; the shelf reads \(ranked)")
    try record("heavy-rotation", ["shelf": ranked])

    let app = try launch()
    let first = app.descendants(matching: .any)["rotation-card-\(longest.id)"]
    XCTAssertTrue(
      first.waitForExistence(timeout: 60),
      "Home must show the shelf\n\(app.debugDescription)")
    for _ in 0..<4 where !first.isHittable { app.swipeUp() }
    XCTAssertTrue(app.staticTexts["Heavy Rotation"].exists, "the shelf names itself")
    XCTAssertTrue(app.descendants(matching: .any)["rotation-card-\(middle.id)"].exists)
    capture("home-heavy-rotation")

    // The shelf opens the collection, ranked as the service ranked it.
    let seeAll = app.buttons["rotation-see-all"]
    for _ in 0..<3 where !seeAll.isHittable { app.swipeDown() }
    seeAll.tap()
    let top = app.descendants(matching: .any)["rotation-member-\(longest.id)"]
    XCTAssertTrue(top.waitForExistence(timeout: 30), "the collection lists the Sets\n\(app.debugDescription)")
    let next = app.descendants(matching: .any)["rotation-member-\(middle.id)"]
    let last = app.descendants(matching: .any)["rotation-member-\(shortest.id)"]
    XCTAssertTrue(next.exists && last.exists)
    XCTAssertLessThan(top.frame.minY, next.frame.minY, "the most heard Set leads")
    XCTAssertLessThan(next.frame.minY, last.frame.minY)
    XCTAssertTrue(app.buttons["rotation-play"].isEnabled)
    capture("heavy-rotation-collection")

    // The past year holds the same listening, so the same Sets stay.
    app.buttons["Past year"].tap()
    XCTAssertTrue(app.buttons["Past year"].waitForExistence(timeout: 5))
    XCTAssertTrue(top.waitForExistence(timeout: 30), "the past year lists the Sets")
    capture("heavy-rotation-past-year")
  }
}
