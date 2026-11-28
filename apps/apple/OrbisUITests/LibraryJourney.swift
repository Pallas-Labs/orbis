import XCTest

/// What every Library journey shares: launching against the lane service, moving between
/// tabs, searching, and capturing evidence. The journeys themselves live in small classes by
/// area, because Xcode hands a whole class to one simulator, and one large class kept every
/// other simulator idle.
class LibraryJourney: XCTestCase {
  func launch(filteringBy tag: String? = nil) throws -> XCUIApplication {
    let service = try LaneService()
    return launchOrbis(
      address: service.address, token: service.token,
      arguments: tag.map { ["-orbisStartTagFiltered", $0] } ?? [])
  }

  /// A Set this journey saves for itself, with a word in its title and a Tag that no other Set
  /// carries. The full run tests on two simulators that share one Person, and the Library lists
  /// the newest Set first and draws only the rows near the screen. A Set seeded once at the
  /// start of the run sinks out of the tree while the other simulator saves its own (PAL-2443),
  /// so a journey that looks for a Set saves one just before it launches.
  struct OwnSet {
    let set: LaneService.Set
    /// The lowercase word that only this Set's title holds, so a search finds this Set alone.
    let word: String
    let title: String
    let tag: String
  }

  func saveOwnSet(_ name: String) throws -> OwnSet {
    let word = String((0..<8).map { _ in "abcdefghijklmnopqrstuvwxyz".randomElement() ?? "a" })
    let title = "\(name) \(word)"
    let tag = "lane\(word)"
    let set = try LaneService().saveSet(
      title: title, url: "https://www.youtube.com/watch?v=\(word)abc", tags: [tag])
    return OwnSet(set: set, word: word, title: title, tag: tag)
  }

