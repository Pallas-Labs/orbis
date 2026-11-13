import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// Signing in stores the key the service hands back, and a sign-in that fails changes nothing
/// and says why in the service's own words (ADR 0020).
@MainActor
final class SignInTests: XCTestCase {
  nonisolated private static let playlistsBody =
    #"{"playlists":[{"id":"1","name":"Long drives","createdAt":"2026-01-01T00:00:00.000Z","setCount":4}]}"#

  private func signedOutModel(
    settings: any ClientSettingsStore = MemoryClientSettings(),
    responder: @Sendable @escaping (URLRequest) -> (Int, String)
  ) -> AppModel {
    AppModel(settings: settings, session: StubProtocol.session(responder: responder))
  }

  func testACodeSignsInStoresTheKeyAndLoadsTheShell() async {
    let settings = MemoryClientSettings()
    let model = signedOutModel(settings: settings) { request in
      switch request.url?.path() {
      case let path? where path.hasSuffix("/sign-in/code"):
        (200, #"{"key":"synthetic-new-key","person":{"id":"p1","username":"ada"}}"#)
      case let path? where path.hasSuffix("/sets"):
        (200, "{\"sets\":[" + Fixtures.savedSet(title: "Night session", tags: []) + "]}")
      case let path? where path.hasSuffix("/playlists"):
        (200, Self.playlistsBody)
      default:
        (500, "{}")
      }
    }
    XCTAssertFalse(model.isConfigured)

    await model.signIn(.code("abcd efgh"))

    XCTAssertNil(model.signInFailure)
    XCTAssertEqual(settings.deviceToken, "synthetic-new-key", "the key must reach storage")
    XCTAssertEqual(model.client?.token, "synthetic-new-key")
    guard case .loaded(let sets) = model.library else {
      return XCTFail("signing in must load the library")
    }
    XCTAssertEqual(sets.map(\.title), ["Night session"])
    guard case .loaded(let playlists) = model.playlists else {
      return XCTFail("signing in must load the sidebar's playlists")
    }
    XCTAssertEqual(playlists.map(\.name), ["Long drives"])

    model.signOut()

    XCTAssertNil(settings.deviceToken, "signing out must forget the key")
    XCTAssertFalse(model.isConfigured)
  }

  /// A taken username is the service's to explain, and it explains it in a sentence meant for
  /// the person.
  func testARefusalShowsTheServiceSentenceAndStaysSignedOut() async {
    let settings = MemoryClientSettings()
    let model = signedOutModel(settings: settings) { _ in
      (409, #"{"message":"That username is already in use."}"#)
    }

    await model.signIn(.join(username: "ada", passcode: "ABCDEFGHJKMN"))

    XCTAssertEqual(model.signInFailure?.message, "That username is already in use.")
    XCTAssertNil(model.refusedCode, "a taken username is not the passcode's fault")
    XCTAssertFalse(model.isSigningIn)
    XCTAssertFalse(model.isConfigured)
    XCTAssertNil(settings.deviceToken)
  }

  /// A device that refuses to hold the key stays signed out and says so, rather than reading
  /// as signed in until the next launch.
  func testARefusedSaveStaysSignedOutAndSaysSo() async {
    let settings = RefusingClientSettings()
    let model = signedOutModel(settings: settings) { _ in
      (201, #"{"key":"synthetic-new-key","person":{"id":"p1","username":"ada"}}"#)
    }

    await model.signIn(.join(username: "ada", passcode: "open sesame"))

    XCTAssertEqual(settings.storeAttempts, 1, "the key is offered to the store once")
    XCTAssertFalse(model.isConfigured)
    guard let failure = model.signInFailure else {
      return XCTFail("a refused save must say so")
    }
    XCTAssertEqual(failure.title, OrbisError.storageRefused.failure().title)
    XCTAssertTrue(failure.isRetryable, "a refused save is worth another try")
    XCTAssertFalse(
      failure.message.contains("synthetic-new-key"), "the key must not reach user-facing text")
  }

  /// A sidebar that could not be read must keep its reason and offer retry, because an empty
  /// section reads as "no playlists".
  func testPlaylistsThatFailToLoadSaySoInsteadOfReadingAsEmpty() async throws {
    let model = AppModel(
      client: OrbisClient(
        address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
        token: "token",
        session: StubProtocol.session { _ in (500, #"{"message":"The library is busy."}"#) }
      ), settings: MemoryClientSettings())

    await model.loadPlaylists()

    guard case .failed = model.playlists else {
      return XCTFail("a failed sidebar must not read as loaded and empty")
    }
    StubProtocol.responder = { _ in (200, Self.playlistsBody) }
    await model.loadPlaylists()
    guard case .loaded(let playlists) = model.playlists else {
      return XCTFail("the retry must load the playlists")
    }
    XCTAssertEqual(playlists.map(\.name), ["Long drives"])
  }
}

/// A store that refuses every write, like a device whose keychain will not take the token.
@MainActor
final class RefusingClientSettings: ClientSettingsStore {
  private(set) var storeAttempts = 0

  var deviceToken: String? { nil }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool {
    storeAttempts += 1
    return false
  }
}
