import XCTest

/// Downloads, playback, the Tracklist, the mini player and Now Playing.
final class PlaybackUITests: LibraryJourney {
  func testCancelsAndRetriesADownload() throws {
    let service = try LaneService()
    let seeded = try service.saveSlowDownloadSet(
      title: "Download twice", url: "https://www.youtube.com/watch?v=slowaudio01")
    var observations: [LaneService.DownloadObservation] = []
    defer {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      encoder.dateEncodingStrategy = .iso8601
      do {
        let data = try encoder.encode(observations)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "download-cancel-retry"
        attachment.lifetime = .keepAlways
        add(attachment)
      } catch {
        XCTFail("Could not record download states: \(error)")
      }
    }
    func observe(_ phase: String, until matches: (LaneService.AudioState) -> Bool) throws {
      let deadline = Date().addingTimeInterval(30)
      repeat {
        let state = try service.audioState(seeded.id)
        observations.append(
          .init(phase: phase, observedAt: Date(), setId: seeded.id, audio: state))
        if matches(state) { return }
        usleep(200_000)
      } while Date() < deadline
      XCTFail("Download did not reach \(phase)")
      throw URLError(.timedOut)
    }
    let app = try launch()
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    tapAtCentre(of: row, in: app)
    let download = app.descendants(matching: .any)["detail-download"].firstMatch
    XCTAssertTrue(download.waitForExistence(timeout: 15))
    try observe("initial") { $0.state == "none" }
    tapAtCentre(of: download, in: app)
    try observe("first-download") { $0.hasProgress }
    let progress = app.descendants(matching: .any).matching(
      NSPredicate(format: "label MATCHES %@", "Downloading [1-9][0-9]?%")
    ).firstMatch
    XCTAssertTrue(progress.waitForExistence(timeout: 15), "The page must show partial progress")
    XCTAssertFalse(app.buttons["detail-play-toggle"].exists)
    capture("download-first-progress")
    app.buttons["detail-cancel-download"].tap()
    try observe("canceled") { $0.state == "none" && $0.bytesReceived == 0 }
    XCTAssertTrue(app.buttons["Download"].waitForExistence(timeout: 15))
    capture("download-canceled")
    tapAtCentre(of: download, in: app)
    try observe("second-download") { $0.hasProgress }
    XCTAssertTrue(progress.waitForExistence(timeout: 15), "The retry must show partial progress")
    XCTAssertFalse(app.buttons["detail-play-toggle"].exists)
    capture("download-retry-progress")
    try service.finishSlowDownload(seeded.id)
    try observe("ready") { $0.state == "ready" }
    XCTAssertTrue(app.buttons["detail-play-toggle"].waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["detail-cancel-download"].exists)
    capture("download-retry-ready")
  }

