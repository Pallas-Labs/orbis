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
    try service.listen(to: middle.id, minutes: 4)
    try service.listen(to: longest.id, minutes: 6)
    try service.listen(to: shortest.id, minutes: 3)
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
    XCTAssertTrue(app.staticTexts["Heavy rotation"].exists, "the shelf names itself")
    XCTAssertTrue(app.descendants(matching: .any)["rotation-card-\(middle.id)"].exists)
    capture("home-heavy-rotation")
  }
}
