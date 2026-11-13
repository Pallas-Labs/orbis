import AVFoundation
import Foundation
import MediaPlayer
import XCTest

@testable import Orbis
@testable import OrbisKit

/// An Apple Music Set plays through MusicKit, song by song, while the rest of the app sees one mix
/// with one clock (ADR 0021). MusicKit does not play in the simulator, so these tests check the
/// two things that do not need it: the arithmetic between mix time and a song's own time, and what
/// `AudioPlayer` does with an engine that owns Now Playing.
///
/// Ways this could go wrong, written before the code:
///
/// 1. A seek to a Cue's start lands at the end of the song before it, because the Cue start the
///    service summed and the lengths MusicKit reports differ in the last digits.
/// 2. A seek before the start, past the end, or to a time that is not a number picks a song that
///    does not exist.
/// 3. An album with no songs, or a song with no length, divides or indexes its way to a crash.
/// 4. A song that plays a little past its listed length reports a mix time inside the next song,
///    so the Cue flips before the song does.
/// 5. The position is reported as zero while MusicKit has no current song, which would write a
///    Playback Position of zero over the real one.
/// 6. Orbis writes its own Now Playing over the one `ApplicationMusicPlayer` publishes, or keeps
///    answering the remote commands, so a lock screen press runs twice.
/// 7. A pause from the lock screen, which reaches MusicKit and not Orbis, leaves Orbis showing a
///    spinner instead of Paused.
/// 8. The end of an Apple Music Set does not finish its Listen, so the Listening Queue never moves
///    on to a Set with Retained Audio, or the next Set is handed to the wrong engine.
/// 9. A Set from a service that names `apple-music` decodes as an unknown source and offers no Play.
/// 10. Orbis brings up its own audio session for an Apple Music Set. MusicKit plays out of process,
///     so its start interrupts that session, and Orbis pauses MusicKit for the interruption: Play
///     and Resume do nothing (PAL-1160).
@MainActor
final class AppleMusicPlaybackTests: XCTestCase {
  // MARK: - Mix time

  private let album = MixTimeline(lengths: [200.5, 310.25, 189.125])

  func testTheMixIsAsLongAsItsSongs() {
    XCTAssertEqual(album.duration, 699.875)
    XCTAssertEqual(album.starts, [0, 200.5, 510.75])
  }

  func testATimeInASongIsThatSongsStartPlusTheOffset() {
    XCTAssertEqual(album.time(song: 0, at: 12), 12)
    XCTAssertEqual(album.time(song: 2, at: 30), 540.75)
  }

  func testATimeInAMixLandsInTheSongThatHoldsIt() {
    XCTAssertEqual(album.locate(0)?.song, 0)
    XCTAssertEqual(album.locate(250)?.song, 1)
    XCTAssertEqual(album.locate(250)?.offset, 49.5)
    XCTAssertEqual(album.locate(600)?.song, 2)
  }

  /// Failure 1: the service's Cue start is a hair past the summed lengths, or a hair short.
  func testACueStartThatDiffersInTheLastDigitsStartsItsOwnSong() {
    let early = album.locate(510.7499)
    XCTAssertEqual(early?.song, 2)
    XCTAssertEqual(early?.offset, 0)
    let late = album.locate(200.5001)
    XCTAssertEqual(late?.song, 1)
    XCTAssertEqual(late?.offset ?? -1, 0.0001, accuracy: 0.00001)
  }

  /// Failure 2.
  func testATimeOutsideTheMixLandsAtItsEdges() {
    XCTAssertEqual(album.locate(-30)?.song, 0)
    XCTAssertEqual(album.locate(-30)?.offset, 0)
    XCTAssertEqual(album.locate(5000)?.song, 2)
    XCTAssertEqual(album.locate(5000)?.offset, 189.125)
    XCTAssertNil(album.locate(.nan))
    XCTAssertNil(album.locate(.infinity))
  }

