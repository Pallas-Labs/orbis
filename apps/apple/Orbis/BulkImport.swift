import Foundation
import Observation
import OrbisDesign

/// One link found in a pasted block of text, and whether Import will file it.
struct BulkLink: Equatable, Sendable {
  enum Verdict: Equatable, Sendable {
    case importable
    /// The same Set appeared earlier in the paste.
    case repeated
    case inLibrary
    case unsupported(String)
  }

  let link: String
  let source: SetSource?
  let verdict: Verdict
}

/// Reads the links out of pasted text, one per line or separated by spaces or commas.
enum BulkLinks {
  static let unsupportedHost = "Orbis takes YouTube, SoundCloud, and Apple Music links."
  static let notASet = "Not a single video, track, or album."

  /// Every web link in `text`, in order. Words that are not links are dropped. A link Orbis takes
  /// is compared with the ones before it and with `filed`, the links of Sets already in the Library.
  nonisolated static func parse(_ text: String, filed: [String]) -> [BulkLink] {
    let library = Set(filed.compactMap { URL(string: $0).flatMap(key(of:)) })
    var seen = Set<String>()
    return tokens(in: text).compactMap { token in
      guard let url = address(of: token) else { return nil }
      let link = url.absoluteString
      guard let source = SetSource.named(by: url) else {
        return BulkLink(link: link, source: nil, verdict: .unsupported(unsupportedHost))
      }
      guard let key = key(of: url) else {
        return BulkLink(link: link, source: source, verdict: .unsupported(notASet))
      }
      let verdict: BulkLink.Verdict =
        library.contains(key) ? .inLibrary : seen.contains(key) ? .repeated : .importable
      seen.insert(key)
      return BulkLink(link: link, source: source, verdict: verdict)
    }
  }

  private nonisolated static func tokens(in text: String) -> [String] {
    let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;"))
    // Links pasted from prose or Markdown arrive wrapped in brackets, quotes, or a full stop.
    let wrapping = CharacterSet(charactersIn: "<>()[]{}\"'`.")
    return text.components(separatedBy: separators)
      .map { $0.trimmingCharacters(in: wrapping) }
      .filter { !$0.isEmpty }
  }

  /// The web address a word names. A word with no scheme counts only when its host is a Source,
  /// so `youtu.be/…` is a link and `e.g.` is not.
  private nonisolated static func address(of token: String) -> URL? {
    if token.contains("://") { return LinkField.address(of: token) }
    guard let url = LinkField.address(of: "https://" + token), SetSource.named(by: url) != nil
    else { return nil }
    return url
  }

  /// The Set a link names, the way the service's `normalizeSourceUrl` reads it: a YouTube video,
  /// a SoundCloud track, or an Apple Music album. Nil for any other page on those hosts.
  nonisolated static func key(of url: URL) -> String? {
    guard let host = url.host()?.lowercased() else { return nil }
    let path = url.path()
    switch SetSource.named(by: url) {
    case .youtube:
      let id: String?
      if host == "youtu.be" {
        id = String(path.dropFirst())
      } else if path == "/watch" {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        id = items?.first { $0.name == "v" }?.value
      } else {
        let embedded = path.wholeMatch(of: /\/(?:shorts|live|embed)\/([\w-]{11})\/?/)
        id = embedded.map { String($0.1) }
      }
      guard let id, id.wholeMatch(of: /[\w-]{11}/) != nil else { return nil }
      return "youtube:\(id)"
    case .soundcloud:
      // The service follows a short link to its track, so only the short link itself is known.
      if host == "on.soundcloud.com" { return path.count > 1 ? "soundcloud-short:\(path)" : nil }
      guard let match = path.wholeMatch(of: /\/([\w-]+)\/([\w-]+)\/?/),
        !["sets", "tracks", "albums", "likes", "reposts"].contains(String(match.2))
      else { return nil }
      return "soundcloud:\(match.1)/\(match.2)"
    case .appleMusic:
      guard let match = path.wholeMatch(of: /\/(?:[a-z]{2}\/)?album\/(?:[^\/]+\/)?(\d{1,20})\/?/)
      else { return nil }
      return "apple-music:\(match.1)"
    case .unknown, nil:
      return nil
    }
  }
}

/// A pasted batch of links, filed together with the same Tags.
@Observable
@MainActor
final class BulkImport {
  struct Row: Identifiable, Equatable {
    enum Outcome: Equatable {
      case waiting
      case filing
      case filed(title: String, download: String?)
      case skipped(String)
      case failed(String)
    }

    let id: Int
    let link: String
    let source: SetSource?
    var outcome: Outcome
  }

  /// How many saves are out at once. Each one reads the link's details from its provider, so a
  /// long paste is spread out rather than sent at once.
  nonisolated static let concurrency = 4

  var text = ""
  var tags: [String] = []
  /// The rows of the last Import, in paste order. Nil until Import runs.
  private(set) var results: [Row]?
  private(set) var isImporting = false

  /// What Import would do with the text as it stands, or what it did.
  func rows(filed: [String]) -> [Row] {
    results ?? Self.rows(BulkLinks.parse(text, filed: filed))
  }

  /// Files every importable link, at most `concurrency` at a time. A refusal or failure lands on
  /// its own row and the rest carry on.
  func run(client: OrbisClient, filed: [String]) async {
    guard !isImporting else { return }
    isImporting = true
    defer { isImporting = false }
    let rows = Self.rows(BulkLinks.parse(text, filed: filed))
    results = rows
    let pending = rows.filter { $0.outcome == .waiting }.map { ($0.id, $0.link) }
    let tags = tags
    var queue = pending.makeIterator()
    await withTaskGroup(of: (Int, Row.Outcome).self) { group in
      var running = 0
      repeat {
        while running < Self.concurrency, let (id, link) = queue.next() {
          results?[id].outcome = .filing
          group.addTask { (id, await Self.file(link, tags: tags, client: client)) }
          running += 1
        }
        guard let (id, outcome) = await group.next() else { break }
        results?[id].outcome = outcome
        running -= 1
      } while true
    }
  }

  /// Clears the last Import so another paste can start. Tags stay for the next batch.
  func startOver() {
    guard !isImporting else { return }
    results = nil
    text = ""
  }

  private static func rows(_ links: [BulkLink]) -> [Row] {
    links.enumerated().map { index, link in
      let outcome: Row.Outcome =
        switch link.verdict {
        case .importable: .waiting
        case .repeated: .skipped("Already in this paste")
        case .inLibrary: .skipped("Already in your Library")
        case .unsupported(let reason): .skipped(reason)
        }
      return Row(id: index, link: link.link, source: link.source, outcome: outcome)
    }
  }

  nonisolated private static func file(_ link: String, tags: [String], client: OrbisClient) async
    -> Row.Outcome
  {
    do {
      let (saved, download) = try await client.saveReportingDownload(url: link, tags: tags)
      return .filed(title: saved.title, download: download.flatMap(note))
    } catch OrbisError.duplicate {
      return .skipped("Already in your Library")
    } catch let error as OrbisError {
      return .failed(error.message)
    } catch {
      return .failed(OrbisError.unreachable.message)
    }
  }

  nonisolated private static func note(_ download: AutoDownload) -> String? {
    switch download {
    case .queued, .inProgress: "Downloading"
    case .ready: "Downloaded"
    case .queueFull: "Not downloading: 20 downloads are already waiting"
    case .disabled: "Automatic downloads are off"
    case .unavailable: nil
    }
  }
}
