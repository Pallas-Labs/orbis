import Foundation
import OrbisDesign
import os

/// What the client could not read, by type and field. Never a value: the values are the library's
/// own titles and links.
private let logger = Logger(subsystem: "app.orbis", category: "client")

/// A failure the user can act on. Each case carries the sentence the app shows, so the
/// recovery action is decided in one place rather than in every view.
enum OrbisError: Error, Equatable {
  case unreachable
  case notSignedIn
  case duplicate
  /// The view that started the request went away before it finished. Not a failure, and never
  /// shown to anyone, because the screen that replaces it loads on its own.
  case cancelled
  case server(status: Int, message: String)
  case malformed
  /// A web server answered instead of Orbis, such as a proxy's error page.
  case notOrbis
  /// The device refused to hold the key, so nothing was saved and nothing was changed.
  case storageRefused

  var message: String {
    switch self {
    case .unreachable:
      "Cannot reach your library. Check your internet connection and try again."
    case .notSignedIn:
      "This device is not signed in to your library. Sign out in Settings and sign in again."
    case .duplicate:
      "That set is already in your library."
    case .cancelled:
      "The request was interrupted."
    case .server(let status, let message):
      "The service reported \(status). \(message)"
    case .malformed:
      "The service sent a response this app does not understand. Update the app."
    case .notOrbis:
      "Something other than Orbis answered. A web page came back instead."
    case .storageRefused:
      "This device would not save the key, so nothing was changed. Try again."
    }
  }
}

extension OrbisError {
  /// `address` is where the app was looking. Anything other than Orbis answering is the first
  /// thing worth knowing, and the person reading the screen can check it in one look.
  func failure(at address: URL? = nil) -> OrbisFailure {
    var failure: OrbisFailure
    switch self {
    case .unreachable:
      failure = OrbisFailure(
        title: "Cannot reach your library",
        message: message,
        symbol: "wifi.exclamationmark",
        isRetryable: true
      )
    case .notSignedIn:
      failure = OrbisFailure(
        title: "This device is not signed in",
        message: message,
        symbol: "key.slash",
        isRetryable: false
      )
    case .malformed:
      failure = OrbisFailure(
        title: "Orbis sent an answer this app cannot read",
        message: message,
        symbol: "doc.questionmark",
        isRetryable: false
      )
    case .server(let status, _):
      failure = OrbisFailure(
        title: "Your library reported an error",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: status >= 500
      )
    case .notOrbis:
      failure = OrbisFailure(
        title: "A web page answered, not Orbis",
        message: message,
        symbol: "globe",
        isRetryable: false
      )
    case .storageRefused:
      failure = OrbisFailure(
        title: "This device could not save the key",
        message: message,
        symbol: "key.slash",
        isRetryable: true
      )
    case .duplicate, .cancelled:
      failure = OrbisFailure(
        title: "Something went wrong",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: true
      )
    }
    failure.address = address?.absoluteString
    return failure
  }
}

extension OrbisFailure {
  /// What a sign-in or Settings request failed with. The service explains a refusal, such as a
  /// wrong Group Passcode, a taken username, or an expired code, in a sentence meant for the
  /// person, so that sentence is shown as it came.
  static func explaining(_ error: any Error, at address: URL) -> OrbisFailure {
    let known = (error as? OrbisError) ?? .unreachable
    guard case .server(let status, let message) = known, (400..<500).contains(status),
      !message.isEmpty
    else { return known.failure(at: address) }
    return OrbisFailure(
      title: "Orbis could not do that", message: message, symbol: "hand.raised",
      isRetryable: status == 429, address: address.absoluteString)
  }
}

/// The Orbis service this app is built for (ADR 0020). The address is not a secret and is not
/// stored: a fresh install asks only for a sign-in.
enum OrbisService {
  static let address = URL(string: "https://orbis.p11a.xyz/api")!

  /// The link a TV's QR code carries for its Approval Code (ADR 0022). It opens Orbis on an
  /// iPhone, or the web where Orbis is not installed. The code rides in the fragment, which a
  /// browser never sends to a server.
  static func pairLink(code: String) -> URL {
    URL(string: "https://orbis.p11a.xyz/pair#\(code)")!
  }