  /// Failure 3.
  func testAnEmptyAlbumHasNoPlaceToLand() {
    let empty = MixTimeline(lengths: [])
    XCTAssertEqual(empty.duration, 0)
    XCTAssertNil(empty.locate(10))
    XCTAssertTrue(empty.time(song: 0, at: 5).isNaN)
  }

  func testASongWithNoLengthTakesNoTime() {
    let gaps = MixTimeline(lengths: [100, nil, 50])
    XCTAssertEqual(gaps.duration, 150)
    XCTAssertEqual(gaps.starts, [0, 100, 100])
    XCTAssertEqual(gaps.locate(120)?.song, 2)
  }

  /// Failure 4.
  func testASongThatRunsLongStaysInsideItsOwnSpan() {
    XCTAssertEqual(album.time(song: 0, at: 203), 200.5)
  }

  /// Failure 5.
  func testAnUnknownSongOrOffsetIsAnUnknownTime() {
    XCTAssertTrue(album.time(song: 7, at: 3).isNaN)
    XCTAssertTrue(album.time(song: -1, at: 3).isNaN)
    XCTAssertTrue(album.time(song: 1, at: .nan).isNaN)
  }

  // MARK: - The Set

  /// Failure 9.
  func testAnAppleMusicSetDecodesAndCanPlayWithoutRetainedAudio() throws {
    let json = Data(
      """
      {"id":"am","url":"https://music.apple.com/album/1440818839","title":"Fabric 01",
       "source":"apple-music","tags":[],"createdAt":"2026-10-25T00:00:00.000Z",
       "metadataState":"enriched","downloadState":"none","playbackPositionSeconds":0,
       "listenCount":0,"finishCount":0}
      """.utf8)
    let set = try JSONDecoder().decode(SavedSet.self, from: json)
    XCTAssertEqual(set.source, .appleMusic)
    XCTAssertEqual(set.source.label, "Apple Music")
    XCTAssertTrue(set.isPlayable)
    XCTAssertEqual(set.appleMusicAlbumID, "1440818839")
    XCTAssertFalse(self.set(id: "yt", source: .youtube, downloadState: "none").isPlayable)
    XCTAssertTrue(self.set(id: "yt", source: .youtube, downloadState: "ready").isPlayable)
  }

  func testEachSetGoesToTheEngineForItsSource() {
    XCTAssertTrue(AudioPlayer.engine(for: set(id: "am", source: .appleMusic)) is MusicKitEngine)
    XCTAssertTrue(AudioPlayer.engine(for: set(id: "yt", source: .youtube)) is AVPlayerEngine)
  }

  // MARK: - AudioPlayer with an engine that owns Now Playing

