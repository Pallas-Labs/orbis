import XCTest

@testable import Orbis

/// A TV's QR code opens `https://orbis.p11a.xyz/pair#482719` (ADR 0022), and the lane opens the
/// same link as `orbis://pair#482719`. Each test rules out one way the app could read the wrong
/// code, or read a code from a link that is not an Approval link:
///
/// - the code is read from the fragment, never from the query or the path
/// - a link to another host, another path, or another scheme yields no code
/// - a fragment that is not six digits after spaces are dropped yields no code
/// - the code shows as two groups of three, the way the TV shows it
final class ApprovalLinkTests: XCTestCase {
  func testTheCodeComesFromTheFragment() {
    XCTAssertEqual(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#482719")!), "482719")
    XCTAssertEqual(ApprovalLink.code(in: URL(string: "https://ORBIS.p11a.xyz/pair#482719")!), "482719")
    XCTAssertEqual(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair/#482719")!), "482719")
    XCTAssertEqual(ApprovalLink.code(in: URL(string: "orbis://pair#482719")!), "482719")
    XCTAssertEqual(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#482%20719")!), "482719")
  }

  func testOtherLinksCarryNoCode() {
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair?code=482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair/482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/join#482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/s/482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://example.com/pair#482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz.example.com/pair#482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "http://orbis.p11a.xyz/pair#482719")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "orbis://join#482719")!))
  }

  func testAFragmentThatIsNotSixDigitsCarriesNoCode() {
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#48271")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#4827190")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#48271a")!))
    XCTAssertNil(ApprovalLink.code(in: URL(string: "https://orbis.p11a.xyz/pair#٤٨٢٧١٩")!))
  }

  func testTheCodeShowsInTwoGroups() {
    XCTAssertEqual(ApprovalLink.formatted("482719"), "482 719")
    XCTAssertEqual(ApprovalLink.formatted("4827"), "4827")
  }
}
