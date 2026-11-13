import Foundation
import OrbisKit

/// What makes the sound for `AudioPlayer`. `AudioPlayer` keeps everything the person sees and the
/// service hears (the playback state, Playback Position, Listens, Finishes, the Listening Queue,
/// and diagnostics) and asks the engine only to load, play, pause, and seek.
///
/// One engine plays one Set: `AudioPlayer` makes a new one for each play and drops it at stop or
/// a media reset, so an engine never carries a Set's state into the next.
@MainActor
protocol PlaybackEngine: AnyObject {
  /// Whether the engine is the system's music player, which plays out of this process. It brings
  /// up its own audio session, draws Now Playing, and answers the remote commands, so `AudioPlayer`
  /// does none of the three. When false, `AudioPlayer` does all three.
  var isSystemMusicPlayer: Bool { get }

  /// Starts loading the Set's audio. `onEvent` hears what happens next, on the main actor, until
  /// `invalidate()`.
  func load(
    _ set: SavedSet, baseURL: URL, token: String,
    onEvent: @escaping @MainActor (PlaybackEngineEvent) -> Void)
  func play()
  func pause()
  /// Moves to a time in the mix exactly, then calls back on the main actor with whether the move
  /// finished. A move that a later one interrupts calls back unfinished.
  func seek(to seconds: TimeInterval, completion: @escaping @MainActor (Bool) -> Void)
  /// Stops all events, including ones already on their way. Called before the engine is dropped.
  func invalidate()

  /// Where the mix is, in seconds; not finite while the engine does not know.
  var currentTime: TimeInterval { get }
  /// The mix's length as the audio reports it; not finite, or zero, while it does not know.
  var duration: TimeInterval { get }
  var rate: Float { get }
  var status: PlaybackEngineStatus { get }
  var timeControl: PlaybackEngineTimeControl { get }
  /// Why the engine is waiting to play, for diagnostics.
  var waitingReason: PlaybackDiagnostics.WaitingReason { get }
  /// The engine's own name for that reason, for the log.
  var waitingReasonName: String? { get }
  /// Why loading failed, once `status` is `.failed`.
  var failure: PlaybackDiagnostics.NormalizedError? { get }
  var buffer: PlaybackEngineBuffer { get }
  /// The latest network transfer counters, when the engine has any.
  var access: PlaybackEngineAccess? { get }
}

/// What changed in an engine. Most events carry no value: `AudioPlayer` reads the engine's
/// current values when one arrives, so an event that lands late repeats the latest state instead
/// of undoing it.
enum PlaybackEngineEvent {
  case statusChanged
  case durationChanged
  case bufferChanged
  case rateChanged
  case timeControlChanged
  /// Twice a second while the engine exists, to move the clock.
  case tick
  /// The audio played to its end.
  case ended
  /// Playback broke after it started.
  case failed(PlaybackDiagnostics.NormalizedError?)
  /// The system's controls paused an engine that answers them itself (`isSystemMusicPlayer`), so
  /// `AudioPlayer` heard nothing of the press.
  case pausedBySystem
  case stalled
  /// The stream logged an error; playback may continue.
  case streamError(PlaybackDiagnostics.NormalizedError?)
  case timeJumped
  case accessLogged
}

enum PlaybackEngineStatus: Equatable {
  case unknown, ready, failed
}

enum PlaybackEngineTimeControl: Equatable {
  case paused, waiting, playing
}

struct PlaybackEngineBuffer {
  var isEmpty = false
  var isFull = false
  var isLikelyToKeepUp = false
  /// The first eight loaded ranges, in seconds.
  var ranges: [(start: TimeInterval, duration: TimeInterval)] = []
  /// How many loaded ranges there are, including any past the first eight.
  var rangeCount = 0
}

struct PlaybackEngineAccess {
  var bytesTransferred: Int64
  var transferDuration: TimeInterval
  var observedBitrate: Double
  var indicatedBitrate: Double
  var stalls: Int
  var downloadedDuration: TimeInterval
}
