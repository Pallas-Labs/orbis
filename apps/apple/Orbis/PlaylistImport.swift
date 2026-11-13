import Foundation
import OrbisDesign
import OrbisKit

/// Where a playlist import stands. One value, so the sheet cannot show the working row over a
/// summary or a failure beside a running import.
enum PlaylistImport: Equatable {
  case idle
  case requesting(link: String)
  case importing(link: String, job: PlaylistImportJob)
  case imported(ImportedPlaylist)
  case failed(link: String, Failure)

  enum Failure: Equatable {
    case request(OrbisError)
    /// Its Sets so far stay in the Playlist, and Try Again continues it.
    case stopped(message: String)
  }

  var isImporting: Bool {
    switch self {
    case .requesting, .importing: true
    case .idle, .imported, .failed: false
    }
  }

  var importingPlaylistId: String? {
    if case .importing(_, let job) = self { job.playlist.id } else { nil }
  }

  var importedPlaylistId: String? {
    if case .imported(let imported) = self { imported.playlist.id } else { nil }
  }

  /// "Importing 23 of 140…", or "Importing…" until the service says how long the playlist is.
  var progress: String? {
    switch self {
    case .importing(_, let job):
      if case .running(let processed, let total?) = job.state, total > 0 {
        return "Importing \(min(processed, total)) of \(total)…"
      }
      return "Importing…"
    case .requesting:
      return "Importing…"
    case .idle, .imported, .failed:
      return nil
    }
  }

  /// What the link field shows for the import, or nil when the import has nothing to say there.
  var fieldState: LinkFieldState? {
    switch self {
    case .requesting, .importing: .checking
    case .failed(_, let failure): .invalid(message: failure.message)
    case .idle, .imported: nil
    }
  }
}

extension PlaylistImport.Failure {
  var message: String {
    switch self {
    case .request(let error): PlaylistImport.message(for: error)
    case .stopped(let message): message
    }
  }
}

extension PlaylistImport {
  /// The sentence a refused import shows. Only here are a 404 and a 503 known to mean a playlist,
  /// so the service's generic status line is replaced with what the person can do about it.
  static func message(for error: OrbisError) -> String {
    switch error {
    // A 404 with no sentence did not come from the import, and an empty playlist keeps the
    // service's own words.
    case .server(404, let message) where !message.isEmpty && !message.contains("no tracks"):
      "This playlist is private or no longer exists. Only public and unlisted playlists can be imported."
    case .server(503, let message) where message.isEmpty || message.contains("not set up"):
      "This Orbis server can't read YouTube playlists yet."
    // The service writes these for people: a link that is not a playlist, a playlist with nothing
    // playable, and YouTube not answering.
    case .server(400, let message) where !message.isEmpty, .server(404, let message) where !message.isEmpty,
      .server(503, let message) where !message.isEmpty:
      message
    default:
      error.message
    }
  }
}
