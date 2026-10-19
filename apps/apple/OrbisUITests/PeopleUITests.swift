import XCTest

/// People with Social on, and the Group Library read from each friend's Library. Opening People
/// once crashed the app as the Group Library loaded.
final class PeopleUITests: PlaylistJourney {
  func testPeopleShowsTheGroupLibrary() throws {
    let host = try LaneService()
    let friend = try LaneService.settingsPerson()
    try host.turnOnSocial()
    try friend.turnOnSocial()
    let titles = (1...3).map { unique("Group \($0)") }
    for title in titles { _ = try friend.saveSet(title: title, url: youtubeURL()) }
    var steps: [[String: Any]] = [["name": "both Persons turn Social on", "friendSets": titles]]

    let app = try launch()
    selectTab("People", in: app)
    let library = app.buttons["group-library"]
    XCTAssertTrue(
      library.waitForExistence(timeout: 30),
      "People must offer the Group Library\n\(app.debugDescription)")
    let newest = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "group-new-")).firstMatch
    XCTAssertTrue(
      newest.waitForExistence(timeout: 30),
      "New in the Group must list the friend's Sets\n\(app.debugDescription)")
    capture("01-people")
    steps.append(["name": "People shows the Group Library"])

    // Leaving and opening People again cancels the Group Library's load midway and starts it
    // over, which is when its requests finish against a load that has moved on.
    for round in 1...8 {
      selectTab("Home", in: app)
      selectTab("People", in: app)
      XCTAssertEqual(app.state, .runningForeground, "the app must survive round \(round)")
    }
    XCTAssertTrue(library.waitForExistence(timeout: 30), "People still shows the Group Library")
    steps.append(["name": "People opens eight more times", "state": "runningForeground"])

    let people = app.scrollViews["people-list"]
    people.swipeDown()
    XCTAssertTrue(library.waitForExistence(timeout: 30), "a refresh keeps the Group Library")
    XCTAssertEqual(app.state, .runningForeground, "the app must survive a refresh")
    steps.append(["name": "a pull refreshes People"])

    tapAtCentre(of: library, in: app)
    let page = app.descendants(matching: .any)["group-library-page"]
    XCTAssertTrue(page.waitForExistence(timeout: 15), "the Group Library opens\n\(app.debugDescription)")
    for title in titles {
      let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
      XCTAssertTrue(
        row.waitForExistence(timeout: 15),
        "the Group Library lists \(title)\n\(app.debugDescription)")
    }
    capture("02-group-library")
    steps.append(["name": "the Group Library lists every friend Set"])

    XCTAssertEqual(app.state, .runningForeground)
    try record("people", steps)
  }
}
