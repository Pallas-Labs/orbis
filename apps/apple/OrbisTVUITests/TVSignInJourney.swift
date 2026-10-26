import XCTest

/// A signed-out TV signs in with a Sign-in Code from another device, twice, typed with the
/// remote: once lowercase with its dash, closing the keyboard before the last character to see
/// the filled slots, and once after a dash, a space, and the look-alikes, which change nothing.
/// Each signs in as the last slot fills. A paste from the iPhone's keyboard for Apple TV cannot
/// be driven in the simulator; the iOS journey covers a pasted code.
final class TVSignInJourney: XCTestCase {
  private var app: XCUIApplication?

  override func tearDown() {
    app?.terminate()
    app = nil
    super.tearDown()
  }

  func testSignsInWithTypedCodes() throws {
    let friend = try LaneService.settingsPerson()
    let devicesBefore = Set(try friend.devices().map(\.id))
    let remote = XCUIRemote.shared

    var app = launchOrbis(address: friend.address)
    self.app = app
    var field = openCodeForm(app, capturing: "tv-signin-00-signed-out")
    let first = try friend.signInCode()
    let dashed = "\(first.prefix(4))-\(first.suffix(4))".lowercased()
    remote.press(.select)
    type(dashed.dropLast(), into: field)
    XCTAssertTrue(
      waitUntil { field.value as? String == String(first.prefix(7)) },
      "the dash drops out and capitals fill the slots: \(String(describing: field.value))")
    capture("tv-signin-01-keyboard")
    remote.press(.menu)
    XCTAssertTrue(
      waitUntil { app.buttons["signin-redeem"].exists && field.value as? String == String(first.prefix(7)) },
      "closing the keyboard keeps the code\n\(app.debugDescription)")
    capture("tv-signin-02-slots-filled")
    remote.press(.select)
    field.typeText(String(dashed.suffix(1)))
    XCTAssertTrue(
      app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 30),
      "a dashed lowercase code must sign the TV in as the last slot fills\n\(app.debugDescription)")
    capture("tv-signin-03-signed-in")

    // Settings live in memory, so a relaunch starts signed out.
    app.terminate()
    app = launchOrbis(address: friend.address)
    self.app = app
    field = openCodeForm(app)
    let second = try friend.signInCode()
    let typed = "\(second.prefix(4)) \(second.suffix(4))".lowercased()
    remote.press(.select)
    // An empty field reads back its dictation hint, so the look-alikes are proven by the seven
    // characters that follow them filling the first seven slots.
    type("- O0I1L" + typed.dropLast(), into: field)
    XCTAssertTrue(
      waitUntil { field.value as? String == String(second.prefix(7)) },
      "a dash, a space, and look-alikes change nothing, and typed characters fill the slots in "
        + "capitals: \(String(describing: field.value))")
    capture("tv-signin-04-typed")
    field.typeText(String(typed.suffix(1)))
    XCTAssertTrue(
      app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 30),
      "a typed code must sign the TV in as the last slot fills\n\(app.debugDescription)")
    capture("tv-signin-05-signed-in")

    let added = try friend.devices().filter { !devicesBefore.contains($0.id) }
    XCTAssertEqual(added.count, 2, "each sign-in holds its own key")
    for device in added {
      XCTAssertEqual(try friend.revokeDevice(device.id), 200)
    }
  }

  /// Moves from I Have a Group Passcode to I Have a Sign-in Code, opens it, and returns the code
  /// field once it has focus.
  private func openCodeForm(_ app: XCUIApplication, capturing name: String? = nil) -> XCUIElement {
    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30), "a signed-out TV offers a Sign-in Code")
    XCTAssertTrue(
      pressUntil(.down, limit: 3) { haveCode.hasFocus }, "I Have a Sign-in Code must take focus")
    if let name { capture(name) }
    XCUIRemote.shared.press(.select)
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "\(app.debugDescription)")
    XCTAssertTrue(
      pressUntil(.up, limit: 3) { field.hasFocus }, "the code field must take focus\n\(app.debugDescription)")
    return field
  }

  /// Types one character at a time and lets the field settle after each, as a person does with
  /// the remote. A burst can land while the field rewrites lowercase as capitals and lose a key.
  private func type(_ text: some StringProtocol, into field: XCUIElement) {
    for character in text {
      let before = field.value as? String
      field.typeText(String(character))
      _ = waitUntil(timeout: 2) { field.value as? String != before }
    }
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
}
