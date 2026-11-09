import XCTest

final class PlaybackRecoveryUITests: LibraryJourney {
  func testDetailPlayRetriesAFailedAudioItem() throws {
    try recoverPlayback(on: .detail, sourceId: "retrydet001")
  }

  func testNowPlayingPlayRetriesAFailedAudioItem() throws {
    try recoverPlayback(on: .nowPlaying, sourceId: "retrynow001")
  }

  /// A path that holds the audio body: the first item times out before it plays, and the player
  /// loads it again on its own, so the Set plays with no tap.
  func testHeldAudioRetriesOnItsOwn() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Held audio", url: "https://www.youtube.com/watch?v=heldbody001")
    try service.fault(seeded.id, with: .heldBody)
    let app = launchOrbis(address: try LaneService.proxyAddress(), token: service.token)
    var findings: [String: Any] = ["setId": seeded.id]
    defer { keep("held-body-retry", findings, service: service, setId: seeded.id) }
    let (play, seek) = startPlaying(seeded, in: app)
    let failure = app.staticTexts["This audio would not play."]
    let played = waitForSound(on: seek, beyond: 2, seconds: 150) {
      if failure.exists { findings["failureShown"] = true }
    }
    findings["elapsedSeconds"] = Self.elapsedSeconds(seek.value as? String) ?? -1
    capture("held-body-playing")
    XCTAssertTrue(played, "The Set must play after the first timeout, with no tap")
    XCTAssertNil(findings["failureShown"], "The automatic retry must not show the failure")
    XCTAssertEqual(play.label, "Pause")
    let events = try diagnostics(of: seeded.id, service: service) {
      $0.contains("command.reload.automatic")
    }
    findings["events"] = events
    XCTAssertEqual(
      events.filter { $0.hasPrefix("item.failed") || $0 == "command.reload.automatic" },
      ["item.failed.url", "command.reload.automatic"],
      "One failed item, then one automatic reload: \(events)")
  }

  /// A path that sends the first part of the body and then pauses: the stall outlasts the window,
  /// so the player records it, loads the item again once, and plays on.
  func testStallReloadsOnItsOwn() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Paused audio", url: "https://www.youtube.com/watch?v=pausedbody1")
    try service.fault(seeded.id, with: .pausedBody)
    let app = launchOrbis(address: try LaneService.proxyAddress(), token: service.token)
    var findings: [String: Any] = ["setId": seeded.id]
    defer { keep("stall-reload", findings, service: service, setId: seeded.id) }
    let (_, seek) = startPlaying(seeded, in: app)
    let stalled = try diagnostics(of: seeded.id, service: service, seconds: 60) {
      $0.contains("stalled")
    }
    findings["eventsAtStall"] = stalled
    capture("stall-reload-stalled")
    // The faulted item holds everything past its first ten seconds, so playing beyond them
    // proves the reload replaced it.
    let recovered = waitForSound(on: seek, beyond: 14, seconds: 60) {}
    findings["elapsedSeconds"] = Self.elapsedSeconds(seek.value as? String) ?? -1
    capture("stall-reload-playing")
    XCTAssertTrue(recovered, "The reloaded item must play past the stall")
    XCTAssertFalse(app.staticTexts["The audio stopped loading."].exists)
    let entries = try service.proxiedDiagnostics(for: seeded.id)
    let events = entries.map(Self.label)
    findings["events"] = events
    XCTAssertEqual(
      events.filter { ["stallUnrecovered", "command.reload.automatic"].contains($0) },
      ["stallUnrecovered", "command.reload.automatic"],
      "One unrecovered stall, then one automatic reload: \(events)")
    let stalledAt = Self.wallTime(of: "stalled", in: entries)
    let unrecoveredAt = Self.wallTime(of: "stallUnrecovered", in: entries)
    findings["secondsFromStallToUnrecovered"] = unrecoveredAt.flatMap { end in
      stalledAt.map { (end - $0) / 1_000 }
    } ?? -1
    let window = try XCTUnwrap(findings["secondsFromStallToUnrecovered"] as? Double)
    XCTAssertTrue((0...30).contains(window), "The stall must be acted on within 30 s: \(window)")
  }

  /// A pause that outlasts the stall window and the reload's window ends in the failure the
  /// listener can act on, rather than loading for good.
  func testStallThatOutlastsItsReloadFails() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Stopped audio", url: "https://www.youtube.com/watch?v=pausedbody2")
    try service.fault(seeded.id, with: .pausedBody, everySession: true)
    let app = launchOrbis(address: try LaneService.proxyAddress(), token: service.token)
    var findings: [String: Any] = ["setId": seeded.id]
    defer { keep("stall-failed", findings, service: service, setId: seeded.id) }
    _ = startPlaying(seeded, in: app)
    let stopped = app.staticTexts["The audio stopped loading."]
    XCTAssertTrue(
      stopped.waitForExistence(timeout: 150), "A stall the reload cannot cure must fail")
    capture("stall-failed")
    XCTAssertEqual(app.buttons["detail-play-toggle"].label, "Play")
    let events = try diagnostics(of: seeded.id, service: service) {
      $0.contains("state.failed")
    }
    findings["events"] = events
    XCTAssertEqual(events.filter { $0 == "stallUnrecovered" }.count, 1, "\(events)")
    XCTAssertEqual(events.filter { $0 == "command.reload.automatic" }.count, 1, "\(events)")
  }

  /// Opens the Set's detail and presses Play once; the journey taps nothing after this.
  private func startPlaying(_ set: LaneService.Set, in app: XCUIApplication)
    -> (play: XCUIElement, seek: XCUIElement)
  {
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(set.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    tapAtCentre(of: row, in: app)
    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    play.tap()
    let seek = app.sliders["detail-seek"]
    XCTAssertTrue(seek.waitForExistence(timeout: 10))
    return (play, seek)
  }

  /// Waits until the seek bar passes `seconds` of media time, checking `each` on every look.
  private func waitForSound(
    on seek: XCUIElement, beyond position: Int, seconds: TimeInterval, each: () -> Void
  ) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      each()
      if (Self.elapsedSeconds(seek.value as? String) ?? 0) > position { return true }
      usleep(500_000)
    }
    return false
  }

  /// The diagnostics the app sent for the Set, as labels, once `ready` holds for them. The app
  /// sends every five seconds, so a short wait follows the event itself.
  private func diagnostics(
    of setId: String, service: LaneService, seconds: TimeInterval = 30,
    until ready: ([String]) -> Bool
  ) throws -> [String] {
    let deadline = Date().addingTimeInterval(seconds)
    var labels: [String] = []
    repeat {
      labels = try service.proxiedDiagnostics(for: setId).map(Self.label)
      if ready(labels) { return labels }
      usleep(500_000)
    } while Date() < deadline
    return labels
  }

  /// `item.failed.url`, `command.reload.automatic`, `state.failed`, `stalled`: what a diagnostics
  /// entry records, in the words the assertions use.
  private static func label(_ entry: [String: Any]) -> String {
    guard let event = entry["event"] as? [String: Any], let key = event.keys.first else {
      return "unknown"
    }
    let value = (event[key] as? [String: Any])?["_0"] as? [String: Any]
    switch key {
    case "item":
      let phase = value?["phase"] as? String ?? "?"
      let domain = (value?["error"] as? [String: Any])?["domain"] as? String
      return domain.map { "item.\(phase).\($0)" } ?? "item.\(phase)"
    case "command":
      return "command.\(value?["kind"] as? String ?? "?").\(value?["origin"] as? String ?? "?")"
    case "state":
      return "state.\(value?["to"] as? String ?? "?")"
    default:
      return key
    }
  }

  private static func wallTime(of label: String, in entries: [[String: Any]]) -> Double? {
    entries.first { Self.label($0) == label }?["wallTime"] as? Double
  }

  /// Attaches what the journey found, the app's diagnostics, and each audio request the seed
  /// server answered, so a run can be checked again from its artifacts alone.
  private func keep(_ name: String, _ findings: [String: Any], service: LaneService, setId: String) {
    var evidence = findings
    evidence["diagnostics"] = (try? service.proxiedDiagnostics(for: setId)) ?? []
    evidence["audioRequests"] = (try? service.faultState(of: setId)) ?? [:]
    do {
      try record(name, evidence)
    } catch {
      XCTFail("Could not record \(name): \(error)")
    }
  }

  private enum Surface: String {
    case detail
    case nowPlaying = "now-playing"
  }

  private func recoverPlayback(on surface: Surface, sourceId: String) throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Retry \(surface.rawValue)", url: "https://www.youtube.com/watch?v=\(sourceId)")
    try service.markAudioUnavailable(seeded.id)
    XCTAssertEqual(try service.audioState(seeded.id).state, "ready")
    let app = try launch()
    var observations: [[String: Any]] = []
    defer {
      capture("\(surface.rawValue)-retry-final")
      do {
        try record(
          "\(surface.rawValue)-retry",
          ["setId": seeded.id, "surface": surface.rawValue, "observations": observations])
      } catch {
        XCTFail("Could not record playback retry observations: \(error)")
      }
    }
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    tapAtCentre(of: row, in: app)
    let detailPlay = app.buttons["detail-play-toggle"]
    XCTAssertTrue(detailPlay.waitForExistence(timeout: 30))
    detailPlay.tap()
    let failure = app.staticTexts["This audio would not play."]
    XCTAssertTrue(failure.waitForExistence(timeout: 30), "The unavailable file must fail playback")
    capture("\(surface.rawValue)-retry-failed-item")

    switch surface {
    case .detail:
      break
    case .nowPlaying:
      app.navigationBars.buttons.firstMatch.tap()
      let openNowPlaying = app.buttons.matching(
        NSPredicate(
          format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
      ).firstMatch
      XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))
      openNowPlaying.tap()
      XCTAssertTrue(app.staticTexts["now-playing-title"].waitForExistence(timeout: 10))
      XCTAssertTrue(failure.waitForExistence(timeout: 5))
    }

    let seek = app.sliders["\(surface.rawValue)-seek"]
    XCTAssertTrue(seek.waitForExistence(timeout: 10))
    let beforeRetry = Self.elapsedSeconds(seek.value as? String) ?? 0
    observations.append([
      "phase": "failed", "elapsedSeconds": beforeRetry, "failureVisible": failure.exists,
    ])
    try service.restoreReadyAudio(seeded.id)
    let play = app.buttons["\(surface.rawValue)-play-toggle"]
    XCTAssertEqual(play.label, "Play")
    play.tap()
    let firstAdvance = XCTWaiter.wait(
      for: [elapsed(on: seek) { $0 > beforeRetry }], timeout: 12)
    let resumedAt = Self.elapsedSeconds(seek.value as? String) ?? -1
    observations.append([
      "phase": "after-retry", "elapsedSeconds": resumedAt, "failureVisible": failure.exists,
    ])
    XCTAssertEqual(firstAdvance, .completed, "Retry must replace the failed item and play audio")
    XCTAssertEqual(
      XCTWaiter.wait(for: [elapsed(on: seek) { $0 >= resumedAt + 2 }], timeout: 8),
      .completed, "The recovered playback timeline must keep advancing")
    observations.append([
      "phase": "advancing", "elapsedSeconds": Self.elapsedSeconds(seek.value as? String) ?? -1,
      "failureVisible": failure.exists,
    ])
    XCTAssertFalse(failure.exists, "A successful retry must clear the playback failure")
    XCTAssertEqual(play.label, "Pause")
    capture("\(surface.rawValue)-retry-playing")
    play.tap()
    XCTAssertEqual(play.label, "Play")
  }

}
