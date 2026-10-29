import XCTest

@testable import Orbis

/// A Host shares `https://orbis.p11a.xyz/join#K7Q2M9XH4RPA` (PAL-1005 §2.3), and the lane opens
/// the same link as `orbis://join#K7Q2M9XH4RPA`. Each test rules out one way the app could join
/// with the wrong passcode, or read a passcode from a link that is not a Join Link:
///
/// - the passcode is read from the fragment, in capitals, never from the query or the path
/// - a link to another host, another path, or another scheme yields no passcode
/// - a link with no fragment, or a fragment that is not a whole passcode, yields no passcode
/// - the invitation names both steps and the link it shares
final class JoinLinkTests: XCTestCase {
  private func passcode(_ link: String) throws -> String? {
    JoinLink.passcode(in: try XCTUnwrap(URL(string: link)))
  }

  func testThePasscodeComesFromTheFragment() throws {
    XCTAssertEqual(try passcode("https://orbis.p11a.xyz/join#K7Q2M9XH4RPA"), "K7Q2M9XH4RPA")
    XCTAssertEqual(try passcode("https://ORBIS.p11a.xyz/join#K7Q2M9XH4RPA"), "K7Q2M9XH4RPA")
    XCTAssertEqual(try passcode("https://orbis.p11a.xyz/join/#K7Q2M9XH4RPA"), "K7Q2M9XH4RPA")
    XCTAssertEqual(try passcode("orbis://join#K7Q2M9XH4RPA"), "K7Q2M9XH4RPA")
    XCTAssertEqual(try passcode("orbis://join#k7q2m9xh4rpa"), "K7Q2M9XH4RPA")
    XCTAssertEqual(try passcode("orbis://join#K7Q2-M9XH-4RPA"), "K7Q2M9XH4RPA")
  }

  func testOtherLinksCarryNoPasscode() throws {
    XCTAssertNil(try passcode("https://example.com/join#K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("https://orbis.p11a.xyz.example.com/join#K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("http://orbis.p11a.xyz/join#K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("https://orbis.p11a.xyz/pair#K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("orbis://pair#K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("https://orbis.p11a.xyz/join/K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("https://orbis.p11a.xyz/join?passcode=K7Q2M9XH4RPA"))
    XCTAssertNil(try passcode("orbis://join/more#K7Q2M9XH4RPA"))
  }

  func testAFragmentThatIsNotAWholePasscodeCarriesNone() throws {
    XCTAssertNil(try passcode("https://orbis.p11a.xyz/join"))
    XCTAssertNil(try passcode("https://orbis.p11a.xyz/join#"))
    XCTAssertNil(try passcode("orbis://join"))
    XCTAssertNil(try passcode("orbis://join#K7Q2M9XH4RP"))
    XCTAssertNil(try passcode("orbis://join#K7Q2M9XH4RPAB"))
    // 0, O, 1, I and L are outside the alphabet, so a link holding them is not a whole passcode.
    XCTAssertNil(try passcode("orbis://join#K7Q2M9XH4RP0"))
  }

  func testTheLinkCarriesThePasscodeInItsFragment() {
    XCTAssertEqual(
      JoinLink.url(forPasscode: "K7Q2M9XH4RPA").absoluteString, "https://orbis.p11a.xyz/join#K7Q2M9XH4RPA")
    XCTAssertEqual(JoinLink.passcode(in: JoinLink.url(forPasscode: "K7Q2M9XH4RPA")), "K7Q2M9XH4RPA")
  }

  func testTheInvitationNamesBothStepsAndTheLink() {
    XCTAssertEqual(
      JoinLink.invitation(passcode: "K7Q2M9XH4RPA"),
      """
      Join me on Orbis.

      1. On your iPhone, open the TestFlight email from Apple and install Orbis.
      2. Then tap this link: https://orbis.p11a.xyz/join#K7Q2M9XH4RPA
      """)
  }
}
