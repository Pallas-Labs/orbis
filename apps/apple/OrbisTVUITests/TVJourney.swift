import XCTest

/// The TV's journey: launch signed in, walk the tabs with the Siri Remote, turn on Share with
/// Group from People, open a Set, play it, read Now Playing, skip forward, and open Up Next.
/// Every screen is captured.
///
/// Playback is proven by what the screen says, never by sound: the lane seeds silent audio, and
/// the app is terminated when the test ends so nothing keeps playing.
final class TVJourney: XCTestCase {
  private var app: XCUIApplication?

  override func tearDown() {
    app?.terminate()
    app = nil
    super.tearDown()
  }

  func testBrowsesPlaysAndReadsNowPlaying() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "TV journey", url: "https://www.youtube.com/watch?v=tvjourney01")
    try service.seedTracklist(seeded.id)
    let playlist = try service.createPlaylist(named: "Late nights")
    try service.setMembers(of: playlist.id, to: [seeded.id])
    let app = launchOrbis(address: service.address, token: service.token)
    self.app = app
    let remote = XCUIRemote.shared

    XCTAssertTrue(app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 30))
    XCTAssertTrue(
      app.descendants(matching: .any)["recent-card-\(seeded.id)"].waitForExistence(timeout: 30),
      "Home must show the seeded Set in its rail\n\(app.debugDescription)")
    capture("tv-home")

    remote.press(.right)
    XCTAssertTrue(app.descendants(matching: .any)["tv-library"].waitForExistence(timeout: 15))
    let tile = app.buttons["tv-set-\(seeded.id)"]
    XCTAssertTrue(tile.waitForExistence(timeout: 30))
    capture("tv-library")

    remote.press(.right)
    XCTAssertTrue(app.descendants(matching: .any)["tv-playlists"].waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.buttons["tv-playlist-\(playlist.id)"].waitForExistence(timeout: 30),
      "Playlists must show the seeded folder\n\(app.debugDescription)")
    capture("tv-playlists")

    // The lane's Person starts with Social off, so People is the invite; its one button turns
    // Social on, and the invite gives way to the Group.
    remote.press(.right)
    XCTAssertTrue(app.descendants(matching: .any)["tv-people"].waitForExistence(timeout: 15))
    let turnOn = app.buttons["social-turn-on"]
    XCTAssertTrue(
      turnOn.waitForExistence(timeout: 30), "People must invite a Person with Social off\n\(app.debugDescription)")
    capture("tv-people-invite")
    XCTAssertTrue(moveFocus(to: turnOn, pressing: .down, limit: 3), "Share with Group must take focus")
    remote.press(.select)
    XCTAssertTrue(
      waitUntil(timeout: 30) { !app.descendants(matching: .any)["social-invite"].exists },
      "Turning Social on must replace the invite with the Group\n\(app.debugDescription)")
    XCTAssertTrue(app.descendants(matching: .any)["tv-people"].waitForExistence(timeout: 10))
    capture("tv-people")

    let searchTab = app.tabBars.buttons["Search"]
    XCTAssertTrue(pressUntil(.up, limit: 4) { app.tabBars.buttons.allElementsBoundByIndex.contains { $0.hasFocus } })
    XCTAssertTrue(pressUntil(.right, limit: 4) { searchTab.hasFocus }, "The bar must reach Search")
    XCTAssertTrue(app.descendants(matching: .any)["tv-search"].waitForExistence(timeout: 15))
    // The system lays its keyboard out a moment after the tab lands, and the page under it is
    // drawn once focus moves down into it; the lane's Tag is the chip that says it is there.
    XCTAssertTrue(app.descendants(matching: .any)["search-untouched"].waitForExistence(timeout: 15))
    remote.press(.down)
    XCTAssertTrue(
      app.buttons["search-tag-techno"].waitForExistence(timeout: 15),
      "Search must show the lane's Tag under the keyboard\n\(app.debugDescription)")
    XCTAssertTrue(waitUntilSettled(app.buttons["search-tag-techno"]), "Search must come to rest")
    capture("tv-search")

    // Focus is in the system keyboard now, so the way back to the Library is up to the bar and
    // along it, not two presses left.
    let libraryTab = app.tabBars.buttons["Library"]
    XCTAssertTrue(pressUntil(.up, limit: 6) { app.tabBars.buttons.allElementsBoundByIndex.contains { $0.hasFocus } })
    XCTAssertTrue(pressUntil(.left, limit: 6) { libraryTab.hasFocus }, "The bar must reach Library")
    XCTAssertTrue(app.descendants(matching: .any)["tv-library"].waitForExistence(timeout: 15))
    let chip = app.buttons["tv-tag-techno"]
    XCTAssertTrue(moveFocus(to: chip, pressing: .down, limit: 2), "The Tag chip must take focus")
    remote.press(.select)
    XCTAssertTrue(waitUntil { chip.isSelected }, "The Tag must filter the Library")
    XCTAssertTrue(waitUntilSettled(chip), "The filtered Library must come to rest")
    XCTAssertTrue(chip.hasFocus, "Focus must stay on the Tag after it filters the Library")
    remote.press(.select)
    XCTAssertTrue(waitUntil { !chip.isSelected }, "The Tag must clear the filter")
    XCTAssertTrue(waitUntilSettled(chip), "The whole Library must come to rest")
    XCTAssertTrue(chip.hasFocus, "Focus must stay on the Tag after the filter clears")
    XCTAssertTrue(tile.waitForExistence(timeout: 10))
    XCTAssertTrue(moveFocus(to: tile, pressing: .down, limit: 3), "The seeded tile must take focus")
    XCTAssertTrue(moveFocus(to: tile, pressing: .left, limit: 3))
    remote.press(.select)
    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    XCTAssertTrue(
      app.descendants(matching: .any)["tracklist"].waitForExistence(timeout: 30),
      "The Set page must show the seeded Tracklist")
    XCTAssertTrue(moveFocus(to: play, pressing: .down, limit: 3), "Play must take focus on the Set page")
    capture("tv-set-page")

    remote.press(.select)
    XCTAssertEqual(
      XCTWaiter.wait(for: [labelled(play, "Pause")], timeout: 20), .completed,
      "Play must become Pause once the Set is in the player")

    let nowPlayingTab = app.tabBars.buttons["Now Playing"]
    XCTAssertTrue(nowPlayingTab.waitForExistence(timeout: 10))
    XCTAssertTrue(pressUntil(.up, limit: 4) { app.tabBars.buttons.allElementsBoundByIndex.contains { $0.hasFocus } })
    XCTAssertTrue(pressUntil(.right, limit: 6) { nowPlayingTab.hasFocus }, "The bar must reach Now Playing")
    XCTAssertTrue(app.descendants(matching: .any)["now-playing"].waitForExistence(timeout: 15))
    let toggle = app.buttons["now-playing-play-toggle"]
    XCTAssertEqual(XCTWaiter.wait(for: [labelled(toggle, "Pause")], timeout: 20), .completed)
    XCTAssertTrue(
      app.staticTexts["now-playing-cue"].exists || app.staticTexts["now-playing-title"].exists,
      "Now Playing must name the track or the Set\n\(app.debugDescription)")
    capture("tv-now-playing")

    let elapsed = app.staticTexts["now-playing-elapsed"]
    XCTAssertTrue(elapsed.waitForExistence(timeout: 10))
    let before = Self.seconds(elapsed.label)
    let forward = app.buttons["now-playing-forward"]
    remote.press(.down)
    XCTAssertTrue(
      moveFocus(to: forward, pressing: .left, limit: 8), "Forward must take focus in the transport")
    remote.press(.select)
    let moved = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in Self.seconds(elapsed.label) >= before + 20 }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 10), .completed, "Elapsed must move forward by the skip")
    try record(
      "tv-forward-skip",
      ["setId": seeded.id, "elapsedBefore": before, "elapsedAfter": Self.seconds(elapsed.label)])

    let upNext = app.buttons["now-playing-queue"]
    XCTAssertTrue(moveFocus(to: upNext, pressing: .right, limit: 8), "Up Next must take focus")
    remote.press(.select)
    XCTAssertTrue(app.descendants(matching: .any)["queue-screen"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.buttons["queue-entry-\(seeded.id)"].waitForExistence(timeout: 15))
    capture("tv-queue")
    remote.press(.menu)
    let closed = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"),
      object: app.descendants(matching: .any)["queue-screen"])
    XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 10), .completed, "Menu must close Up Next")
    remote.press(.playPause)
    XCTAssertEqual(XCTWaiter.wait(for: [labelled(toggle, "Play")], timeout: 10), .completed)

    let settingsTab = app.tabBars.buttons["Settings"]
    XCTAssertTrue(pressUntil(.up, limit: 4) { app.tabBars.buttons.allElementsBoundByIndex.contains { $0.hasFocus } })
    XCTAssertTrue(pressUntil(.right, limit: 6) { settingsTab.hasFocus }, "The bar must reach Settings")
    XCTAssertTrue(app.descendants(matching: .any)["tv-settings"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["settings-version"].waitForExistence(timeout: 15))
    XCTAssertTrue(waitUntilSettled(app.staticTexts["settings-version"]), "Settings must come to rest")
    capture("tv-settings")

    // The silent Set is a minute long: resumed, it ends, the queue empties, and the Now Playing
    // tab leaves the bar. The shell must land on Home with Home's own stack, so a tile there
    // opens its page in view rather than in the Library's stack behind it.
    XCTAssertTrue(pressUntil(.left, limit: 6) { nowPlayingTab.hasFocus }, "The bar must reach Now Playing again")
    remote.press(.playPause)
    XCTAssertEqual(XCTWaiter.wait(for: [labelled(toggle, "Pause")], timeout: 10), .completed)
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: nowPlayingTab)
    XCTAssertEqual(
      XCTWaiter.wait(for: [ended], timeout: 90), .completed, "The Set must end and Now Playing leave the bar")
    XCTAssertTrue(app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 15))
    let hero = app.buttons["home-hero-\(seeded.id)"]
    XCTAssertTrue(hero.waitForExistence(timeout: 15), "Home must lead with the seeded Set\n\(app.debugDescription)")
    // Focus comes down onto the hero's Play, and its artwork is at the end of the same row.
    let heroPlay = app.buttons["home-hero-play"]
    XCTAssertTrue(
      pressUntil(.down, limit: 4) { heroPlay.hasFocus || hero.hasFocus }, "The hero must take focus")
    XCTAssertTrue(moveFocus(to: hero, pressing: .right, limit: 4), "The hero's artwork must take focus")
    remote.press(.select)
    XCTAssertTrue(
      app.descendants(matching: .any)["tv-set-page"].waitForExistence(timeout: 15),
      "A Set opened from Home must appear on Home's own stack\n\(app.debugDescription)")
    capture("tv-home-set-page")
  }

  /// An Apple Music Set on the TV (ADR 0021). MusicKit does not play in the simulator, which has no
  /// Apple Music subscription either, so the journey proves the path a Person without access or a
  /// subscription takes: the Set page shows the Tracklist and Play, the first Play asks for Apple
  /// Music access, and once the answer is no, the page says to open the album in Apple Music
  /// instead of offering Play. Playing a real mix is the device check on the issue.
  func testAnAppleMusicSetAsksOnFirstPlayThenSaysToOpenAppleMusic() throws {
    // The lane's second Person plays this one, so the host's Library, which the other journey
    // reads, stays as seeded.
    let service = try LaneService.settingsPerson()
    let seeded = try service.saveAppleMusicSet(title: "Apple Music DJ mix")
    addTeardownBlock { try? service.removeSet(seeded.id) }
    // Every run asks afresh, whatever an earlier run answered on this simulator.
    XCUIApplication().resetAuthorizationStatus(for: .mediaLibrary)
    let app = launchOrbis(address: service.address, token: service.token)
    self.app = app
    let remote = XCUIRemote.shared

    XCTAssertTrue(app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 30))
    remote.press(.right)
    XCTAssertTrue(app.descendants(matching: .any)["tv-library"].waitForExistence(timeout: 15))
    let tile = app.buttons["tv-set-\(seeded.id)"]
    XCTAssertTrue(
      tile.waitForExistence(timeout: 30), "The Library must show the Apple Music Set\n\(app.debugDescription)")
    XCTAssertTrue(moveFocus(to: tile, pressing: .down, limit: 4), "The Apple Music Set's tile must take focus")
    remote.press(.select)

    XCTAssertTrue(app.descendants(matching: .any)["tv-set-page"].waitForExistence(timeout: 30))
    let thirdSong = app.descendants(matching: .any)["cue-2"]
    XCTAssertTrue(
      thirdSong.waitForExistence(timeout: 30),
      "The Set page must show the album's songs as the Tracklist\n\(app.debugDescription)")
    let play = app.buttons["detail-play-toggle"]
    _ = play.waitForExistence(timeout: 10)
    XCTAssertTrue(waitUntilSettled(thirdSong), "The Set page must come to rest")
    capture("tv-apple-music-01-set-page")
    XCTAssertTrue(play.exists, "An Apple Music Set offers Play before access is asked\n\(app.debugDescription)")
    XCTAssertFalse(
      app.descendants(matching: .any)["detail-download"].exists, "An Apple Music Set never offers Download")
    XCTAssertTrue(moveFocus(to: play, pressing: .up, limit: 4), "Play must take focus on the Set page")
    remote.press(.select)

    // The system asks for Apple Music access. The answer is no, as for a Person who refuses; a
    // simulator that answers without asking reads as no subscription and lands in the same place.
    var asked = false
    let refusals = [app, XCUIApplication(bundleIdentifier: "com.apple.PineBoard")].map {
      $0.alerts.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch
    }
    if waitUntil(timeout: 15, { refusals.contains { $0.exists } }) {
      asked = true
      capture("tv-apple-music-02-access-prompt")
      let button = refusals.first { $0.exists }!
      XCTAssertTrue(
        moveFocus(to: button, pressing: .down, limit: 3) || moveFocus(to: button, pressing: .up, limit: 3),
        "Don't Allow must take focus")
      remote.press(.select)
    }

    let note = app.descendants(matching: .any)["detail-apple-music-note"]
    XCTAssertTrue(
      note.waitForExistence(timeout: 30),
      "Without access the page must say to open Apple Music\n\(app.debugDescription)")
    XCTAssertFalse(play.exists, "Without access the page offers no Play")
    XCTAssertTrue(thirdSong.exists, "The Tracklist stays on the page")
    XCTAssertTrue(waitUntilSettled(note), "The Set page must come to rest")
    capture("tv-apple-music-03-open-apple-music")
    try record(
      "tv-apple-music-journey", ["setId": seeded.id, "askedForAccess": asked, "note": note.label])
  }

  private func moveFocus(to element: XCUIElement, pressing button: XCUIRemote.Button, limit: Int) -> Bool {
    pressUntil(button, limit: limit) { element.exists && element.hasFocus }
  }

  private func pressUntil(_ button: XCUIRemote.Button, limit: Int, _ reached: () -> Bool) -> Bool {
    for _ in 0..<limit {
      if reached() { return true }
      XCUIRemote.shared.press(button)
      usleep(600_000)
    }
    return reached()
  }

  private func waitUntil(timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) -> Bool {
    let met = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
    return XCTWaiter.wait(for: [met], timeout: timeout) == .completed
  }

  /// Waits until the element is in the same place on two reads in a row, so a capture shows the
  /// screen at rest and not partway through a transition.
  private func waitUntilSettled(_ element: XCUIElement) -> Bool {
    var last = CGRect.null
    return waitUntil {
      let frame = element.frame
      defer { last = frame }
      return !frame.isEmpty && frame == last
    }
  }

  private func labelled(_ element: XCUIElement, _ label: String) -> XCTNSPredicateExpectation {
    XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: element)
  }

  private static func seconds(_ label: String) -> Int {
    label.split(separator: ":").compactMap { Int($0) }.reduce(0) { $0 * 60 + $1 }
  }

  private func record(_ name: String, _ values: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