  /// The address this launch talks to. A Debug journey points it at the lane's service with
  /// `-orbisServiceAddress <address>`, and a Debug Mac build at the service its development
  /// token belongs to; every other build uses the built-in one.
  static func address(for arguments: [String]) -> URL {
    #if DEBUG
      if let flag = arguments.firstIndex(of: "-orbisServiceAddress"),
        arguments.indices.contains(flag + 1),
        let url = URL(string: arguments[flag + 1]), OrbisClient.accepts(url)
      {
        return url
      }
      if let development = ClientSettings.developmentConfiguration,
        let url = URL(string: development.address), OrbisClient.accepts(url)
      {
        return url
      }
    #endif
    return address
  }
}

/// The signed-in Person, as `/me` answers.
struct Me: Codable, Equatable, Sendable {
  let autoDownload: Bool
  let host: Bool
  let id: String
  let social: Bool
  let username: String
}

/// A change to the signed-in Person. Absent fields are left as they are.
struct MeUpdate: Encodable {
  var autoDownload: Bool?
  var social: Bool?
  var username: String?
}

struct GroupPerson: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  let username: String
}

/// A Person the caller could see, with the caller's See and Appear for them (ADR 0009).
struct PersonFilters: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  let username: String
  var see: Bool
  var appear: Bool
}

/// The caller's See and Appear for one Person.
struct SocialFilters: Decodable, Equatable, Sendable {
  let see: Bool
  let appear: Bool
}

/// A change to the caller's filters for one Person. Absent fields are left as they are.
struct SocialFiltersUpdate: Encodable {
  var see: Bool?
  var appear: Bool?
}

/// What a visible Person is playing now, as `/events` reports it (ADR 0019).
struct Presence: Decodable, Equatable, Sendable {
  let personId: String
  let set: SavedSet
  let username: String
}

/// One of a visible Person's Playlists, with its Sets.
struct FriendPlaylist: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  let name: String
  let setCount: Int
  let sets: [SavedSet]
}

/// One time a visible Person played a Set. `finishedAt` is nil while it is still going or was
/// left part-way.
struct Listen: Decodable, Equatable, Sendable {
  let set: SavedSet
  let startedAt: String
  let finishedAt: String?
}

/// A one-time code another device types to sign in as the same Person (ADR 0020).
struct SignInCode: Decodable, Equatable, Sendable {
  let code: String
  let expiresAt: String
}

extension CodeFormat {
  /// The service's alphabet for codes a person types: no 0/O or 1/I/L look-alikes.
  private static let typable = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

  /// A Sign-in Code: two groups of four.
  static let signInCode = CodeFormat(alphabet: typable, groups: [4, 4])
  /// A Group Passcode: three groups of four.
  static let groupPasscode = CodeFormat(alphabet: typable, groups: [4, 4, 4])
}

/// One of the Person's own keys, as Settings lists it.
struct Device: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  let label: String
  let addedAt: String
  let lastUsedAt: String?
  /// The key this device signs its requests with.
  let current: Bool
}

/// A signed-out device waiting for a signed-in Person to approve it (ADR 0022).
struct ApprovalRequest: Decodable, Equatable, Sendable {
  let code: String
  let label: String
  /// `tvOS`, `iOS`, `macOS`, or `web`.
  let platform: String
  let requestedAt: String
}

private struct Devices: Decodable {
  let devices: [Device]
}

private struct SignedIn: Decodable {
  let key: String
}

/// An Approval Request this device started (ADR 0022): the 6-digit code it shows, and the secret
/// only this device holds, which collects the key once a signed-in Person approves.
struct StartedApprovalRequest: Decodable, Sendable {
  let code: String
  let secret: String
}

/// How a wait on an Approval Request ended.
enum ApprovalAnswer: Equatable, Sendable {
  /// No one approved it while the wait was open. Wait again.
  case pending
  /// A Person approved it. The key is this device's, and comes once.
  case approved(key: String, username: String)
  /// The request expired, or its key was already collected. Start a new one.
  case expired
}

