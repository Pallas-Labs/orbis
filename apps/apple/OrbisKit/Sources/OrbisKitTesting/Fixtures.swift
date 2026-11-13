import Foundation

/// Service answers a test feeds `StubProtocol`, written as the service sends them.
public enum Fixtures {
  public static func savedSet(title: String, tags: [String], downloadState: String = "none") -> String {
    """
    {"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
    "title":"\(title)","source":"youtube","tags":\(encode(tags)),"createdAt":"2026-01-01T00:00:00.000Z",
    "releasedAt":null,"creator":"Ada Lovelace","artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"\(downloadState)","playlistIds":[],"playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
    "lastListenedAt":null}
    """
  }

  private static func encode(_ tags: [String]) -> String {
    let data = try? JSONEncoder().encode(tags)
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
  }
}
