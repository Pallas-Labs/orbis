import UIKit
import XCTest

/// Signing in and Settings (ADR 0020), against the lane's service. The Group Passcode is one
/// value for the whole service, so every journey that reads or changes it lives in this class,
/// which runs its tests one after another on one simulator.
final class SignInUITests: XCTestCase {
  /// A shown code reads in its two groups, with a gap and no dash.
  private static let codePattern =
    "^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4} [ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$"
  private static let passcodePattern = "^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$"

  private var steps: [[String: Any]] = []

  // MARK: - Journeys

  /// A fresh install joins with a Join Link pasted into the passcode slots, keeps its key across a
  /// relaunch, shows and copies a Sign-in Code for another device, has no Host sections, signs
  /// out, and signs back in by pasting the code it copied.
  func testANewPersonJoinsWithThePasscodeAndAddsADevice() throws {
    let host = try LaneService()
    let username = "journey-\(Self.suffix())"
    let passcode = try host.newPasscode()

    // The key must reach the keychain, because the relaunch below reads it back.
    let app = launchOrbis(address: host.address, keychain: true)

    let new = app.buttons["signin-new"]
    XCTAssertTrue(new.waitForExistence(timeout: 30), "a fresh install must offer I Have a Group Passcode")
    XCTAssertTrue(app.buttons["signin-have-code"].exists, "and I Have a Sign-in Code")
    XCTAssertEqual(
      app.textFields.count + app.secureTextFields.count, 0,
      "the first screen asks for no address, key, or device name\n\(app.debugDescription)")
    capture("01-signed-out")
    step("a fresh install offers two choices and no fields")

    new.tap()
    let usernameField = app.textFields["signin-username"]
    XCTAssertTrue(usernameField.waitForExistence(timeout: 10))
    usernameField.tap()
    usernameField.typeText(username)
    let passcodeField = app.textFields["signin-passcode"]
    passcodeField.tap()
    type("not-the-passcode", into: passcodeField)
    XCTAssertEqual(
      passcodeField.value as? String, "NTTHEPASSCDE",
      "dashes and look-alikes drop out, and the twelve that remain fill the slots")

    let error = app.staticTexts["signin-error"]
    XCTAssertTrue(
      error.waitForExistence(timeout: 30),
      "a full wrong passcode is sent as the last slot fills, and refused\n\(app.debugDescription)")
    XCTAssertFalse(
      error.label.hasPrefix("The service"), "the service's own sentence is shown: \(error.label)")
    XCTAssertTrue(app.buttons["copy-failure"].exists, "a failure offers its details to copy")
    capture("02-wrong-passcode")
    step("a wrong passcode shows the service's sentence", ["message": error.label])

    // A Join Link pasted into the passcode keeps only the passcode, and the full slots join.
    let joinLink = "https://orbis.p11a.xyz/join#\(passcode.lowercased())"
    replaceText(in: passcodeField, with: "", app: app)
    paste(joinLink, into: passcodeField, app: app)
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "joining must land in the library\n\(app.debugDescription)")
    // A new Person has no Sets, so Home is the first screen they see with nothing on it. It once
    // showed only a strip of glow down the middle.
    XCTAssertTrue(
      app.descendants(matching: .any)["home-empty"].waitForExistence(timeout: 15),
      "a new Person's Home must say the collection is empty\n\(app.debugDescription)")
    capture("03-joined")
    XCTAssertTrue(
      try host.people().contains { $0.username == username },
      "the Host's People must list the new Person")
    step(
      "a pasted Join Link fills the passcode, creates the Person, and signs in",
      ["username": username, "pasted": joinLink])

    app.terminate()
    app.launchArguments = ["-orbisServiceAddress", host.address]
    app.launch()
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a relaunch must keep the key\n\(app.debugDescription)")
    step("a relaunch reads the key back from the keychain")

    openSettings(app)
    let account = app.buttons["settings-account"]
    XCTAssertTrue(account.waitForExistence(timeout: 15))
    XCTAssertTrue(account.label.contains(username), "the account card names the Person: \(account.label)")
    let another = app.buttons["settings-sign-in-another"]
    reveal(another, in: app)
    another.tap()
    let code = app.staticTexts["settings-sign-in-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "Settings must show a Sign-in Code")
    XCTAssertNotNil(
      code.label.range(of: Self.codePattern, options: .regularExpression),
      "the code is eight characters without look-alikes, shown in two groups: \(code.label)")
    let copy = app.buttons["settings-sign-in-code-copy"]
    XCTAssertTrue(copy.exists, "the code can be copied\n\(app.debugDescription)")
    copy.tap()
    XCTAssertTrue(waitUntil(timeout: 5) { copy.label == "Copied" }, "copying says so: \(copy.label)")
    capture("04-settings-sign-in-code")
    assertNoHostSections(app)
    step(
      "Settings shows the Person's name and a Sign-in Code in slots, copies it, and shows no Host sections",
      ["code": code.label])

    let signOut = app.buttons["settings-sign-out"]
    reveal(signOut, in: app)
    signOut.tap()
    confirm("Sign Out", besides: "settings-sign-out", in: app)
    XCTAssertTrue(
      app.buttons["signin-new"].waitForExistence(timeout: 15),
      "signing out returns to the first screen\n\(app.debugDescription)")
    capture("05-signed-out-again")
    step("signing out forgets the key")

    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["signin-new"].waitForExistence(timeout: 30), "the key stays forgotten")