private struct ApprovalWait: Decodable {
  struct Person: Decodable { let username: String }

  let status: String
  let key: String?
  let person: Person?
}

private struct GroupPasscode: Decodable {
  let passcode: String?
}

private struct GroupPeople: Decodable {
  let people: [GroupPerson]
}

private struct PeopleFiltersResponse: Decodable {
  let people: [PersonFilters]
}

private struct FriendPlaylistsResponse: Decodable {
  let playlists: [FriendPlaylist]
}

private struct ListensResponse: Decodable {
  let listens: [Listen]
}

/// A frame of `/events`. Only Presence and playlist imports are read here; the rest are skipped.
private struct EventFrame: Decodable {
  let kind: String
  let presence: [Presence]?
  let playlistImport: PlaylistImportJob?
}

/// Talks to the Orbis service. Every request carries the device token, and the same
/// failure mapping is used everywhere, so a view only has to render `message`.
struct OrbisClient: Sendable {
  let address: URL
  let token: String
  let session: URLSession

  init(address: URL, token: String, session: URLSession = .orbisAPI) {
    self.address = address
    self.token = token
    self.session = session
  }

  /// The event stream's session. A session handed in, as a test does, carries the stream too.
  private var eventSession: URLSession {
    session === URLSession.orbisAPI ? .orbisEvents : session
  }

