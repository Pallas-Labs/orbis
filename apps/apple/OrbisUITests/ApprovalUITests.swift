import XCTest

/// Approving another device from this one (ADR 0022). The lane plays the TV: it starts an Approval
/// Request with no key and collects the key on its wait. The journeys open the `orbis://` form of
/// the TV's link, because a simulator cannot verify the orbis.p11a.xyz domain; the app reads both
/// forms the same way.
final class ApprovalUITests: XCTestCase {
  private var steps: [[String: Any]] = []

  /// A link opens the sheet, Sign In as the Person approves it, the TV's wait gets a key that
  /// works, the TV leads the device list, and a swipe signs it out.
  func testALinkApprovesATVAndSettingsSignsItOut() throws {
    let lane = try LaneService()
    let username = try lane.me().username
    let label = "Orbis on Journey TV \(Self.suffix())"
    let request = try lane.startApprovalRequest(label: label)
    let app = launchOrbis(address: lane.address, token: lane.token)
    XCTAssertTrue(
      app.tabBars.buttons["Home"].waitForExistence(timeout: 60),
      "the app must open signed in\n\(app.debugDescription)")

    app.open(Self.link(request.code))

    let title = app.staticTexts["approval-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 30), "the link must open the sheet\n\(app.debugDescription)")
    XCTAssertEqual(title.label, "Sign in Apple TV?", "the sheet names the platform")
    XCTAssertEqual(app.staticTexts["approval-label"].label, label, "and the TV's label")
    XCTAssertTrue(
      app.staticTexts["approval-age"].label.hasPrefix("Asked "),
      "the sheet says how long ago the TV asked: \(app.staticTexts["approval-age"].label)")
    let shownCode = app.staticTexts["approval-code"].label
    XCTAssertTrue(
      shownCode.hasSuffix("\(request.code.prefix(3)) \(request.code.suffix(3))"),
      "the sheet shows the TV's code in two groups: \(shownCode)")
    let approve = app.buttons["approval-approve"]
    XCTAssertEqual(approve.label, "Sign In as \(username)", "the button names the account the TV gets")
    capture("approval-01-sheet")
    step("the link opens the sheet with the platform, the age, and the code", ["code": shownCode])

    approve.tap()
    XCTAssertTrue(
      app.staticTexts["approval-approved"].waitForExistence(timeout: 15),
      "approving must say the TV is signed in\n\(app.debugDescription)")
    capture("approval-02-approved")
    let answer = try lane.waitForApproval(request.secret)
    XCTAssertEqual(answer.status, "approved", "the TV's wait must get a key")
    let key = try XCTUnwrap(answer.key)
    let tv = try LaneService(tokenOverride: key)
    XCTAssertEqual(try tv.me().username, username, "the TV signs in as the approving Person")
    let device = try XCTUnwrap(
      try lane.devices().first { $0.label == label }, "the service lists the TV under its label")
    step("Sign In as the Person approves, and the TV's wait gets a key for that Person")

    app.buttons["approval-done"].tap()
    openSettings(app)
    let row = app.descendants(matching: .any)["device-\(device.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 15), "Settings must list the TV\n\(app.debugDescription)")
    XCTAssertTrue(row.label.contains(label), row.label)
    let addDevice = app.buttons["settings-add-device"]
    XCTAssertLessThan(addDevice.frame.minY, row.frame.minY, "Add a Device comes before every device")
    let thisDevice = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'device-' AND label CONTAINS %@", "This Device"))
      .firstMatch
    XCTAssertTrue(thisDevice.exists, "one row is marked This Device\n\(app.debugDescription)")
    XCTAssertLessThan(row.frame.minY, thisDevice.frame.minY, "the newest device leads the list")
    capture("approval-03-device-list")
    step("Settings lists the TV first under Add a Device, above This Device")

    row.swipeLeft()
    // A swipe action can drop its identifier, so it is found by its words, apart from the Sign Out
    // at the foot of Settings.
    let signOut = app.buttons.matching(
      NSPredicate(format: "label == 'Sign Out' AND identifier != 'settings-sign-out'")
    ).firstMatch
    XCTAssertTrue(signOut.waitForExistence(timeout: 10), "a swipe offers Sign Out\n\(app.debugDescription)")
    capture("approval-04-swipe-sign-out")
    signOut.tap()
    XCTAssertTrue(
      waitUntil(timeout: 15) { !row.exists }, "the TV leaves the list\n\(app.debugDescription)")
    XCTAssertEqual(try tv.meStatus(), 401, "the service refuses the TV's key")
    capture("approval-05-signed-out")
    step("a Sign Out swipe revokes the TV's key")
    app.terminate()
    record("approve-link")
  }

  /// Cancel closes the sheet and leaves the TV's request waiting; an unknown code says it expired.
  func testCancelLeavesTheRequestAndAnUnknownCodeHasExpired() throws {
    let lane = try LaneService()
    let request = try lane.startApprovalRequest(label: "Orbis on Cancelled TV \(Self.suffix())")
    let app = launchOrbis(address: lane.address, token: lane.token)
    XCTAssertTrue(
      app.tabBars.buttons["Home"].waitForExistence(timeout: 60),
      "the app must open signed in\n\(app.debugDescription)")

    app.open(Self.link(request.code))
    let cancel = app.buttons["approval-cancel"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 30), "the link must open the sheet\n\(app.debugDescription)")
    cancel.tap()
    XCTAssertTrue(
      waitUntil(timeout: 10) { !app.staticTexts["approval-title"].exists }, "Cancel closes the sheet")
    XCTAssertEqual(try lane.findApprovalRequest(request.code), 200, "Cancel leaves the request waiting")
    step("Cancel closes the sheet and the request still waits")

    let unknown = request.code == "000000" ? "000001" : "000000"
    app.open(Self.link(unknown))
    let expired = app.staticTexts["approval-expired"]
    XCTAssertTrue(expired.waitForExistence(timeout: 30), "an unknown code must say so\n\(app.debugDescription)")
    XCTAssertEqual(expired.label, "This code has expired. Check the TV for a new one.")
    capture("approval-06-expired")
    step("an unknown code says it has expired", ["message": expired.label])
    app.buttons["approval-done"].tap()
    app.terminate()
    record("approve-cancel-expired")
  }

  /// A signed-out phone keeps the code through sign-in, then shows the sheet.
  func testASignedOutPhoneKeepsTheCodeThroughSignIn() throws {
    let lane = try LaneService()
    let before = Set(try lane.devices().map(\.id))
    let request = try lane.startApprovalRequest(label: "Orbis on Later TV \(Self.suffix())")
    let app = launchOrbis(address: lane.address, keychain: true)
    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30), "the app must open signed out")