  /// Failure 6.
  func testOrbisLeavesNowPlayingAndTheRemoteCommandsToMusicKit() async throws {
    let player = makePlayer()
    player.play(set: set(id: "yt", source: .youtube), baseURL: try address, token: "t", autoplay: false)
    XCTAssertTrue(player.answersRemoteCommands)

    player.play(set: set(id: "am", source: .appleMusic), baseURL: try address, token: "t")
    XCTAssertFalse(player.answersRemoteCommands)
    let theirs: [String: Any] = [MPMediaItemPropertyTitle: "Song from MusicKit"]
    MPNowPlayingInfoCenter.default().nowPlayingInfo = theirs
    let engine = try XCTUnwrap(engines.last)
    engine.ready(duration: 699.875)
    await settle()
    engine.time = 250
    engine.send(.tick)
    player.seek(to: 510.75)
    player.setCues([])
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyTitle] as? String,
      "Song from MusicKit")

    // Back to a Set with Retained Audio, Orbis answers the commands again.
    player.play(set: set(id: "yt", source: .youtube), baseURL: try address, token: "t", autoplay: false)
    XCTAssertTrue(player.answersRemoteCommands)
    player.stop()
  }

  func testTheClockAndTheLengthAreInMixTime() async throws {
    let player = makePlayer()
    player.play(set: set(id: "am", source: .appleMusic), baseURL: try address, token: "t")
    let engine = try XCTUnwrap(engines.last)
    engine.ready(duration: 699.875)
    await settle()
    XCTAssertEqual(player.duration, 699.875)
    engine.time = 540.75
    engine.send(.tick)
    XCTAssertEqual(player.elapsed, 540.75)
    XCTAssertEqual(player.settledPosition, 540.75)
    player.stop()
  }

  /// Failure 7.
  func testAPauseFromTheLockScreenReadsAsPaused() async throws {
    let player = makePlayer()
    player.play(set: set(id: "am", source: .appleMusic), baseURL: try address, token: "t")
    let engine = try XCTUnwrap(engines.last)
    engine.ready(duration: 699.875)
    await settle()
    engine.playing = true
    engine.send(.timeControlChanged)
    XCTAssertEqual(player.state, .playing)

    engine.playing = false
    engine.send(.pausedBySystem)
    engine.send(.rateChanged)
    engine.send(.timeControlChanged)
    XCTAssertEqual(player.state, .paused)
    player.stop()
  }

  #if !os(macOS)
    /// Failure 10, as Parth's iPhone logged it: every Play was followed within 30 ms by an
    /// interruption of Orbis's own audio session, and the Set never left Loading.
    func testPlayPauseAndPlayAgainSoundWithoutAnInterruption() async throws {
      let session = OwnSession()
      let player = makePlayer(session: session)
      player.play(set: set(id: "am", source: .appleMusic), baseURL: try address, token: "t")
      let engine = try XCTUnwrap(engines.last)
      engine.interrupts = session
      engine.ready(duration: 699.875)
      await settle()
      XCTAssertEqual(player.state, .playing, "Play must start an Apple Music Set")
      XCTAssertTrue(engine.playing)

      engine.time = 250
      engine.send(.tick)
      player.togglePlayPause()
      XCTAssertEqual(player.state, .paused)
      XCTAssertFalse(engine.playing)

      player.togglePlayPause()
      await settle()
      XCTAssertEqual(player.state, .playing, "Play after Pause must sound again")
      XCTAssertTrue(engine.playing)
      XCTAssertEqual(player.elapsed, 250, "Play after Pause resumes where it paused")

      player.seek(to: 510.75)
      await settle()
      XCTAssertEqual(engine.time, 510.75)
      XCTAssertEqual(player.elapsed, 510.75)
      XCTAssertEqual(player.state, .playing, "a seek to a Cue keeps playing")
      player.stop()
    }
  #endif

  /// Failure 8: the Listening Queue moves from an Apple Music Set to one with Retained Audio and
  /// back, each on its own engine.
  func testTheEndOfAnAppleMusicSetFinishesItAndTheNextSetGetsItsOwnEngine() async throws {
    let player = makePlayer()
    var finished: [String] = []
    player.onFinished = { finished.append($0) }
    player.play(set: set(id: "am", source: .appleMusic), baseURL: try address, token: "t")
    let first = try XCTUnwrap(engines.last)
    first.ready(duration: 699.875)
    await settle()
    first.time = 699.875
    first.send(.ended)
    XCTAssertEqual(finished, ["am"])

    player.play(set: set(id: "yt", source: .youtube), baseURL: try address, token: "t")
    XCTAssertEqual(engines.last?.source, .youtube)
    XCTAssertTrue(first.invalidated)
    let second = try XCTUnwrap(engines.last)
    second.ready(duration: 60)
    await settle()
    second.time = 60
    second.send(.ended)
    XCTAssertEqual(finished, ["am", "yt"])

    player.play(set: set(id: "am2", source: .appleMusic), baseURL: try address, token: "t")
    XCTAssertEqual(engines.last?.source, .appleMusic)
    XCTAssertFalse(player.answersRemoteCommands)
    player.stop()
  }

  // MARK: - Helpers

  /// An address in a block no host answers, so the item waits and never sounds.
  private var address: URL {
    get throws { try XCTUnwrap(URL(string: "http://10.255.255.1:9")) }
  }
  private var engines: [FakeEngine] = []

  private func makePlayer(session: OwnSession = OwnSession()) -> AudioPlayer {
    AudioPlayer(
      session: session.session,
      engines: { [unowned self] set in
        let engine = FakeEngine(source: set.source)
        self.engines.append(engine)
        return engine
      })
  }

  /// Lets the session start that `play` queued answer.
  private func settle() async {
    for _ in 0..<20 { await Task.yield() }
  }

  private func set(
    id: String, source: SetSource, downloadState: String = "none"
  ) -> SavedSet {
    SavedSet(
      id: id,
      url: source == .appleMusic
        ? "https://music.apple.com/album/1440818839"
        : "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Mix \(id)",
      source: source,
      tags: [],
      createdAt: "2026-10-25T00:00:00.000Z",
      releasedAt: nil,
      creator: nil,
      artworkUrl: nil,
      artworkLargeUrl: nil,
      durationSeconds: nil,
      metadataState: "enriched",
      downloadState: source == .appleMusic ? "none" : downloadState,
      playlistIds: [],
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }
}

