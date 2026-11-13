import Foundation
import OrbisKitTesting
import XCTest

@testable import Orbis
@testable import OrbisKit

/// The service counts Listening Time from the step between two saved Playback Positions, and only
/// when the step matches the time between the saves. So the app reports at once whenever the
/// place or the clock starts over, not only on its 5 s tick (PAL-2133).
///
/// Ways this could go wrong, written before the code:
///
/// 1. A start reports nothing until the first tick, so up to 5 s after it count nothing.
/// 2. A resume reports nothing until the next tick, whose step the service measures from the
///    pause, so that step counts nothing.
/// 3. A seek never reports the place it leaves, so the seconds since the last tick count nothing.
/// 4. A seek never reports the place it moves to, so the first tick after it counts nothing.
/// 5. A Set's end reports no last place, so the seconds since the last tick count nothing.
/// 6. A report made at once lands after a later one, or after the completion, which writes an
///    old place over a newer one.
@MainActor
final class PositionReportTimingTests: XCTestCase {
  /// The position saves and completions a model sent, in order, as `PUT a 42` or `completion a`.
  final class Writes: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ request: URLRequest) {
      let path = request.url?.path() ?? ""
      let parts = path.split(separator: "/")
      if request.httpMethod == "PUT", parts.count == 3, parts[0] == "sets", parts[2] == "position",
        let body = request.httpBody,
        let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Int],
        let seconds = fields["seconds"]
      {
        lock.withLock { entries.append("PUT \(parts[1]) \(seconds)") }
      } else if request.httpMethod == "POST", path == "/queue/completion" {
        lock.withLock { entries.append("completion") }
      }
    }

    var all: [String] { lock.withLock { entries } }
  }

  private nonisolated static let setJSON = """
    {"id":"a","url":"https://www.youtube.com/watch?v=aabcdefghij","title":"Set a",
    "source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"ready","playlistIds":[],"playbackPositionSeconds":600,
    "listenCount":0,"finishCount":0,"lastListenedAt":null}
    """

  private var engines: [FakeEngine] = []

  private func model(writes: Writes) throws -> AppModel {
    let client = OrbisClient(
      address: try XCTUnwrap(URL(string: "https://orbis.example.test")),
      token: "token",
      session: StubProtocol.session(responder: { request in
        writes.record(request)
        switch (request.httpMethod, request.url?.path()) {
        case ("PUT", "/queue/active"):
          return (200, "{\"queue\":{\"activeSetId\":\"a\",\"entries\":[\(Self.setJSON)]}}")
        case ("PUT", "/sets/a/position"):
          return (200, Self.setJSON)
        case ("POST", "/queue/completion"):
          return (200, "{\"queue\":{\"activeSetId\":null,\"entries\":[]}}")
        case ("GET", "/sets"):
          return (200, "{\"sets\":[]}")
        default:
          return (200, "{}")
        }
      })
    )
    let player = AudioPlayer(
      session: OwnSession().session,
      engines: { [unowned self] set in
        let engine = FakeEngine(source: set.source)
        self.engines.append(engine)
        return engine
      })
    return AppModel(client: client, settings: MemoryClientSettings(), player: player)
  }

  /// Waits until `writes` holds `expected` in that order, with any other writes between.
  private func waitFor(
    _ expected: [String], in writes: Writes, file: StaticString = #filePath, line: UInt = #line
  ) async {
    let deadline = ContinuousClock.now + .seconds(3)
    while !Self.holds(writes.all, expected), ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(
      Self.holds(writes.all, expected), "\(expected) not in order in \(writes.all)", file: file,
      line: line)
  }

  private static func holds(_ all: [String], _ expected: [String]) -> Bool {
    var rest = expected[...]
    for entry in all where entry == rest.first { rest = rest.dropFirst() }
    return rest.isEmpty
  }

  func testAStartAResumeASeekAndAnEndEachReportAtOnce() async throws {
    let writes = Writes()
    let model = try model(writes: writes)
    let player = model.audioPlayer

    // Failure 1: the start reports the place it starts from, before any tick.
    await model.playSet("a")
    let engine = try XCTUnwrap(engines.last)
    engine.time = 600
    engine.ready(duration: 5400)
    await waitFor(["PUT a 600"], in: writes)
    XCTAssertEqual(player.state, .playing)

    // Failure 2: the resume reports at once, so the step after it is measured from now. The
    // place it resumes from is one no tick has seen, and the first tick is 5 s away.
    engine.time = 642
    player.pause()
    engine.time = 643
    player.resume()
    await waitFor(["PUT a 600", "PUT a 643"], in: writes)

    // Failures 3 and 4: the place left, then the place moved to.
    engine.time = 650
    player.seek(to: 1200)
    await waitFor(["PUT a 650", "PUT a 1200"], in: writes)

    // Failures 5 and 6: the last place, then the completion.
    engine.time = 5400
    await model.finishedPlaying("a")
    await waitFor(["PUT a 650", "PUT a 1200", "PUT a 5400", "completion"], in: writes)
    let last = try XCTUnwrap(writes.all.lastIndex(of: "PUT a 5400"))
    let completion = try XCTUnwrap(writes.all.firstIndex(of: "completion"))
    XCTAssertLessThan(last, completion, "the completion went before the last place")
    player.stop()
  }
}