  /// An address is accepted only when it would carry the key safely: TLS, or the
  /// loopback service the server itself trusts, which is what the temporary lane services
  /// run on.
  static func accepts(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
      return false
    }
    let loopback = ["127.0.0.1", "localhost", "::1", "[::1]"]
    return scheme == "https" || (scheme == "http" && loopback.contains(host))
  }

  /// Shared by every call, so one coder's configuration is the whole app's.
  private static let decoder = JSONDecoder()
  private static let encoder = JSONEncoder()

  func me() async throws -> Me {
    let response = try await send(path: "me", method: "GET", body: nil)
    return try Self.decode(Me.self, from: response)
  }

  func updateMe(_ update: MeUpdate) async throws -> Me {
    let body = try Self.encoder.encode(update)
    let response = try await send(path: "me", method: "PATCH", body: body)
    return try Self.decode(Me.self, from: response)
  }

  // MARK: - Social (ADR 0009)

  /// The People with Social on whom the caller could see, with the caller's See and Appear.
  func socialFilters() async throws -> [PersonFilters] {
    let response = try await send(path: "people/filters", method: "GET", body: nil)
    return try Self.decode(PeopleFiltersResponse.self, from: response).people
  }

  func setFilters(for personId: String, _ update: SocialFiltersUpdate) async throws -> SocialFilters {
    let body = try Self.encoder.encode(update)
    let response = try await send(path: "people/\(personId)/filters", method: "PUT", body: body)
    return try Self.decode(SocialFilters.self, from: response)
  }

  /// A visible Person's Library.
  func friendSets(_ personId: String) async throws -> [SavedSet] {
    let response = try await send(path: "people/\(personId)/sets", method: "GET", body: nil)
    return try Self.decode(LibraryResponse.self, from: response).sets
  }

  func friendPlaylists(_ personId: String) async throws -> [FriendPlaylist] {
    let response = try await send(path: "people/\(personId)/playlists", method: "GET", body: nil)
    return try Self.decode(FriendPlaylistsResponse.self, from: response).playlists
  }

  /// What a visible Person played, newest first.
  func friendListens(_ personId: String) async throws -> [Listen] {
    let response = try await send(path: "people/\(personId)/listens", method: "GET", body: nil)
    return try Self.decode(ListensResponse.self, from: response).listens
  }

  /// Reads `/events` until the stream closes, handing every Presence frame to `receive`. The
  /// service sends one as the stream opens and another whenever someone starts or stops.
  func watchPresence(_ receive: @escaping @MainActor @Sendable ([Presence]) -> Void) async throws {
    try await readEvents(changes: false) { frame in
      guard frame.kind == "presence", let presence = frame.presence else { return }
      await receive(presence)
    }
  }

  /// Reads `/events?changes=1` until the stream closes, handing every playlist import frame to
  /// `receive`. `opened` runs once the stream is open, before its first frame, so the caller can
  /// catch up on what it missed while it was not listening.
  func watchPlaylistImports(
    opened: @escaping @MainActor @Sendable () async -> Void,
    _ receive: @escaping @MainActor @Sendable (PlaylistImportJob) async -> Void
  ) async throws {
    try await readEvents(changes: true, opened: opened) { frame in
      guard frame.kind == "playlistImport", let job = frame.playlistImport else { return }
      await receive(job)
    }
  }

  private func readEvents(
    changes: Bool,
    opened: (@MainActor @Sendable () async -> Void)? = nil,
    _ handle: (EventFrame) async -> Void
  ) async throws {
    let root = address.absoluteString
    let path = changes ? "events?changes=1" : "events"
    guard let url = URL(string: root.hasSuffix("/") ? root + path : root + "/" + path) else {
      throw OrbisError.malformed
    }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    // The service sends a heartbeat every 30 seconds, so a minute of silence is a dead stream.
    request.timeoutInterval = 60
    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    do {
      (bytes, response) = try await eventSession.bytes(for: request)
    } catch let error as URLError where error.code == .cancelled {
      throw OrbisError.cancelled
    } catch {
      throw OrbisError.unreachable
    }
    guard let http = response as? HTTPURLResponse else { throw OrbisError.malformed }
    if http.statusCode == 401 { throw OrbisError.notSignedIn }
    guard (200..<300).contains(http.statusCode) else {
      throw OrbisError.server(status: http.statusCode, message: "")
    }
    await opened?()
    for try await line in bytes.lines {
      guard line.hasPrefix("data:") else { continue }
      let json = Data(line.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
      let frame: EventFrame
      do {
        frame = try Self.decoder.decode(EventFrame.self, from: json)
      } catch {
        // Heartbeats and queue frames decode, so only a frame this build cannot read lands here.
        Self.logUnreadable(EventFrame.self, error)
        continue
      }
      await handle(frame)
    }
  }

  // MARK: - Signing in (ADR 0020)

  /// Joins the Group as a new Person with the Group Passcode. Needs no key: a signed-out client
  /// calls it, and the answer is this device's key.
  func join(username: String, passcode: String, label: String) async throws -> String {
    let body = try Self.encoder.encode([
      "label": label, "passcode": passcode, "username": username,
    ])
    let response = try await send(path: "sign-in/join", method: "POST", body: body)
    return try Self.decode(SignedIn.self, from: response).key
  }

  /// Signs in as the Person who showed `code` on another device. Needs no key.
  func redeem(code: String, label: String) async throws -> String {
    let body = try Self.encoder.encode(["code": code, "label": label])
    let response = try await send(path: "sign-in/code", method: "POST", body: body)
    return try Self.decode(SignedIn.self, from: response).key
  }

  /// Starts an Approval Request for this signed-out device. Needs no key.
  func startApprovalRequest(label: String, platform: String) async throws -> StartedApprovalRequest {
    let body = try Self.encoder.encode(["label": label, "platform": platform])
    let response = try await send(path: "sign-in/requests", method: "POST", body: body)
    return try Self.decode(StartedApprovalRequest.self, from: response)
  }

  /// Waits for a Person to approve the request `secret` started. The service holds the call open
  /// for up to 25 seconds and answers at once on approval, so the request may run longer than
  /// any other.
  func waitForApproval(secret: String) async throws -> ApprovalAnswer {
    let body = try Self.encoder.encode(["secret": secret])
    let response: Data
    do {
      response = try await send(path: "sign-in/requests/wait", method: "POST", body: body, timeout: 40)
    } catch OrbisError.server(status: 404, _) {
      return .expired
    }
    let answer = try Self.decode(ApprovalWait.self, from: response)
    switch answer.status {
    case "pending":
      return .pending
    case "approved":
      guard let key = answer.key, let person = answer.person else { throw OrbisError.malformed }
      return .approved(key: key, username: person.username)
    default:
      throw OrbisError.malformed
    }
  }

  /// A code another device types to sign in as this Person.
  func signInCode() async throws -> SignInCode {
    let response = try await send(path: "me/sign-in-codes", method: "POST", body: nil)
    return try Self.decode(SignInCode.self, from: response)
  }

  /// The Person's keys, one per device.
  func devices() async throws -> [Device] {
    let response = try await send(path: "me/devices", method: "GET", body: nil)
    return try Self.decode(Devices.self, from: response).devices
  }

  /// Signs another of the Person's devices out. It is refused on its next request.
  func revokeDevice(_ id: String) async throws {
    _ = try await send(path: "me/devices/\(id)", method: "DELETE", body: nil)
  }

  /// The device waiting with `code`, so the Person can match it to the one in front of them.
  func findSignInRequest(code: String) async throws -> ApprovalRequest {
    let body = try Self.encoder.encode(["code": code])
    let response = try await send(path: "me/sign-in-requests/find", method: "POST", body: body)
    return try Self.decode(ApprovalRequest.self, from: response)
  }

  /// Signs the device waiting with `code` in as this Person.
  func approveSignInRequest(code: String) async throws -> ApprovalRequest {
    let body = try Self.encoder.encode(["code": code])
    let response = try await send(path: "me/sign-in-requests/approve", method: "POST", body: body)
    return try Self.decode(ApprovalRequest.self, from: response)
  }

  // MARK: - The Host's controls

  /// A code that signs a device in as `personId`, which is how a friend who lost every device
  /// gets back in.
  func signInCode(for personId: String) async throws -> SignInCode {
    let response = try await send(
      path: "admin/people/\(personId)/sign-in-codes", method: "POST", body: nil)
    return try Self.decode(SignInCode.self, from: response)
  }

  /// The Group Passcode, or nil while joining is closed.
  func passcode() async throws -> String? {
    let response = try await send(path: "admin/passcode", method: "GET", body: nil)
    return try Self.decode(GroupPasscode.self, from: response).passcode
  }

  /// Opens joining with a new random Group Passcode, which the service makes. The one shared
  /// before stops working.
  func newPasscode() async throws -> String? {
    let response = try await send(path: "admin/passcode", method: "POST", body: nil)
    return try Self.decode(GroupPasscode.self, from: response).passcode
  }

  /// Closes joining.
  func closeJoining() async throws -> String? {
    let response = try await send(path: "admin/passcode", method: "DELETE", body: nil)
    return try Self.decode(GroupPasscode.self, from: response).passcode
  }

  func people() async throws -> [GroupPerson] {
    let response = try await send(path: "admin/people", method: "GET", body: nil)
    return try Self.decode(GroupPeople.self, from: response).people
  }

  func removePerson(_ id: String) async throws {
    _ = try await send(path: "admin/people/\(id)", method: "DELETE", body: nil)
  }

  func library(query: String = "", playlistId: String? = nil) async throws -> [SavedSet] {
    var items: [URLQueryItem] = []
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      items.append(URLQueryItem(name: "q", value: trimmed))
    }
    if let playlistId {
      items.append(URLQueryItem(name: "playlistId", value: playlistId))
    }
    var path = "sets"
    if !items.isEmpty {
      var components = URLComponents()
      components.queryItems = items
      path += "?\(components.percentEncodedQuery ?? "")"
    }
    let response = try await send(path: path, method: "GET", body: nil)
    return try Self.decode(LibraryResponse.self, from: response).sets
  }

  /// DJ mixes in the US Apple Music catalog for these words, then other albums.
  func searchAppleMusic(_ words: String) async throws -> [AppleMusicAlbum] {
    var components = URLComponents()
    components.queryItems = [URLQueryItem(name: "q", value: words)]
    // URLComponents leaves "+" as it is, and the service reads a query "+" as a space.
    let query = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") ?? ""
    let path = "apple-music/search?\(query)"
    let response = try await send(path: path, method: "GET", body: nil)
    return try Self.decode(AppleMusicSearchResponse.self, from: response).albums
  }

  /// A Set's shared facts, which the service answers for any Set, saved here or not (ADR 0023).
  func sharedSet(_ id: String) async throws -> SharedSet {
    let response = try await send(path: "share/sets/\(id)", method: "GET", body: nil)
    return try Self.decode(SharedSet.self, from: response)
  }

  func tracklist(_ id: String) async throws -> Tracklist {
    let response = try await send(path: "sets/\(id)/tracklist", method: "GET", body: nil)
    return try Self.decode(Tracklist.self, from: response)
  }

  func retryTracklist(_ id: String) async throws -> Tracklist {
    let response = try await send(path: "sets/\(id)/tracklist/retry", method: "POST", body: nil)
    return try Self.decode(Tracklist.self, from: response)
  }

  func playlists() async throws -> [Playlist] {
    let response = try await send(path: "playlists", method: "GET", body: nil)
    return try Self.decode(PlaylistsResponse.self, from: response).playlists
  }

  func createPlaylist(name: String) async throws -> Playlist {
    let body = try Self.encoder.encode(CreatePlaylistRequest(name: name))
    let response = try await send(path: "playlists", method: "POST", body: body)
    return try Self.decode(Playlist.self, from: response)
  }

  func renamePlaylist(_ id: String, name: String) async throws -> Playlist {
    let body = try Self.encoder.encode(PlaylistNameRequest(name: name))
    let response = try await send(path: "playlists/\(id)", method: "PATCH", body: body)
    return try Self.decode(Playlist.self, from: response)
  }

  func deletePlaylist(_ id: String) async throws -> Playlist {
    let response = try await send(path: "playlists/\(id)", method: "DELETE", body: nil)
    return try Self.decode(Playlist.self, from: response)
  }

  /// Starts importing a playlist. The service answers once the import is under way, and asking
  /// again while it runs answers the same import.
  func importPlaylist(url: String) async throws -> PlaylistImportJob {
    let body = try Self.encoder.encode(ImportPlaylistRequest(url: url))
    let response = try await send(path: "playlists/import", method: "POST", body: body)
    return try Self.decode(PlaylistImportJob.self, from: response)
  }

  func playlistImport(_ id: String) async throws -> PlaylistImportJob {
    let response = try await send(path: "playlists/imports/\(id)", method: "GET", body: nil)
    return try Self.decode(PlaylistImportJob.self, from: response)
  }

  /// States the ordered Sets a Playlist holds. Removing a Set here leaves it in the Library.
  func setPlaylistMembers(_ id: String, setIds: [String]) async throws -> [SavedSet] {
    let body = try Self.encoder.encode(PlaylistMembersRequest(setIds: setIds))
    let response = try await send(path: "playlists/\(id)/sets", method: "PUT", body: body)
    return try Self.decode(PlaylistMembersResponse.self, from: response).sets
  }

  func save(url: String, tags: [String] = []) async throws -> SavedSet {
    let body = try Self.encoder.encode(SaveSetRequest(tags: tags, url: url))
    let response = try await send(path: "sets", method: "POST", body: body)
    return try decodedSet(response)
  }

  func updateTitle(_ id: String, title: String) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetTitleRequest(title: title))
    let response = try await send(path: "sets/\(id)/title", method: "PATCH", body: body)
    return try decodedSet(response)
  }

  func updateTags(_ id: String, tags: [String]) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetTagsRequest(tags: tags))
    let response = try await send(path: "sets/\(id)/tags", method: "PATCH", body: body)
    return try decodedSet(response)
  }

  /// Asks the service to name a Set it could not name when the link was filed.
  func retryMetadata(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/metadata", method: "POST", body: nil)
    return try decodedSet(response)
  }

  /// States the Playlists a Set belongs to. Sending the whole membership is what lets the
  /// service work out which Playlist the Set left.
  func updatePlaylists(_ id: String, playlistIds: [String]) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetPlaylistsRequest(playlistIds: playlistIds))
    let response = try await send(path: "sets/\(id)/playlists", method: "PUT", body: body)
    return try decodedSet(response)
  }

  func deleteSet(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)", method: "DELETE", body: nil)
    return try decodedSet(response)
  }

  /// Asks the service to fetch this Set's audio through Cobalt and keep it. The answer
  /// is the Set with its new download state; progress arrives through audioState.
  func requestAudioDownload(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/audio/download", method: "POST", body: nil)
    return try decodedSet(response)
  }

  /// How far the service has got with this Set's audio, if it has started.
  func audioState(_ id: String) async throws -> AudioState {
    let response = try await send(path: "sets/\(id)/audio/state", method: "GET", body: nil)
    return try Self.decode(AudioState.self, from: response)
  }

  /// Stops a running download and drops its partial file. A finished download stays
  /// finished: the service refuses that with its own sentence.
  func cancelAudioDownload(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/audio/download", method: "DELETE", body: nil)
    return try decodedSet(response)
  }

  // MARK: - The Listening Queue

  /// The one Listening Queue, in play order.
  func listeningQueue() async throws -> ListeningQueue {
    let response = try await send(path: "queue", method: "GET", body: nil)
    return try decodedQueue(response)
  }

  /// Makes a Set the active one, which is what playing it does. The Set keeps its place when it
  /// is already queued, and takes the listening position when it is not.
  func playSet(_ id: String) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(SetIdRequest(setId: id))
    let response = try await send(path: "queue/active", method: "PUT", body: body)
    return try decodedQueue(response)
  }

  func queueSet(_ id: String, placement: QueuePlacement) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(
      QueueEntryRequest(placement: placement.rawValue, setId: id))
    let response = try await send(path: "queue/entries", method: "POST", body: body)
    return try decodedQueue(response)
  }

  /// Replaces the whole queue with a Playlist's playable members, in Playlist order or shuffled.
  func playPlaylist(_ playlistId: String, shuffled: Bool = false) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(
      PlaylistQueueRequest(playlistId: playlistId, order: shuffled ? .shuffled : nil))
    let response = try await send(path: "queue/playlist", method: "PUT", body: body)
    return try decodedQueue(response)
  }

  /// Reports that the active Set reached its natural end. The service removes it, resets its
  /// Playback Position, and starts the next entry; a repeat of the same signal does nothing.
  func reportCompletion(_ id: String) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(SetIdRequest(setId: id))
    let response = try await send(path: "queue/completion", method: "POST", body: body)
    return try decodedQueue(response)
  }

  /// Reports where playback has reached. The answer is the Set, so the stored position comes
  /// back rather than being assumed.
  func reportPosition(_ id: String, seconds: Int) async throws -> SavedSet {
    let body = try Self.encoder.encode(PlaybackPositionRequest(seconds: seconds))
    let response = try await send(path: "sets/\(id)/position", method: "PUT", body: body)
    return try decodedSet(response)
  }

  private func decodedSet(_ response: Data) throws -> SavedSet {
    try Self.decode(SavedSet.self, from: response)
  }

  private func decodedQueue(_ response: Data) throws -> ListeningQueue {
    try Self.decode(QueueResponse.self, from: response).queue
  }

  /// Decodes a body, reporting a shape this build cannot read as the one error the screens explain.
  private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do {
      return try decoder.decode(type, from: data)
    } catch {
      logUnreadable(T.self, error)
      throw OrbisError.malformed
    }
  }

  /// Logs the type and the failing key path, in every build, and never the values: a version skew
  /// is worth knowing by field, and the fields hold the library's own titles and links.
  private static func logUnreadable(_ type: Any.Type, _ error: any Error) {
    guard let decoding = error as? DecodingError else { return }
    logger.error(
      "Could not read \(String(describing: type), privacy: .public) at \(path(of: decoding), privacy: .public)"
    )
  }

  /// Where a decode failed, as the fields leading to it. No value is named.
  private static func path(of error: DecodingError) -> String {
    let codingPath: [any CodingKey]
    switch error {
    case .keyNotFound(let key, let context):
      codingPath = context.codingPath + [key]
    case .typeMismatch(_, let context), .valueNotFound(_, let context),
      .dataCorrupted(let context):
      codingPath = context.codingPath
    @unknown default:
      codingPath = []
    }
    guard !codingPath.isEmpty else { return "the root" }
    return codingPath.map(\.stringValue).joined(separator: ".")
  }

  /// What a debug line may say about a request: method, host, and path, because a query string
  /// carries what the person typed.
  private static func redacted(method: String, url: URL) -> String {
    "\(method) \(url.host() ?? "") \(url.path())"
  }

  private func send(
    path: String, method: String, body: Data?, timeout: TimeInterval = 15
  ) async throws -> Data {
    // Resolving against the address would drop its last path segment, so an address such as
    // the Funnel address with `/api` would lose `/api`. Join the strings instead.
    let root = address.absoluteString
    // Only an id the service never sends could make this fail.
    guard let url = URL(string: root.hasSuffix("/") ? root + path : root + "/" + path) else {
      throw OrbisError.malformed
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.timeoutInterval = timeout
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError where error.code == .cancelled {
      throw OrbisError.cancelled
    } catch {
      #if DEBUG
        // A transport failure is otherwise invisible, which makes a wrong address, a
        // blocked connection, and a rejected certificate look identical. Written to
        // standard error because stdout is buffered and a killed run loses it. The
        // error is named by its code: its own description carries the URL back in.
        let code = (error as? URLError)?.code.rawValue ?? -1
        let line = "Orbis transport failure \(Self.redacted(method: method, url: url)): URLError \(code)\n"
        FileHandle.standardError.write(Data(line.utf8))
      #endif
      throw OrbisError.unreachable
    }
    guard let http = response as? HTTPURLResponse else {
      throw OrbisError.malformed
    }
    let head = data.prefix(160)
    // Markup at any status means a web server answered, not Orbis. Reported before the status
    // is judged, because a 403 from a web page is not a refusal by the library.
    if head.first == UInt8(ascii: "<") {
      #if DEBUG
        let line = "Orbis read a web page from \(Self.redacted(method: method, url: url))\n"
        FileHandle.standardError.write(Data(line.utf8))
      #endif
      throw OrbisError.notOrbis
    }
    #if DEBUG
      // A body that is not JSON and not a web page is usually a version skew: something
      // answered in a shape this build does not know. Its size is printed rather than its
      // first bytes, which are the library's own.
      if head.first != UInt8(ascii: "{"), head.first != UInt8(ascii: "[") {
        let line =
          "Orbis read a non-JSON body from \(Self.redacted(method: method, url: url)): \(data.count) bytes\n"
        FileHandle.standardError.write(Data(line.utf8))
      }
    #endif
    switch http.statusCode {
    case 200..<300:
      return data
    case 401:
      throw OrbisError.notSignedIn
    case 409:
      let message = (try? Self.decoder.decode(ServerMessage.self, from: data))?.message
      if message == "This set is already in your library." {
        throw OrbisError.duplicate
      }
      throw OrbisError.server(status: 409, message: message ?? "")
    default:
      let message = (try? Self.decoder.decode(ServerMessage.self, from: data))?.message
      throw OrbisError.server(status: http.statusCode, message: message ?? "")
    }
  }
}

private struct ServerMessage: Decodable {
  let message: String
}

extension URLSession {
  /// Requests to the service. One made while the device has no connection waits for one rather
  /// than failing at once, and gives up after a minute in all.
  static let orbisAPI: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.waitsForConnectivity = true
    configuration.timeoutIntervalForResource = 60
    return URLSession(configuration: configuration)
  }()

  /// The event stream, which stays open while People is on screen, so it has no limit on its
  /// whole length beyond the default seven days. A stream whose heartbeat stops still times out
  /// on its request's own interval.
  static let orbisEvents = URLSession(configuration: .default)
}
