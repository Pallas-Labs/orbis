import Foundation
import OrbisDesign
import OrbisKit

/// What a pasted link asks for: one Set, or a whole YouTube playlist.
///
/// A port of the service's `youTubePlaylistId` and `youTubeVideoId`, with the same hosts and the
/// same identifier rules. The app decides before the request whether to file or import, so a
/// rule that drifted from the service's would send a playlist to filing, which refuses it.
nonisolated enum PlaylistLink {
  enum Kind: Equatable {
    /// A video or SoundCloud link that names no playlist.
    case set
    /// A playlist page, which names no video.
    case playlist
    /// A video played from a playlist. Filing keeps the one Set; importing takes them all.
    case setInPlaylist
  }

  static func kind(of text: String) -> Kind {
    guard let url = youTubeURL(text), playlistId(in: url) != nil else { return .set }
    return videoId(in: url) == nil ? .playlist : .setInPlaylist
  }

  /// The playlist identifier the service would import from this link, or nil.
  static func id(in text: String) -> String? {
    youTubeURL(text).flatMap(playlistId(in:))
  }

  private static func youTubeURL(_ text: String) -> URL? {
    guard let url = LinkField.address(of: text), SetSource.named(by: url) == .youtube else { return nil }
    return url
  }

  private static func query(_ name: String, in url: URL) -> String? {
    URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
  }

  private static func playlistId(in url: URL) -> String? {
    guard let id = query("list", in: url), id.wholeMatch(of: /[A-Za-z0-9_-]{2,64}/) != nil else {
      return nil
    }
    return id
  }

  private static func videoId(in url: URL) -> String? {
    let path = url.path()
    let candidate: String?
    if url.host()?.lowercased() == "youtu.be" {
      candidate = String(path.dropFirst())
    } else if path == "/watch" {
      candidate = query("v", in: url)
    } else {
      candidate = path.wholeMatch(of: /\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?/).map { String($0.1) }
    }
    guard let candidate, candidate.wholeMatch(of: /[A-Za-z0-9_-]{11}/) != nil else { return nil }
    return candidate
  }
}
