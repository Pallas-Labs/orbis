import CoreImage
import UIKit
import XCTest

/// The signed-out TV (ADR 0022), against the lane's service. The lane's Approval Requests live 12
/// seconds rather than 2 minutes, so a journey sees the TV replace an expired code by itself.
/// Every screen is captured, and each journey records what it read as JSON.
final class TVSignInJourney: XCTestCase {
  private var app: XCUIApplication?

  override func tearDown() {
    app?.terminate()
    app = nil
    super.tearDown()
  }

  /// The TV opens on the code, replaces it when it expires, and signs in when the lane's Person
  /// approves the new one, as Add a Device on their phone would.
  func testApprovingTheCodeOnAPhoneSignsTheTVIn() throws {
    let host = try LaneService()
    let devicesBefore = try host.devices().count
    let app = launchOrbis(address: host.address)
    self.app = app
    let code = app.descendants(matching: .any)["approval-code"]

    XCTAssertTrue(
      waitUntil(timeout: 30) { Self.digits(code) != nil },
      "A signed-out TV must open on an Approval Code\n\(app.debugDescription)")
    let first = try XCTUnwrap(Self.digits(code))
    let link = "https://orbis.p11a.xyz/pair#\(first)"
    let qr = app.descendants(matching: .any)["approval-qr"]
    XCTAssertEqual(qr.value as? String, link, "The QR must carry the /pair link for the code on screen")
    XCTAssertTrue(waitUntilSettled(qr), "The sign-in screen must come to rest")
    // Read from the pixels on screen, so this proves what a phone's camera would read.
    let scanned = Self.qrMessages(in: XCUIScreen.main.screenshot())
    XCTAssertEqual(scanned, [link], "The QR on screen must decode to the /pair link")
    XCTAssertTrue(app.staticTexts["or"].exists, "The code sits beside the QR with \"or\"")
    XCTAssertTrue(app.buttons["signin-other-ways"].exists, "Other Ways to Sign In is on the screen")
    XCTAssertFalse(app.buttons["signin-new"].exists, "No choice comes before the code")
    let texts = app.staticTexts.allElementsBoundByIndex.map(\.label)
    XCTAssertFalse(
      texts.contains { $0.range(of: #"\d+:\d\d"#, options: .regularExpression) != nil },
      "The screen shows no countdown: \(texts)")
    XCTAssertFalse(
      texts.contains { $0.range(of: #"^(Step )?\d[.)]?\s"#, options: .regularExpression) != nil },
      "The screen numbers no steps: \(texts)")
    capture("tv-sign-in-01-code")

    XCTAssertTrue(
      waitUntil(timeout: 30) { Self.digits(code).map { $0 != first } ?? false },
      "An expired code must give way to a new one with no button pressed\n\(app.debugDescription)")
    let second = try XCTUnwrap(Self.digits(code))
    XCTAssertEqual(qr.value as? String, "https://orbis.p11a.xyz/pair#\(second)")
    capture("tv-sign-in-02-new-code")

    let approvedAt = Date()
    let approved = try host.approveSignInRequest(second)
    XCTAssertEqual(approved.platform, "tvOS")
    let welcome = app.descendants(matching: .any)["signin-welcome"]
    XCTAssertTrue(
      welcome.waitForExistence(timeout: 5), "Approval must sign the TV in\n\(app.debugDescription)")
    let greeting = welcome.label
    XCTAssertEqual(greeting, "Signed in as host")
    capture("tv-sign-in-03-welcome")
    XCTAssertTrue(
      app.descendants(matching: .any)["tv-home"].waitForExistence(timeout: 5),
      "The TV must go to Home\n\(app.debugDescription)")
    let secondsToHome = Date().timeIntervalSince(approvedAt)
    XCTAssertLessThanOrEqual(secondsToHome, 5, "The TV must reach Home within 5 seconds of approval")
    XCTAssertTrue(waitUntil { !welcome.exists }, "The greeting must fade")
    capture("tv-sign-in-04-home")

    let devices = try host.devices()
    XCTAssertEqual(devices.count, devicesBefore + 1, "The approval must add one key for the host")
    XCTAssertTrue(
      devices.contains { $0.label == approved.label }, "The new key carries the TV's label")
    try record(
      "tv-sign-in-approved",
      [
        "firstCode": first, "secondCode": second, "scannedLink": scanned.first ?? "",
        "screenTexts": texts, "welcome": greeting,
        "secondsToHome": secondsToHome, "label": approved.label,
      ])
  }

  /// Other Ways to Sign In reaches the Group Passcode and Sign-in Code forms with the remote.
  func testOtherWaysReachTheGroupPasscodeAndSignInCodeForms() throws {
    let host = try LaneService()
    let app = launchOrbis(address: host.address)
    self.app = app
    let remote = XCUIRemote.shared

    let otherWays = app.buttons["signin-other-ways"]
    XCTAssertTrue(otherWays.waitForExistence(timeout: 30))
    XCTAssertTrue(moveFocus(to: otherWays, pressing: .down, limit: 3), "Other Ways must take focus")
    remote.press(.select)

    let passcode = app.buttons["signin-new"]
    let signInCode = app.buttons["signin-have-code"]
    XCTAssertTrue(passcode.waitForExistence(timeout: 10), "Other Ways must offer the Group Passcode")
    XCTAssertTrue(signInCode.exists, "Other Ways must offer the Sign-in Code")
    XCTAssertTrue(waitUntilSettled(signInCode), "Other Ways must come to rest")
    capture("tv-sign-in-05-other-ways")

    XCTAssertTrue(
      moveFocus(to: passcode, pressing: .up, limit: 3), "I Have a Group Passcode must take focus")
    remote.press(.select)
    let username = app.textFields["signin-username"]
    XCTAssertTrue(
      username.waitForExistence(timeout: 10), "The Group Passcode form must open\n\(app.debugDescription)")
    XCTAssertTrue(app.textFields["signin-passcode"].exists, "The form asks for the passcode")
    XCTAssertTrue(waitUntilSettled(username), "The form must come to rest")
    capture("tv-sign-in-06-passcode-form")

    // Menu leaves the form and returns to Other Ways; the TV's own keyboard may be up first.
    XCTAssertTrue(
      pressUntil(.menu, limit: 3) { signInCode.exists && signInCode.isHittable },
      "Menu must return to Other Ways\n\(app.debugDescription)")
    XCTAssertTrue(
      moveFocus(to: signInCode, pressing: .down, limit: 3), "I Have a Sign-in Code must take focus")
    remote.press(.select)
    let codeField = app.textFields["signin-code"]
    XCTAssertTrue(
      codeField.waitForExistence(timeout: 10), "The Sign-in Code form must open\n\(app.debugDescription)")
    XCTAssertTrue(waitUntilSettled(codeField), "The form must come to rest")
    capture("tv-sign-in-07-code-form")
  }

  /// After the limit the TV stops asking and offers Show a New Code, which starts again.
  func testStopsAfterTheLimitAndShowsANewCodeOnRequest() throws {
    let host = try LaneService()
    // 20 seconds stands in for 15 minutes: a request lives 12, so the TV replaces one first.
    let app = launchOrbis(address: host.address, arguments: ["-orbisApprovalLimitSeconds", "20"])
    self.app = app
    let code = app.descendants(matching: .any)["approval-code"]
    let newCode = app.buttons["approval-new-code"]

    XCTAssertTrue(waitUntil(timeout: 30) { Self.digits(code) != nil }, "The TV must show a code")
    XCTAssertTrue(
      newCode.waitForExistence(timeout: 40),
      "After the limit the TV must offer Show a New Code\n\(app.debugDescription)")
    XCTAssertFalse(code.exists, "A stopped TV shows no code")
    capture("tv-sign-in-08-stopped")
    // Longer than a request lives: a TV still asking would have a new code by now.
    sleep(13)
    XCTAssertTrue(newCode.exists, "The TV stays stopped")
    XCTAssertFalse(code.exists, "A stopped TV starts no new request")

    XCTAssertTrue(
      moveFocus(to: newCode, pressing: .up, limit: 4), "Show a New Code must take focus")
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(
      waitUntil(timeout: 15) { Self.digits(code) != nil },
      "Show a New Code must show a code again\n\(app.debugDescription)")
    XCTAssertFalse(newCode.exists)
    capture("tv-sign-in-09-code-again")
    try record("tv-sign-in-stopped", ["codeAgain": Self.digits(code) ?? ""])
  }

  /// The six digits the code's slots show, or nil while they are empty.
  private static func digits(_ element: XCUIElement) -> String? {
    guard element.exists, let value = element.value as? String else { return nil }
    let digits = value.filter(\.isNumber)
    return digits.count == 6 ? digits : nil
  }

  private static func qrMessages(in screenshot: XCUIScreenshot) -> [String] {
    guard let image = CIImage(image: screenshot.image),
      let detector = CIDetector(
        ofType: CIDetectorTypeQRCode, context: nil,
        options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
    else { return [] }
    return detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
  }
}