  func testPlaysASetWithRetainedAudio() throws {
    let seeded = try LaneService().saveReadySet(
      title: "Ready to play", url: "https://www.youtube.com/watch?v=readyaudio1")
    let app = try launch()
    openLibrary(in: app)

    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["Download"].exists)
    play.tap()
    XCTAssertTrue(waitUntil(play, NSPredicate(format: "label == %@", "Pause"), timeout: 6))
    capture("16-ready-audio-playing")
    let seek = openNowPlaying(seeded.title, in: app)
    XCTAssertEqual(XCTWaiter.wait(for: [elapsed(on: seek) { $0 > 0 }], timeout: 6), .completed)
    capture("16-ready-audio-now-playing")
  }

  func testPlaysFromBeginningInsteadOfResuming() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Start over journey", url: "https://www.youtube.com/watch?v=startover01")
    try service.setPosition(of: seeded.id, to: 20)
    let app = try launch()
    XCTAssertTrue(
      app.buttons["home-hero-play-from-beginning"].waitForExistence(timeout: 30),
      "Home's part-played lead must offer to start over")
    capture("play-from-beginning-home-hero")
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let toggle = app.buttons["detail-play-toggle"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 30))
    XCTAssertEqual(toggle.label, "Resume")
    let fromBeginning = app.buttons["detail-play-from-beginning"]
    XCTAssertTrue(fromBeginning.exists, "A part-played Set must offer to start over")
    capture("play-from-beginning-offered")

    fromBeginning.tap()
    XCTAssertTrue(waitUntil(toggle, NSPredicate(format: "label == %@", "Pause"), timeout: 15))
    var seek = openNowPlaying(seeded.title, in: app)
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { $0 < 10 }], timeout: 8),
      .completed, "A saved position must not be resumed")
    capture("play-from-beginning-from-saved-position")
    let restarted = try service.position(of: seeded.id) { $0 < 10 }
    XCTAssertLessThan(restarted, 10, "The saved position must move back to the start")

    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { (10..<20).contains($0) }], timeout: 20), .completed)
    let nowPlayingToggle = app.buttons["now-playing-play-toggle"]
    nowPlayingToggle.tap()
    XCTAssertTrue(
      waitUntil(nowPlayingToggle, NSPredicate(format: "label == %@", "Play"), timeout: 4))
    let paused = try service.position(of: seeded.id, becomesAtLeast: 10)
    XCTAssertGreaterThanOrEqual(paused, 10)
    app.buttons["now-playing-close"].tap()
    tapAtCentre(of: row, in: app)
    XCTAssertTrue(toggle.waitForExistence(timeout: 30))
    XCTAssertEqual(toggle.label, "Play")
    XCTAssertTrue(fromBeginning.exists, "The paused Set in the player must offer to start over")
    capture("play-from-beginning-current-paused")

    fromBeginning.tap()
    XCTAssertTrue(waitUntil(toggle, NSPredicate(format: "label == %@", "Pause"), timeout: 5))
    seek = openNowPlaying(seeded.title, in: app)
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { $0 < 10 }], timeout: 5),
      .completed, "The Set in the player must move back to the start")
    capture("play-from-beginning-current-restarted")
    nowPlayingToggle.tap()
    let stored = try service.position(of: seeded.id) { $0 < 10 }
    XCTAssertLessThan(stored, 10)
    try record(
      "play-from-beginning",
      [
        "setId": seeded.id,
        "savedPositionSeconds": 20,
        "afterSavedRestartSeconds": restarted,
        "pausedInPlayerSeconds": paused,
        "afterPlayerRestartSeconds": stored,
      ])
  }

  func testPlaysAndSeeksFromTracklistCues() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Tracklist journey", url: "https://www.youtube.com/watch?v=tracklist01")
    try service.seedTracklist(seeded.id)
    let app = try launch()
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let tracklist = app.descendants(matching: .any)["tracklist"]
    XCTAssertTrue(tracklist.waitForExistence(timeout: 30))
    let first = app.buttons["cue-0"]
    let second = app.buttons["cue-1"]
    XCTAssertTrue(second.exists)
    XCTAssertEqual(second.label, "Second Cue, Second Artist, starts at 0:12")
    XCTAssertFalse(app.buttons["cue-2"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["cue-2"].exists)
    for _ in 0..<3 {
      if second.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(second.isHittable)
    capture("tracklist-before-play")

    // The player marks the Cue the elapsed time falls in, so a selected Cue places the position.
    let isSelected = NSPredicate(format: "selected == true")
    second.tap()
    XCTAssertTrue(waitUntil(second, isSelected, timeout: 8), "The Set must play from 0:12")
    capture("tracklist-second-cue-playing")

    // A selected Cue bounds the position from below only, so Now Playing reads where it landed.
    // A pause first holds the position while the journey walks there.
    let pause = app.buttons["detail-play-toggle"]
    pause.tap()
    XCTAssertTrue(waitUntil(pause, NSPredicate(format: "label == %@", "Play"), timeout: 4))
    var seek = openNowPlaying(seeded.title, in: app)
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { (10..<20).contains($0) }], timeout: 8), .completed,
      "The 0:12 Cue must play from 0:12")
    try record(
      "tracklist-second-cue",
      ["cueSeconds": 12, "elapsedSeconds": Self.elapsedSeconds(seek.value as? String) ?? -1])
    capture("tracklist-elapsed-after-cue")
    app.buttons["now-playing-close"].tap()
    tapAtCentre(of: row, in: app)
    XCTAssertTrue(tracklist.waitForExistence(timeout: 30))

    for _ in 0..<3 {
      if first.isHittable { break }
      app.swipeDown()
    }
    first.tap()
    XCTAssertTrue(waitUntil(first, isSelected, timeout: 5), "The Set must move back to 0:00")
    XCTAssertFalse(second.isSelected)
    XCTAssertTrue(
      waitUntil(pause, NSPredicate(format: "label == %@", "Pause"), timeout: 4),
      "A Cue must play a paused Set")
    capture("tracklist-first-cue-playing")

    pause.tap()
    XCTAssertEqual(pause.label, "Play")

    seek = openNowPlaying(seeded.title, in: app)
    XCTAssertEqual(XCTWaiter.wait(for: [elapsed(on: seek) { $0 < 10 }], timeout: 5), .completed)
    XCTAssertEqual(app.staticTexts["now-playing-cue"].label, "First Cue · First Artist")
    capture("tracklist-now-playing")
  }

  func testRefreshKeepsAReadyTracklist() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Refresh journey", url: "https://www.youtube.com/watch?v=refresh0001")
    try service.seedTracklist(seeded.id)
    let app = try launch()
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    XCTAssertTrue(app.descendants(matching: .any)["tracklist"].waitForExistence(timeout: 30))
    let refresh = app.buttons["tracklist-refresh"]
    for _ in 0..<4 {
      if refresh.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(refresh.isHittable)
    capture("tracklist-refresh")

    refresh.tap()
    // The lane's service has no Versos, so the scan finds nothing and the Set keeps its Cues.
    let pending = app.descendants(matching: .any)["tracklist-pending"]
    let settled = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: pending)
    XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 30), .completed)
    XCTAssertTrue(refresh.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["cue-1"].exists)
    capture("tracklist-after-refresh")

    // While Versos scans, the page keeps the Cues and says it is looking.
    try service.holdTracklistRun(seeded.id)
    refresh.tap()
    XCTAssertTrue(pending.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["cue-1"].exists)
    XCTAssertFalse(refresh.exists)
    capture("tracklist-refreshing")
  }

  func testAColdCueNearTheEndStartsAtItsTimestamp() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Late Cue journey", url: "https://www.youtube.com/watch?v=latecue0001")
    try service.seedLateTracklist(seeded.id)
    let app = try launch()
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)
    let cue = app.buttons["cue-1"]
    XCTAssertTrue(cue.waitForExistence(timeout: 30))
    XCTAssertEqual(cue.label, "Second Cue, Second Artist, starts at 0:26")
    for _ in 0..<3 {
      if cue.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(cue.isHittable)
    capture("cold-late-cue-before-play")
    cue.tap()
    // The player marks the Cue the elapsed time falls in, so a selected Cue places the position.
    XCTAssertTrue(
      waitUntil(cue, NSPredicate(format: "selected == true"), timeout: 6),
      "An explicit Cue must keep its timestamp even within five seconds of the end")
    let deadline = Date().addingTimeInterval(12)
    var finishes = 0
    repeat {
      finishes = try service.set(id: seeded.id)?.finishCount ?? 0
      if finishes > 0 { break }
      usleep(100_000)
    } while Date() < deadline
    usleep(3_000_000)
    finishes = try service.set(id: seeded.id)?.finishCount ?? 0
    capture("cold-late-cue-finished")
    try record(
      "cold-late-cue", ["setId": seeded.id, "requestedSeconds": 26, "finishCount": finishes])
    XCTAssertEqual(
      finishes, 1, "Starting at 26 seconds must finish the 30-second Set within 12 seconds")
  }

  func testMiniPlayerNowPlayingAndStoredPosition() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Now Playing journey", url: "https://www.youtube.com/watch?v=nowplaying1")
    let app = try launch()
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    play.tap()
    XCTAssertFalse(app.buttons.matching(identifier: "mini-player").firstMatch.exists)
    capture("17-playing-on-set-page")

    app.navigationBars.buttons.firstMatch.tap()
    let miniToggle = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "mini-player", "Pause")
    ).firstMatch
    XCTAssertTrue(miniToggle.waitForExistence(timeout: 10))
    XCTAssertEqual(miniToggle.label, "Pause")
    capture("18-mini-player")

    let openNowPlaying = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
    ).firstMatch
    openNowPlaying.tap()
    let title = app.staticTexts["now-playing-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    XCTAssertEqual(title.label, seeded.title)
    let seek = app.sliders["now-playing-seek"]
    XCTAssertEqual(XCTWaiter.wait(for: [elapsed(on: seek) { $0 > 0 }], timeout: 4), .completed)
    let beforePause = try service.set(id: seeded.id)?.playbackPositionSeconds ?? 0
    // The pause must report a later position than the one stored, so the Set plays on past it.
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { $0 >= beforePause + 2 }], timeout: 10), .completed,
      "playback must move on from the stored position")
    let pause = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "now-playing-play-toggle", "Pause")
    ).firstMatch
    pause.tap()
    let resume = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "now-playing-play-toggle", "Play")
    ).firstMatch
    XCTAssertTrue(resume.waitForExistence(timeout: 4))
    capture("19-now-playing-paused")

    let stored = try service.position(of: seeded.id, becomesAtLeast: beforePause + 1)
    XCTAssertGreaterThan(stored, beforePause)
    XCTAssertLessThan(stored, 30)
    let storedTitle = try service.set(id: seeded.id)?.title
    XCTAssertEqual(storedTitle, seeded.title)
    try record(
      "playback-position",
      [
        "setId": seeded.id,
        "expected": [
          "title": seeded.title, "minimumPositionSeconds": beforePause + 1,
          "maximumPositionSeconds": 29,
        ],
        "stored": [
          "title": storedTitle ?? "", "positionBeforePauseSeconds": beforePause,
          "positionSeconds": stored,
        ],
      ])
  }

}
