import Foundation

/// A Set's public address, `https://orbis.p11a.xyz/s/<set id>` (ADR 0023), and the
/// `orbis://s/<set id>` form the shared page's Open in Orbis button uses.
nonisolated enum OrbisLink {
  static let host = "orbis.p11a.xyz"

  /// The Orbis Link to share for a Set.
  static func url(forSet id: String) -> URL {
    URL(string: "https://\(host)/s/\(id)")!
  }

  /// The Set an Orbis Link names, or nil for any other address. The id is sent back to the
  /// service as a path segment, so it is held to the characters a Set id is made of.
  static func setId(in url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased() else { return nil }
    let segments: [String]
    switch scheme {
    case "https":
      guard url.host()?.lowercased() == host else { return nil }
      segments = url.pathComponents.filter { $0 != "/" }
    case "orbis":
      // In `orbis://s/<id>` the `s` is the host, not the first path segment.
      guard let first = url.host() else { return nil }
      segments = [first] + url.pathComponents.filter { $0 != "/" }
    default:
      return nil
    }
    guard segments.count == 2, segments[0] == "s",
      segments[1].wholeMatch(of: /[A-Za-z0-9-]{1,64}/) != nil
    else { return nil }
    return segments[1]
  }
}