  /// Scrolls a row of Tag chips until the chip sits inside the window. The row leads with the
  /// Tags this simulator used last and then the newest, so a chip can start past the edge, where
  /// a tap at its centre lands on nothing.
  func reveal(_ chip: XCUIElement, in app: XCUIApplication) {
    let window = app.windows.firstMatch.frame
    let origin = app.coordinate(withNormalizedOffset: .zero)
    for _ in 0..<6 where !window.contains(chip.frame) {
      let y = chip.frame.midY
      let (from, to) = chip.frame.minX < window.minX ? (0.2, 0.8) : (0.8, 0.2)
      origin.withOffset(CGVector(dx: window.width * from, dy: y))
        .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: window.width * to, dy: y)))
    }
    XCTAssertTrue(
      window.contains(chip.frame),
      "\(chip.identifier) must scroll into the window\n\(app.debugDescription)")
  }

  func record(_ name: String, _ values: [String: Any]) throws {
    let data = try JSONSerialization.data(
      withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func elapsed(on seek: XCUIElement, _ matches: @escaping (Int) -> Bool)
    -> XCTNSPredicateExpectation
  {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        Self.elapsedSeconds(seek.value as? String).map(matches) ?? false
      },
      object: nil)
  }

  /// Waits until the element matches the predicate, such as `label == "Pause"`.
  func waitUntil(_ element: XCUIElement, _ predicate: NSPredicate, timeout: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// Leaves the Set page for Now Playing, through the mini player, and returns its seek bar. The
  /// Set page has no seek bar (PAL-2293), so the journeys read the position on Now Playing.
  @discardableResult
  func openNowPlaying(_ title: String, in app: XCUIApplication) -> XCUIElement {
    app.navigationBars.buttons.firstMatch.tap()
    let miniPlayer = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(title)")
    ).firstMatch
    XCTAssertTrue(miniPlayer.waitForExistence(timeout: 10))
    miniPlayer.tap()
    XCTAssertTrue(app.staticTexts["now-playing-title"].waitForExistence(timeout: 10))
    let seek = app.sliders["now-playing-seek"]
    XCTAssertTrue(seek.waitForExistence(timeout: 10))
    return seek
  }

  /// Closes Now Playing and waits until it has folded into the mini player. The player takes
  /// taps until the fold ends, so a tap during it lands on the player, not the page below
  /// (PAL-2609). Its close button turns disabled and leaves the accessibility tree only when the
  /// fold ends, together with the player's hit testing.
  func closeNowPlaying(in app: XCUIApplication) {
    let close = app.buttons["now-playing-close"]
    close.tap()
    XCTAssertTrue(
      waitUntil(close, NSPredicate(format: "exists == false OR enabled == false"), timeout: 5),
      "Now Playing must fold into the mini player")
  }

  static func elapsedSeconds(_ value: String?) -> Int? {
    guard let elapsed = value?.components(separatedBy: " of ").first else { return nil }
    var seconds = 0
    for part in elapsed.components(separatedBy: ", ") {
      let words = part.split(separator: " ")
      guard words.count == 2, let count = Int(words[0]) else { return nil }
      switch words[1] {
      case "hour", "hours": seconds += count * 3600
      case "minute", "minutes": seconds += count * 60
      case "second", "seconds": seconds += count
      default: return nil
      }
    }
    return seconds
  }

  /// Taps the centre of an element's own frame, with the point taken from the window. XCUITest
  /// reports a hit point of `{-1, -1}` for some controls inside the Library's scroll view — it
  /// decides the element is not visible, tries to scroll it into view, and gives up — while the
  /// same element reports `hittable` in the accessibility tree and responds to a tap at the point
  /// its own frame names. The point is measured from the window rather than from the element's
  /// coordinate space, which is the difference that makes the tap land.
  func tapAtCentre(of element: XCUIElement, in app: XCUIApplication) {
    let frame = element.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      .tap()
  }

  /// Search is a tab on a compact width class and a sidebar item on a regular one, so the
  /// journey proves the platform's navigation rather than assuming one shape.
  /// Returns nil on iPhone, where the field stays at the top and can be found again by type.
  @discardableResult
  func openSearch(in app: XCUIApplication) -> XCUICoordinate? {
    let tab = app.tabBars.buttons["Search"]
    if tab.waitForExistence(timeout: 8) {
      // The field sits at the top of Search, as in Apple Music. The first tap opens Search and
      // the second, on Search again, focuses the field.
      tab.tap()
      XCTAssertTrue(
        app.searchFields.firstMatch.waitForExistence(timeout: 15),
        "Search must show its field at the top\n\(app.debugDescription)")
      tab.tap()
      XCTAssertTrue(
        app.keyboards.firstMatch.waitForExistence(timeout: 15),
        "a second tap on Search must focus the field\n\(app.debugDescription)")
      return nil
    }
    let sidebarSearch = sidebarItem("Search", in: app, identifier: "sidebar-search")
    XCTAssertTrue(
      sidebarSearch.exists,
      "Search must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    // A tap while the sidebar still settles can leave the last page selected, so it waits for
    // Search's field and taps again, as `selectTab` does for a tab.
    for _ in 0..<3 {
      sidebarSearch.tap()
      if app.searchFields.firstMatch.waitForExistence(timeout: 5) { break }
    }
    return nil
  }

  /// Home is the first tab after pairing. The Library list, its filter, and File a set live on
  /// the Library tab, so a journey that wants them has to select it.
  func openLibrary(in app: XCUIApplication) {
    selectTab("Library", in: app, sidebarIdentifier: "sidebar-library")
  }

  /// Taps the tab's symbol, then waits until that tab's navigation bar is showing. The centre
  /// of the button's frame falls on the list under the floating bar, so the previous tab stays
  /// selected. `tap()` on the button itself reports a hit point of `{-1, -1}`.
  func selectTab(_ name: String, in app: XCUIApplication, sidebarIdentifier: String) {
    let tab = app.tabBars.buttons[name]
    if tab.waitForExistence(timeout: 8) {
      let deadline = Date().addingTimeInterval(12)
      while Date() < deadline {
        if app.navigationBars[name].exists { return }
        let frame = tab.frame
        let window = app.windows.firstMatch.frame
        guard frame.width > 40 else {
          usleep(200_000)
          continue
        }
        // A bar along the bottom takes the tap near its top edge; a bar down the side, as an
        // iPhone Duo draws it, takes it at the button's centre.
        let isBottomBar = frame.minY > window.height / 2
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
          .withOffset(
            CGVector(dx: frame.midX, dy: isBottomBar ? frame.minY + 18 : frame.midY)
          )
          .tap()
        if app.navigationBars[name].waitForExistence(timeout: 2) { return }
      }
      XCTFail("\(name) must open from its tab\n\(app.debugDescription)")
      return
    }
    let sidebar = sidebarItem(name, in: app, identifier: sidebarIdentifier)
    XCTAssertTrue(
      sidebar.exists,
      "\(name) must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    sidebar.tap()
  }

  /// A destination's row in the sidebar: the Mac's own row by its identifier, or the row the
  /// adaptable tab view draws in its sidebar on a wide iPhone or an iPad, by its name. An iPad in
  /// portrait shows the floating tab bar instead, whose items are found the same way.
  func sidebarItem(_ name: String, in app: XCUIApplication, identifier: String) -> XCUIElement {
    // An iPad's floating tab bar reports each item as a button inside a button of the same
    // name, so each query takes its first match.
    let candidates = [
      app.buttons[identifier].firstMatch, app.collectionViews.cells[name].firstMatch,
      app.cells[name].firstMatch, app.buttons[name].firstMatch,
    ]
    let deadline = Date().addingTimeInterval(15)
    repeat {
      if let found = candidates.first(where: { $0.exists }) { return found }
      usleep(200_000)
    } while Date() < deadline
    return candidates[0]
  }

  /// The prompt the field shows while it is empty. XCUITest reports it as the field's value.
  static let searchPrompt = "Title, tag, or source link"

  /// What the field holds, with the prompt an empty field shows treated as nothing.
  func searchText(in app: XCUIApplication) -> String {
    let value = (app.searchFields.firstMatch.value as? String) ?? ""
    return value == Self.searchPrompt ? "" : value
  }

  /// Focuses the field. It replaces the tab button once the tab is selected, and XCUITest
  /// cannot address it after the morph settles, so the first focus uses the point the button
  /// occupied and a later one uses the bar's centre, where a query narrows the field to.
  func focusSearch(in app: XCUIApplication, spot: XCUICoordinate?) {
    guard !app.keyboards.firstMatch.exists else { return }
    if let spot {
      let window = app.windows.firstMatch.frame
      app.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: window.midX, dy: spot.screenPoint.y))
        .tap()
    } else {
      app.searchFields.firstMatch.tap()
    }
    XCTAssertTrue(
      app.keyboards.firstMatch.waitForExistence(timeout: 15),
      "the Search destination must offer a field\n\(app.debugDescription)"
    )
  }

  /// Types a query and submits it. Whatever the field held is replaced, so one launch can
  /// search twice.
  func submitSearch(_ query: String, in app: XCUIApplication, spot: XCUICoordinate?) {
    focusSearch(in: app, spot: spot)
    let existing = searchText(in: app)
    if !existing.isEmpty {
      app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    app.typeText(query)
    // The field searches as it is typed into, and on a slow host it once lost focus before the
    // query was submitted, with the keyboard still up. Return then reached nothing, so the
    // field is tapped again when nothing holds focus.
    let focused = app.descendants(matching: .any)
      .matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    if !focused.exists { app.searchFields.firstMatch.tap() }
    app.typeText("\n")
  }

  /// The state an unmatched search shows, matched by its words rather than its shape.
  func noResults(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "No matching sets")).firstMatch
  }

  func untouchedSearch(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Search your")).firstMatch
  }

  /// A confirmation dialog is a sheet on a phone and an alert on a Mac, so a journey asks for
  /// both rather than assuming one shape. Each is waited for, because a dialog that is still
  /// rising has not been found yet.
  func confirmationButton(_ label: String, in app: XCUIApplication) -> XCUIElement {
    let sheet = app.sheets.buttons[label]
    if sheet.waitForExistence(timeout: 5) {
      return sheet
    }
    let alert = app.alerts.buttons[label]
    if alert.waitForExistence(timeout: 5) {
      return alert
    }
    return app.buttons[label]
  }
}