    let codeField = openCodeForm(app)
    paste(nil, into: codeField, app: app)
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "the code Settings copied pastes into the slots and signs in\n\(app.debugDescription)")
    capture("06-copied-code-signed-in")
    step("the copied Sign-in Code pastes into the slots and signs the device back in")
    app.terminate()
    record("join")
  }

  /// A fresh install signs in with a code another device showed, lowercase with its dash: pasted
  /// as it arrives in a message, and typed by hand, where a dash, a space, and the look-alikes
  /// change nothing. Each is sent as the last slot fills.
  func testACodeFromAnotherDeviceSignsIn() throws {
    let friend = try LaneService.settingsPerson()
    let devicesBefore = Set(try friend.devices().map(\.id))
    var app = launchOrbis(address: friend.address)

    let field = openCodeForm(app)
    paste("zzzz-zzzz", into: field, app: app)
    XCTAssertEqual(
      field.value as? String, "ZZZZZZZZ", "a pasted dashed code fills the slots in capitals")
    let error = app.staticTexts["signin-error"]
    XCTAssertTrue(
      error.waitForExistence(timeout: 30),
      "an unknown code is sent as the last slot fills, and refused\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["copy-failure"].exists)
    capture("01-unknown-code-pasted")
    step(
      "a pasted unknown code fills the slots and shows the service's sentence",
      ["message": error.label])

    let first = try friend.signInCode()
    let dashed = "\(first.prefix(4))-\(first.suffix(4))".lowercased()
    paste(dashed, into: field, app: app)
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a code pasted over the refused one replaces it and signs in\n\(app.debugDescription)")
    capture("02-signed-in-pasted")
    step(
      "a lowercase code with its dash, pasted over the full slots, replaces them and signs in",
      ["pasted": dashed])

    // Settings live in memory, so a relaunch starts signed out.
    app.terminate()
    app = launchOrbis(address: friend.address)
    let typedField = openCodeForm(app)
    let second = try friend.signInCode()
    let typed = "\(second.prefix(4))-\(second.suffix(4))".lowercased()
    type("- O0I1Lol", into: typedField)
    XCTAssertEqual(
      typedField.value as? String ?? "", "", "a dash, a space, O, 0, I, 1, and L change nothing")
    capture("03-look-alikes-change-nothing")
    step("a dash, a space, and look-alikes change nothing", ["typed": "- O0I1Lol"])
    type(typed.dropLast(), into: typedField)
    XCTAssertEqual(
      typedField.value as? String, String(second.prefix(7)),
      "typed characters fill the slots in capitals, and the dash adds nothing")
    capture("04-typed-code")
    typedField.typeText(String(typed.suffix(1)))
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a typed code must sign in as the last slot fills\n\(app.debugDescription)")
    capture("05-signed-in-typed")
    step("a code typed in lowercase with its dash signs in", ["typed": typed])

    var added: [LaneService.Device] = []
    XCTAssertTrue(
      try waitUntil(timeout: 15) {
        added = try friend.devices().filter { !devicesBefore.contains($0.id) }
        return added.count == 2 && added.allSatisfy { $0.lastUsedAt != nil }
      }, "each sign-in holds its own key and has used it")
    step("the service lists both devices", ["labels": added.map(\.label)])
    for device in added {
      XCTAssertEqual(try friend.revokeDevice(device.id), 200)
    }
    app.terminate()
    record("redeem")
  }

  func testAnUnreachableServiceNamesTheRecoveryAction() throws {
    let app = launchOrbis(address: "http://127.0.0.1:1")

    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30))
    haveCode.tap()
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("ABCDEFGH")

    let error = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Cannot reach your library")
    ).firstMatch
    XCTAssertTrue(
      error.waitForExistence(timeout: 60),
      "an unreachable service must explain itself\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["copy-failure"].exists, "a failure must offer its details to copy")
    capture("unreachable-service")
  }

  /// The Host's Settings shows the Group Passcode the service made, copies it, makes a new one
  /// after asking, shows a Person's Sign-in Code, removes a Person, and closes joining.
  func testTheHostManagesThePasscodeAndPeople() throws {
    let host = try LaneService()
    let before = try host.newPasscode()
    let leaving = try host.addPerson("journey-leaving-\(Self.suffix())")
    let app = launchOrbis(address: host.address, token: host.token)

    openSettings(app)
    let shown = app.staticTexts["settings-passcode-row"]
    reveal(shown, in: app)
    XCTAssertTrue(
      shown.waitForExistence(timeout: 15), "an open Group shows its passcode\n\(app.debugDescription)")
    XCTAssertEqual(shown.label, before, "Settings shows the passcode the service holds")
    XCTAssertNotNil(
      shown.label.range(of: Self.passcodePattern, options: .regularExpression),
      "the passcode is 12 characters without look-alikes or dashes: \(shown.label)")
    XCTAssertTrue(app.buttons["settings-passcode-share"].exists, "the passcode can be shared")
    let copy = app.buttons["settings-passcode-copy"]
    XCTAssertTrue(copy.exists, "the passcode can be copied\n\(app.debugDescription)")
    copy.tap()
    XCTAssertTrue(
      waitUntil(timeout: 5) { copy.label == "Copied" }, "copying says so: \(copy.label)")
    capture("01-host-settings")
    step("the Host's Settings shows the generated passcode and copies it", ["passcode": before])

    let renew = app.buttons["settings-passcode-new"]
    reveal(renew, in: app)
    renew.tap()
    confirm("New Passcode", besides: "settings-passcode-new", in: app)
    var after: String?
    XCTAssertTrue(
      try waitUntil(timeout: 15) {
        after = try host.passcode()
        return after != nil && after != before
      }, "a new passcode reaches the service")
    XCTAssertNotNil(after?.range(of: Self.passcodePattern, options: .regularExpression))
    XCTAssertTrue(
      waitUntil(timeout: 10) { shown.label == after }, "Settings shows the new passcode: \(shown.label)")
    capture("02-new-passcode")
    step("New Passcode asks first, then replaces the passcode", ["after": after ?? ""])

    let friendRow = app.buttons["person-lane-settings"]
    reveal(friendRow, in: app)
    XCTAssertTrue(friendRow.exists, "People lists the Group\n\(app.debugDescription)")
    friendRow.tap()
    let show = app.buttons["person-show-code"]
    XCTAssertTrue(show.waitForExistence(timeout: 10))
    show.tap()
    let code = app.staticTexts["person-sign-in-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "the Host can show a friend's code")
    XCTAssertNotNil(code.label.range(of: Self.codePattern, options: .regularExpression))
    capture("03-person-sign-in-code")
    step("the Host shows a Sign-in Code for a friend")
    app.navigationBars.buttons.element(boundBy: 0).tap()

    let leavingRow = app.buttons["person-\(leaving.username)"]
    reveal(leavingRow, in: app)
    leavingRow.tap()
    let remove = app.buttons["person-remove"]
    XCTAssertTrue(remove.waitForExistence(timeout: 10))
    remove.tap()
    confirm("Remove", besides: "person-remove", in: app)
    XCTAssertTrue(
      try waitUntil(timeout: 15) { try !host.people().contains { $0.id == leaving.id } },
      "removing a Person reaches the service")
    XCTAssertTrue(
      waitUntil(timeout: 10) { !leavingRow.exists }, "and leaves the People list")
    step("the Host removes a Person after confirming")

    let joining = app.switches["settings-joining"]
    // Revealing the leaving row can scroll the Host's switch off the top when the Group is long.
    reveal(joining, in: app, towardTop: true)
    joining.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertTrue(
      try waitUntil(timeout: 15) { try host.passcode() == nil }, "closing joining clears it")
    let state = app.staticTexts["settings-passcode-state"]
    XCTAssertTrue(
      waitUntil(timeout: 10) { state.exists && state.label.hasPrefix("Joining is closed") },
      "Settings says joining is closed\n\(app.debugDescription)")
    XCTAssertFalse(shown.exists, "a closed Group shows no passcode")
    capture("04-joining-closed")
    step("closing joining clears the passcode")

    joining.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    var reopened: String?
    XCTAssertTrue(
      try waitUntil(timeout: 15) {
        reopened = try host.passcode()
        return reopened != nil
      }, "turning joining on makes a passcode")
    XCTAssertTrue(
      shown.waitForExistence(timeout: 10) && shown.label == reopened,
      "Settings shows it: \(shown.label)")
    capture("05-joining-reopened")
    step("turning joining on makes a new passcode at once", ["passcode": reopened ?? ""])
    app.terminate()
    record("host")
  }

  /// A friend's Auto Download shows what the service stores, a change follows them across a
  /// relaunch, and their Settings has no Host sections. The journey starts from whatever the
  /// lane seeded and leaves it as it found it.
  func testAFriendsSettingsKeepAutoDownloadAndHaveNoHostSections() throws {
    let friend = try LaneService.settingsPerson()
    let stored = try friend.autoDownload()
    let switchValue = { (enabled: Bool) in enabled ? "1" : "0" }
    let app = launchOrbis(address: friend.address, token: friend.token)
    openSettings(app)
    let toggle = app.switches["auto-download"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    XCTAssertEqual(toggle.value as? String, switchValue(stored), "the toggle shows the stored value")
    capture("auto-download-as-stored")
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertTrue(waitUntil(timeout: 10) { toggle.value as? String == switchValue(!stored) })
    let afterChange = try friend.autoDownload(becomes: !stored)
    XCTAssertEqual(afterChange, !stored, "the change reaches the service")
    capture("auto-download-changed")
    assertNoHostSections(app)
    capture("friend-settings-end")
    app.terminate()
    app.launch()
    openSettings(app)
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    let afterRelaunch = toggle.value as? String == switchValue(!stored)
    XCTAssertTrue(afterRelaunch, "the change survives a relaunch")
    capture("auto-download-changed-reopened")
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    let restored = try friend.autoDownload(becomes: stored)
    XCTAssertEqual(restored, stored, "the journey restores the stored value")
    capture("auto-download-restored")
    steps = [
      [
        "afterChange": afterChange, "afterRelaunch": afterRelaunch, "name": "auto download",
        "restored": restored, "stored": stored,
      ]
    ]
    record("auto-download-settings")
  }

  // MARK: - Helpers

  /// Opens the Sign-in Code form from the first screen and returns its field, focused.
  private func openCodeForm(_ app: XCUIApplication) -> XCUIElement {
    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30), "the first screen offers a Sign-in Code")
    haveCode.tap()
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "\(app.debugDescription)")
    field.tap()
    return field
  }

  /// Types one character at a time and lets the field settle after each, as a person types. A
  /// burst can land while the field rewrites what it holds and lose a key.
  private func type(_ text: some StringProtocol, into field: XCUIElement) {
    for character in text {
      let before = field.value as? String
      field.typeText(String(character))
      _ = waitUntil(timeout: 2) { field.value as? String != before }
    }
  }

  /// Pastes into `field` with the edit menu, as a person pastes a code from Messages. With
  /// `text`, the runner puts it on the pasteboard first; without, what the app copied is pasted.
  private func paste(_ text: String?, into field: XCUIElement, app: XCUIApplication) {
    if let text {
      UIPasteboard.general.string = text
    }
    field.press(forDuration: 1.2)
    let menuItem = app.menuItems["Paste"].firstMatch
    let button = app.buttons["Paste"].firstMatch
    XCTAssertTrue(
      waitUntil(timeout: 5) { menuItem.exists || button.exists },
      "a long press offers Paste\n\(app.debugDescription)")
    (menuItem.exists ? menuItem : button).tap()
  }

  private func openSettings(_ app: XCUIApplication) {
    let gear = app.buttons["settings-open"].firstMatch
    XCTAssertTrue(gear.waitForExistence(timeout: 30), "Home must offer Settings")
    gear.tap()
  }

  /// Scrolls to the version at the foot of Settings, where the Host's sections would sit just
  /// above, and checks they are not there.
  private func assertNoHostSections(_ app: XCUIApplication) {
    let version = app.staticTexts["settings-version"]
    reveal(version, in: app)
    XCTAssertTrue(version.exists, "Settings ends with the app version\n\(app.debugDescription)")
    XCTAssertTrue(version.label.hasPrefix("Orbis "), version.label)
    XCTAssertFalse(
      app.switches["settings-joining"].exists, "a friend must not see joining")
    XCTAssertEqual(
      app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'person-'")).count, 0,
      "a friend must not see People")
  }

  /// Scrolls the Settings sheet until `element` is on screen, down the form or, with `towardTop`,
  /// back up it. A grouped form only builds the rows it shows.
  private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
    var swipes = 0
    while !(element.exists && element.isHittable), swipes < 6 {
      if towardTop { app.swipeDown() } else { app.swipeUp() }
      swipes += 1
    }
  }

  /// Taps the confirming button of a dialog, which carries the same words as a row behind it.
  private func confirm(_ label: String, besides identifier: String, in app: XCUIApplication) {
    let button = app.buttons.matching(
      NSPredicate(format: "label == %@ AND identifier != %@", label, identifier)
    ).firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 10), "the dialog must ask first")
    button.tap()
  }

  /// Deletes what a field holds and types `text`. More deletes than the field can hold, with the
  /// cursor put at the end.
  private func replaceText(in field: XCUIElement, with text: String, app: XCUIApplication) {
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + text)
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
