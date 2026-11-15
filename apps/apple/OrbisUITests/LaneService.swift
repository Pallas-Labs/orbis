import XCTest

/// The lane's service, reached over HTTP from the test runner. A journey seeds the state it needs
/// and reads back what the app stored, so it proves the change reached the service rather than
/// only the screen.
struct LaneService {
  let address: String
  let token: String

  init(tokenOverride: String? = nil) throws {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = tokenOverride ?? environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    self.address = address
    self.token = token
  }

  /// The lane's second Person, `lane-settings`, signed in on the runner.
  static func settingsPerson() throws -> LaneService {
    guard let token = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SETTINGS_TOKEN"],
      !token.isEmpty
    else { throw XCTSkip("The lane must supply the settings Person") }
    return try LaneService(tokenOverride: token)
  }

  struct Preferences: Decodable { let autoDownload: Bool }

  func autoDownload() throws -> Bool {
    let preferences: Preferences = try send("GET", "me", nil)
    return preferences.autoDownload
  }

  func autoDownload(becomes expected: Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(10)
    repeat {
      let preferences: Preferences = try send("GET", "me", nil)
      if preferences.autoDownload == expected { return expected }
      usleep(100_000)
    } while Date() < deadline
    let preferences: Preferences = try send("GET", "me", nil)
    return preferences.autoDownload
  }

  struct Set: Decodable {
    let id: String
    let title: String
    let url: String
    let source: String
    let metadataState: String
    let tags: [String]
    let playbackPositionSeconds: Int
    let finishCount: Int
    let creator: String?
    let tracklistState: String?
  }

  struct AudioState: Codable {
    let state: String
    let bytesReceived: Int
    let bytesTotal: Int?
    let format: String?

    var hasProgress: Bool {
      state == "downloading" && bytesReceived > 0 && bytesReceived < (bytesTotal ?? 0)
    }
  }

  struct DownloadObservation: Encodable {
    let phase: String
    let observedAt: Date
    let setId: String
    let audio: AudioState
  }

  struct Playlist: Decodable {
    let id: String
    let name: String
  }

  /// The Listening Queue: the Set ids in play order, and the one playing now.
  struct Queue: Decodable {
    let activeSetId: String?
    let entries: [Set]
    var ids: [String] { entries.map(\.id) }
  }

  private struct QueueResponse: Decodable { let queue: Queue }
  private struct Sets: Decodable { let sets: [Set] }
  private struct Playlists: Decodable { let playlists: [Playlist] }

  func saveSet(title: String, url: String, tags: [String] = []) throws -> Set {
    try send("POST", "sets", ["title": title, "url": url, "tags": tags])
  }

  func saveReadySet(title: String, url: String, tags: [String] = []) throws -> Set {
    let saved = try saveSet(title: title, url: url, tags: tags)
    try seed("ready-audio/\(saved.id)")
    return saved
  }

  func saveSlowDownloadSet(title: String, url: String) throws -> Set {
    let saved = try saveSet(title: title, url: url)
    try seed("slow-download/\(saved.id)")
    return saved
  }

  func markAudioUnavailable(_ id: String) throws {
    try seed("unavailable-audio/\(id)")
  }

  func restoreReadyAudio(_ id: String) throws {
    try seed("ready-audio/\(id)")
  }

  /// How the lane's seed server spoils a Set's audio, for a journey that launches the app
  /// through `proxyAddress()`. `heldBody` answers the two-byte probe, then sends the headers
  /// and never the body, as a path that holds the bytes does. `pausedBody` sends the first
  /// third of the file and its tail at 32 KB/s, then the rest at 16 bytes a second, so the item
  /// starts, plays ten seconds and stalls.
  enum AudioFault: String {
    case heldBody = "held-body"
    case pausedBody = "paused-body"
  }

  /// Spoils the audio of the first item the app loads for `id`, or of every item when
  /// `everySession` is set, so a reload meets the same fault.
  func fault(_ id: String, with fault: AudioFault, everySession: Bool = false) throws {
    try seed("\(fault.rawValue)/\(id)\(everySession ? "?sessions=all" : "")")
  }

  /// The service address through the seed server, which answers faulted audio itself, keeps the
  /// app's playback diagnostics, and passes everything else to the lane service.
  static func proxyAddress() throws -> String {
    try "\(seedAddress())/via"
  }

  /// The playback diagnostics the app sent through the proxy for `id`, oldest first.
  func proxiedDiagnostics(for id: String) throws -> [[String: Any]] {
    let answer = try seedJSON("via-diagnostics?setId=\(id)")
    return answer["entries"] as? [[String: Any]] ?? []
  }

  /// Each audio request the faulted Set received: its player session, range, and bytes sent.
  func faultState(of id: String) throws -> [String: Any] {
    try seedJSON("audio-fault-state/\(id)")
  }

