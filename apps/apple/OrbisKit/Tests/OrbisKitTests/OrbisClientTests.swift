import Foundation
import OrbisKitTesting
import XCTest

@testable import OrbisKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class OrbisClientTests: XCTestCase {
  /// The service address carries `/api`. Every request keeps that segment, with or without a
  /// trailing slash, and an address without a path still resolves as before.
  func testRequestsKeepTheAddressPath() async throws {
    for (address, expected) in [
      ("https://orbis.example/api", "https://orbis.example/api/sets"),
      ("https://orbis.example/api/", "https://orbis.example/api/sets"),
      ("https://orbis.example", "https://orbis.example/sets"),
    ] {
      let client = OrbisClient(
        address: try XCTUnwrap(URL(string: address)),
        token: "token",
        session: StubProtocol.session(status: 200, body: #"{"sets":[]}"#))
      _ = try await client.library()
      XCTAssertEqual(StubProtocol.lastRequest?.url?.absoluteString, expected)
    }
  }

  /// The bearer token rides on every request, so an address carries it only over TLS. The
  /// loopback exception is the temporary lane service, which the server itself trusts.
  func testAnAddressCarriesTheTokenOnlyOverTLSOrLoopback() throws {
    for input in ["https://orbis.example.test", "http://127.0.0.1:4310", "http://localhost:4310"] {
      XCTAssertTrue(OrbisClient.accepts(try XCTUnwrap(URL(string: input))), input)
    }
    for input in ["http://orbis.example.test", "ftp://orbis.example.test"] {
      XCTAssertFalse(OrbisClient.accepts(try XCTUnwrap(URL(string: input))), input)
    }
  }

  /// Join and redeem are the only requests without a key, and the Host's passcode is closed by
  /// sending null, not by leaving the field out. Each failure here is one the service reads as
  /// a bad request or an unauthenticated caller.
  func testSignInAndSettingsRequestsMatchTheContract() async throws {
    let address = try XCTUnwrap(URL(string: "https://orbis.example/api"))
    let signedIn = #"{"key":"synthetic-key","person":{"id":"p1","username":"ada"}}"#
    let signedOut = OrbisClient(
      address: address, token: "", session: StubProtocol.session(status: 201, body: signedIn))

    let joined = try await signedOut.join(
      username: "ada", passcode: "sesame", label: "Orbis on Mac")
    XCTAssertEqual(joined, "synthetic-key")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/api/sign-in/join")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertNil(
      StubProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
      "a signed-out device sends no key")
    XCTAssertEqual(
      try json(StubProtocol.lastBody),
      ["label": "Orbis on Mac", "passcode": "sesame", "username": "ada"])

    _ = try await signedOut.redeem(code: "ABCDEFGH", label: "Orbis on Mac")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/api/sign-in/code")
    XCTAssertEqual(try json(StubProtocol.lastBody), ["code": "ABCDEFGH", "label": "Orbis on Mac"])

    let opener = OrbisClient(
      address: address, token: "token",
      session: StubProtocol.session(status: 200, body: #"{"passcode":"K7MPX3QRW9TB"}"#))
    let opened = try await opener.newPasscode()
    XCTAssertEqual(opened, "K7MPX3QRW9TB")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/api/admin/passcode")
    XCTAssertNil(StubProtocol.lastBody, "the Host sends no passcode; the service makes it")

    let host = OrbisClient(
      address: address, token: "token",
      session: StubProtocol.session(status: 200, body: #"{"passcode":null}"#))
    let closed = try await host.closeJoining()
    XCTAssertNil(closed)
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "DELETE")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/api/admin/passcode")

    let me = #"{"autoDownload":true,"host":false,"id":"p1","social":true,"username":"ada"}"#
    let person = OrbisClient(
      address: address, token: "token", session: StubProtocol.session(status: 200, body: me))
    let updated = try await person.updateMe(MeUpdate(social: true))
    XCTAssertTrue(updated.social)
    XCTAssertEqual(
      try json(StubProtocol.lastBody), ["social": true], "an unchanged setting is left out")
  }

  private func json(_ data: Data?) throws -> NSDictionary {
    let object = try JSONSerialization.jsonObject(with: XCTUnwrap(data))
    return try XCTUnwrap(object as? NSDictionary)
  }

  /// The bare tailnet name answers with Caddy's page, which is the trap this whole thread is
  /// about. It must read as a web page, not as an unreadable answer or a refusal.
  /// A source the app does not know must not make the library unreadable. One new word
  /// from the service once failed every Set at once; it reads as its own name instead.
  func testASetFromANewerServiceWithAnUnknownSourceStillDecodes() async throws {
    let newer = Fixtures.savedSet(title: "Night session", tags: []).replacingOccurrences(
      of: "\"source\":\"youtube\"", with: "\"source\":\"bandcamp\"")
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(status: 200, body: "{\"sets\": [" + newer + "]}"))
    let sets = try await client.library()
    XCTAssertEqual(sets.count, 1)
    XCTAssertEqual(sets[0].source.label, "bandcamp")
  }

  func testAWebPageIsItsOwnFailure() async throws {
    for status in [200, 403] {
      let client = OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(
          status: status, body: "<!doctype html><html lang=\"en\"><head>")
      )
      do {
        _ = try await client.library()
        XCTFail("expected a web page to be refused at status \(status)")
      } catch let error as OrbisError {
        XCTAssertEqual(error, .notOrbis)
      } catch {
        XCTFail("unexpected \(error)")
      }
    }
  }

  func testFailuresMapToActionableCases() async throws {
    let cases: [(Int, String, OrbisError)] = [
      (401, #"{"message":"nope"}"#, .notSignedIn),
      (403, #"{"message":"nope"}"#, .server(status: 403, message: "nope")),
      (403, "{}", .server(status: 403, message: "")),
      (409, #"{"message":"This set is already in your library."}"#, .duplicate),
      (500, #"{"message":"Broken."}"#, .server(status: 500, message: "Broken.")),
      (200, "not json", .malformed),
    ]
    for (status, body, expected) in cases {
      let client = OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session(status: status, body: body)
      )
      do {
        _ = try await client.library()
        XCTFail("expected \(expected) for status \(status)")
      } catch let error as OrbisError {
        XCTAssertEqual(error, expected)
        XCTAssertFalse(error.message.isEmpty)
      } catch {
        XCTFail("unexpected \(error)")
      }
    }
  }

  /// A service older than this field must not make the library unreadable, which is exactly
  /// what happened when the field arrived.
  func testASetFromAnOlderServiceStillDecodes() async throws {
    let older = """
      {"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
      "title":"Night session","source":"youtube","tags":["techno"],"createdAt":"2026-01-01T00:00:00.000Z",
      "creator":null,"artworkUrl":null,"durationSeconds":null,"metadataState":"enriched",
      "downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
      "lastListenedAt":null}
      """
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(status: 200, body: #"{"sets":["# + older + "]}"))
    let sets = try await client.library()
    XCTAssertEqual(sets.count, 1)
    XCTAssertEqual(sets[0].title, "Night session")
    XCTAssertEqual(sets[0].playlistIds, [])
  }

  func testMetadataRetryAsksAgainForTheName() async throws {
    let session = StubProtocol.session(
      status: 200, body: Fixtures.savedSet(title: "Named at last", tags: []))
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: session
    )
    let updated = try await client.retryMetadata("42")
    XCTAssertEqual(updated.title, "Named at last")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42/metadata")
    XCTAssertNil(StubProtocol.lastBody)
  }

  func testLibraryAsksForOnePlaylistByItsIdentifier() async throws {
    let session = StubProtocol.session(status: 200, body: #"{"sets":[]}"#)
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: session
    )
    _ = try await client.library(playlistId: "abc")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.query(), "playlistId=abc")
  }

  func testACancelledRequestIsNotReportedAsUnreachable() async throws {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(failure: URLError(.cancelled))
    )
    do {
      _ = try await client.library()
      XCTFail("expected a cancellation")
    } catch let error as OrbisError {
      XCTAssertEqual(error, .cancelled)
    } catch {
      XCTFail("unexpected \(error)")
    }
  }
}