    app.open(Self.link(request.code))
    XCTAssertTrue(
      app.staticTexts["signin-approval-notice"].waitForExistence(timeout: 15),
      "a signed-out phone asks to sign in first\n\(app.debugDescription)")
    XCTAssertFalse(app.staticTexts["approval-title"].exists, "the sheet waits for sign-in")
    capture("approval-07-signed-out")
    step("a signed-out phone keeps the code and asks to sign in")

    haveCode.tap()
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    // One key at a time, as SignInUITests types: a burst can lose a key while the slots
    // rewrite. The last key fills the slots, which submits the form and removes the field.
    let signInCode = try lane.signInCode()
    for character in signInCode.dropLast() {
      let before = field.value as? String
      field.typeText(String(character))
      _ = waitUntil(timeout: 2) { field.value as? String != before }
    }
    field.typeText(String(signInCode.suffix(1)))

    let approve = app.buttons["approval-approve"]
    XCTAssertTrue(
      approve.waitForExistence(timeout: 30), "signing in must show the sheet\n\(app.debugDescription)")
    capture("approval-08-after-sign-in")
    approve.tap()
    XCTAssertTrue(app.staticTexts["approval-approved"].waitForExistence(timeout: 15))
    XCTAssertEqual(try lane.waitForApproval(request.secret).status, "approved")
    step("after sign-in the sheet shows, and approving gives the TV its key")
    app.terminate()

    for added in try lane.devices() where !before.contains(added.id) {
      XCTAssertEqual(try lane.revokeDevice(added.id), 200)
    }
    record("approve-after-sign-in")
  }

  // MARK: - Helpers

  private static func link(_ code: String) -> URL {
    URL(string: "orbis://pair#\(code)")!
  }

  private func openSettings(_ app: XCUIApplication) {
    let gear = app.buttons["settings-open"].firstMatch
    XCTAssertTrue(gear.waitForExistence(timeout: 30), "Home must offer Settings")
    gear.tap()
  }

  private func waitUntil(timeout: TimeInterval, _ condition: () throws -> Bool) rethrows -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if try condition() { return true }
      usleep(250_000)
    } while Date() < deadline
    return try condition()
  }

  private static func suffix() -> String {
    String(UUID().uuidString.prefix(6)).lowercased()
  }

  private func step(_ name: String, _ detail: [String: Any] = [:]) {
    steps.append(detail.merging(["name": name]) { current, _ in current })
  }

  private func record(_ name: String) {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: ["steps": steps], options: [.prettyPrinted, .sortedKeys])
    else { return }
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
    steps = []
  }
}