  private static func seedAddress() throws -> String {
    guard let seedAddress = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SEED_ADDRESS"],
      !seedAddress.isEmpty
    else { throw XCTSkip("the lane must supply ORBIS_UI_TEST_SEED_ADDRESS") }
    return seedAddress
  }

  private func seedJSON(_ path: String) throws -> [String: Any] {
    guard let endpoint = URL(string: "\(try Self.seedAddress())/\(path)") else {
      throw URLError(.badURL)
    }
    var result: Data?
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: endpoint) { data, response, _ in
      if (response as? HTTPURLResponse)?.statusCode == 200 { result = data }
      done.signal()
    }.resume()
    guard done.wait(timeout: .now() + 20) == .success, let result,
      let object = try JSONSerialization.jsonObject(with: result) as? [String: Any]
    else { throw URLError(.badServerResponse) }
    return object
  }

  func finishSlowDownload(_ id: String) throws {
    try seed("finish-download/\(id)")
  }

  func seedTracklist(_ id: String) throws {
    try seed("tracklist/\(id)")
  }

  func seedLateTracklist(_ id: String) throws {
    try seed("late-tracklist/\(id)")
  }

  /// Stores a measured tempo and loudness for the Set, as the audio node does after a download:
  /// a 2 hr Set at a median 140 BPM in five sections.
  func seedAnalysis(_ id: String) throws {
    try seed("analysis/\(id)")
  }

  /// Settles the Set's Tracklist as none found, as Versos leaves a Set it has no source for.
  func seedNoTracklist(_ id: String) throws {
    try seed("no-tracklist/\(id)")
  }

  /// Leaves the Set's Tracklist pending with its Cues, as it is while Versos scans.
  func holdTracklistRun(_ id: String) throws {
    try seed("running-tracklist/\(id)")
  }

  /// Saves an Apple Music album link. The lane's service reads the album from the recorded answer
  /// in `apps/server/src/fixtures/apple-music`, so the Set has its length and Tracklist, and no
  /// Retained Audio.
  func saveAppleMusicSet(title: String) throws -> Set {
    try saveSet(title: title, url: "https://music.apple.com/us/album/dj-kicks-dj-mix/1046502556")
  }

  /// Removes a Set from this Person's Library, so a journey's own Set does not change the Library
  /// the journeys after it see. Answers the HTTP status.
  @discardableResult
  func removeSet(_ id: String) throws -> Int {
    try status("DELETE", "sets/\(id)", nil)
  }

  func audioState(_ id: String) throws -> AudioState {
    try send("GET", "sets/\(id)/audio/state", nil)
  }

  private func seed(_ path: String) throws {
    guard let seedAddress = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SEED_ADDRESS"],
      let endpoint = URL(string: "\(seedAddress)/\(path)")
    else {
      throw URLError(.badURL)
    }
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    var status = 0
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, _ in
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
      done.signal()
    }.resume()
    guard done.wait(timeout: .now() + 20) == .success, status == 204 else {
      throw URLError(.badServerResponse)
    }
  }

  func createPlaylist(named name: String) throws -> Playlist {
    try send("POST", "playlists", ["name": name])
  }

  func playlists() throws -> [Playlist] {
    let response: Playlists = try send("GET", "playlists", nil)
    return response.playlists
  }

  func deletePlaylist(_ id: String) throws {
    let _: Playlist = try send("DELETE", "playlists/\(id)", nil)
  }

  @discardableResult
  func setMembers(of playlistId: String, to setIds: [String]) throws -> [Set] {
    let response: Sets = try send("PUT", "playlists/\(playlistId)/sets", ["setIds": setIds])
    return response.sets
  }

  func members(of playlistId: String) throws -> [Set] {
    let response: Sets = try send("GET", "sets?playlistId=\(playlistId)", nil)
    return response.sets
  }

  func queue() throws -> Queue {
    let response: QueueResponse = try send("GET", "queue", nil)
    return response.queue
  }

  /// Makes a Set the active one, as tapping Play does.
  @discardableResult
  func play(_ id: String) throws -> Queue {
    let response: QueueResponse = try send("PUT", "queue/active", ["setId": id])
    return response.queue
  }

  @discardableResult
  func addToQueue(_ id: String) throws -> Queue {
    let response: QueueResponse = try send("POST", "queue/entries", ["placement": "end", "setId": id])
    return response.queue
  }

  func library() throws -> [Set] {
    let response: Sets = try send("GET", "sets", nil)
    return response.sets
  }

  func set(id: String) throws -> Set? {
    try library().first { $0.id == id }
  }

  /// Renames a Set as a person does, which keeps the title over the provider's.
  func rename(_ id: String, to title: String) throws {
    let code = try status("PATCH", "sets/\(id)/title", ["title": title])
    guard (200..<300).contains(code) else { throw URLError(.badServerResponse) }
  }

  /// Waits until the service has read the Set's creator from the provider. Answers the Set as
  /// it then reads.
  func named(_ id: String) throws -> Set? {
    let deadline = Date().addingTimeInterval(20)
    repeat {
      if let set = try set(id: id), set.creator != nil {
        return set
      }
      usleep(200_000)
    } while Date() < deadline
    return try set(id: id)
  }

  func position(of id: String, becomesAtLeast minimum: Int) throws -> Int {
    try position(of: id) { $0 >= minimum }
  }

  /// The stored Playback Position once it satisfies `expected`, or the last one read after ten
  /// seconds.
  func position(of id: String, until expected: (Int) -> Bool) throws -> Int {
    let deadline = Date().addingTimeInterval(10)
    repeat {
      let stored = try set(id: id)?.playbackPositionSeconds ?? 0
      if expected(stored) { return stored }
      usleep(250_000)
    } while Date() < deadline
    return try set(id: id)?.playbackPositionSeconds ?? 0
  }

  /// Stores a Playback Position, as another device that stopped part-way would.
  func setPosition(of id: String, to seconds: Int) throws {
    let code = try status("PUT", "sets/\(id)/position", ["seconds": seconds])
    guard (200..<300).contains(code) else { throw URLError(.badServerResponse) }
  }

  /// Plays Sets side by side until each reaches its `seconds`, saving every Playback Position
  /// about each five seconds as a playing device would. The service counts a step as Listening
  /// Time only when it matches the time since the last save, so each position moves by the time
  /// that passed, not by a fixed step: a busy host that saves late still saves the truth.
  /// Returns each save as `id position +step after-seconds`, for a journey to attach.
  @discardableResult
  func listen(_ plays: [(id: String, seconds: Int)]) throws -> [String] {
    var saves: [String] = []
    var last: [String: (seconds: Int, at: Date)] = [:]
    for play in plays {
      try setPosition(of: play.id, to: 0)
      last[play.id] = (0, Date())
    }
    let start = Date()
    var tick = 1
    while plays.contains(where: { (last[$0.id]?.seconds ?? 0) < $0.seconds }) {
      let due = start.addingTimeInterval(TimeInterval(tick * 5))
      tick += 1
      if due > Date() { Thread.sleep(until: due) }
      for play in plays {
        guard let previous = last[play.id], previous.seconds < play.seconds else { continue }
        let now = Date()
        let elapsed = now.timeIntervalSince(previous.at)
        let next = previous.seconds + Int(elapsed.rounded())
        try setPosition(of: play.id, to: next)
        last[play.id] = (next, now)
        saves.append(
          "\(play.id.prefix(8)) \(next) +\(next - previous.seconds) after \(String(format: "%.1f", elapsed))")
      }
    }
    return saves
  }

  struct Collection: Decodable {
    let id: String
    let name: String
  }

  private struct Collections: Decodable { let collections: [Collection] }

  func collections() throws -> [Collection] {
    let response: Collections = try send("GET", "collections", nil)
    return response.collections
  }

  /// The ids in a saved Collection, in the service's order.
  func sets(in collectionId: String) throws -> [String] {
    let response: Sets = try send("GET", "collections/\(collectionId)/sets", nil)
    return response.sets.map(\.id)
  }

  func deleteCollection(_ id: String) throws {
    _ = try status("DELETE", "collections/\(id)", nil)
  }

  /// The ids on the Heavy Rotation shelf, in the service's order.
  func heavyRotation() throws -> [String] {
    let response: Sets = try send("GET", "heavy-rotation", nil)
    return response.sets.map(\.id)
  }

  struct Device: Decodable {
    let id: String
    let label: String
    let lastUsedAt: String?
  }

  private struct Devices: Decodable { let devices: [Device] }

  struct SignInCode: Decodable { let code: String }

  struct Person: Decodable {
    let id: String
    let username: String
  }

  private struct People: Decodable { let people: [Person] }
  private struct Passcode: Decodable { let passcode: String? }

  /// A Sign-in Code for this lane's Person, as Settings on another device would show it.
  func signInCode() throws -> String {
    let code: SignInCode = try send("POST", "me/sign-in-codes", nil)
    return code.code
  }

  struct ApprovalRequest: Decodable {
    let code: String
    let label: String
    let platform: String
  }

  /// Approves the Approval Request showing `code`, as this lane's Person, the way Add a Device
  /// on a signed-in phone does (ADR 0022).
  func approveSignInRequest(_ code: String) throws -> ApprovalRequest {
    try send("POST", "me/sign-in-requests/approve", ["code": code])
  }

  /// The Group Passcode. Host only.
  func passcode() throws -> String? {
    let answer: Passcode = try send("GET", "admin/passcode", nil)
    return answer.passcode
  }

  /// Opens joining with a new passcode the service makes, and returns it. Host only.
  func newPasscode() throws -> String {
    let answer: Passcode = try send("POST", "admin/passcode", nil)
    guard let passcode = answer.passcode else { throw URLError(.badServerResponse) }
    return passcode
  }

  /// Everyone in the Group. Host only.
  func people() throws -> [Person] {
    let answer: People = try send("GET", "admin/people", nil)
    return answer.people
  }

  /// Adds a Person without a device, for a journey that removes one. Host only.
  func addPerson(_ username: String) throws -> Person {
    try send("POST", "admin/people", ["username": username])
  }

  /// Turns on Social for this lane's Person, as People's invite does.
  func turnOnSocial() throws {
    let _: Preferences = try send("PATCH", "me", ["social": true])
  }

  func devices() throws -> [Device] {
    let response: Devices = try send("GET", "me/devices", nil)
    return response.devices
  }

  func revokeDevice(_ id: String) throws -> Int {
    try status("DELETE", "me/devices/\(id)", nil)
  }

  struct Me: Decodable { let username: String }

  func me() throws -> Me {
    try send("GET", "me", nil)
  }

  /// What `/me` answers this key: 200 while it works, 401 once it is revoked.
  func meStatus() throws -> Int {
    try status("GET", "me", nil)
  }

  struct StartedApprovalRequest: Decodable {
    let code: String
    let secret: String
  }

  struct ApprovalWait: Decodable {
    let status: String
    let key: String?
  }

  /// Starts an Approval Request the way a signed-out TV does, with no key (ADR 0022).
  func startApprovalRequest(label: String) throws -> StartedApprovalRequest {
    try send("POST", "sign-in/requests", ["label": label, "platform": "tvOS"], signed: false)
  }

  /// The TV's wait: `approved` with its key once a Person approved the request, or `pending` after
  /// up to 25 seconds.
  func waitForApproval(_ secret: String) throws -> ApprovalWait {
    try send("POST", "sign-in/requests/wait", ["secret": secret], signed: false, timeout: 40)
  }

  /// 200 while a request with `code` is still waiting, 404 once it is not.
  func findApprovalRequest(_ code: String) throws -> Int {
    try status("POST", "me/sign-in-requests/find", ["code": code])
  }

  private func status(_ method: String, _ path: String, _ body: [String: Any]?) throws -> Int {
    guard let endpoint = URL(string: "\(address)/\(path)") else { throw URLError(.badURL) }
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    var status = 0
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, _ in
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
      done.signal()
    }.resume()
    guard done.wait(timeout: .now() + 20) == .success else { throw URLError(.timedOut) }
    return status
  }

  private func send<Response: Decodable>(
    _ method: String, _ path: String, _ body: [String: Any]?, signed: Bool = true,
    timeout: TimeInterval = 20
  ) throws -> Response {
    guard let endpoint = URL(string: "\(address)/\(path)") else { throw URLError(.badURL) }
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.timeoutInterval = timeout
    if signed {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    var result: Result<Data, Error> = .failure(URLError(.timedOut))
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if let error {
        result = .failure(error)
      } else if !(200..<300).contains(status) {
        result = .failure(URLError(.badServerResponse, userInfo: ["status": status]))
      } else {
        result = .success(data ?? Data())
      }
      done.signal()
    }.resume()
    guard done.wait(timeout: .now() + timeout) == .success else { throw URLError(.timedOut) }
    return try JSONDecoder().decode(Response.self, from: result.get())
  }
}

extension XCTestCase {
  /// Launches Orbis against `address`, signed in with `token` when one is given. Settings live
  /// in memory, so nothing a journey stores outlives the launch, unless `keychain` asks for the
  /// device's real storage, which starts cleared.
  func launchOrbis(
    address: String, token: String? = nil, keychain: Bool = false, arguments: [String] = []
  ) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-orbisServiceAddress", address] + arguments
    if let token {
      app.launchArguments += ["-orbisSignedInWith", token]
    }
    if keychain {
      app.launchArguments.append("-orbisResetSettings")
      // With the keychain cleared, a Debug build signs in with the developer's own
      // ~/.orbis/config.json. Turn that off, so the journey starts signed out on any Mac. It
      // holds for every relaunch of this app.
      app.launchEnvironment["ORBIS_DEVELOPMENT_CONFIG"] = "off"
    } else {
      app.launchEnvironment["ORBIS_TEST_SETTINGS"] = "memory"
    }
    app.launch()
    return app
  }

  func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