/// Orbis's own audio session, which is active from a start until the next end.
@MainActor
private final class OwnSession {
  private(set) var isActive = false

  nonisolated var session: AudioPlayer.Session {
    AudioPlayer.Session(
      start: {
        await self.setActive(true)
        return true
      },
      end: { await self.setActive(false) })
  }

  private func setActive(_ active: Bool) { isActive = active }
}

/// An engine that plays nothing and reports what the test tells it to. It owns Now Playing for an
/// Apple Music Set, as the MusicKit engine does.
@MainActor
private final class FakeEngine: PlaybackEngine {
  let source: SetSource
  private var onEvent: (@MainActor (PlaybackEngineEvent) -> Void)?
  var time: TimeInterval = 0
  var length: TimeInterval = .nan
  var playing = false
  var invalidated = false
  var status = PlaybackEngineStatus.unknown
  /// Orbis's session, when this engine starts out of process as MusicKit does: a start while that
  /// session is active interrupts it, as the system did on Parth's iPhone.
  var interrupts: OwnSession?

  init(source: SetSource) { self.source = source }

  var isSystemMusicPlayer: Bool { source == .appleMusic }

  func load(
    _ set: SavedSet, baseURL: URL, token: String,
    onEvent: @escaping @MainActor (PlaybackEngineEvent) -> Void
  ) {
    self.onEvent = onEvent
  }

  func ready(duration: TimeInterval) {
    length = duration
    status = .ready
    send(.statusChanged)
  }

  func send(_ event: PlaybackEngineEvent) { onEvent?(event) }

  func play() {
    playing = true
    #if !os(macOS)
      if interrupts?.isActive == true {
        NotificationCenter.default.post(
          name: AVAudioSession.interruptionNotification, object: nil,
          userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
      }
    #endif
    send(.rateChanged)
    send(.timeControlChanged)
  }
  func pause() { playing = false }
  func seek(to seconds: TimeInterval, completion: @escaping @MainActor (Bool) -> Void) {
    time = seconds
    completion(true)
  }
  func invalidate() {
    invalidated = true
    onEvent = nil
  }

  var currentTime: TimeInterval { time }
  var duration: TimeInterval { length }
  var rate: Float { playing ? 1 : 0 }
  var timeControl: PlaybackEngineTimeControl { playing ? .playing : .paused }
  var waitingReason: PlaybackDiagnostics.WaitingReason { .none }
  var waitingReasonName: String? { nil }
  var failure: PlaybackDiagnostics.NormalizedError? { nil }
  var buffer: PlaybackEngineBuffer { PlaybackEngineBuffer() }
  var access: PlaybackEngineAccess? { nil }
}
