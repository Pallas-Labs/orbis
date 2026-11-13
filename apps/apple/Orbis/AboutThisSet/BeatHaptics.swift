#if os(iOS)
  import CoreHaptics
  import Foundation

  /// The beat, felt: one bar when a section is picked, and a loop of bars while the tempo circle
  /// is held. Beat 1 is full and beats 2 to 4 are lighter; faster tempos tap firmer and sharper.
  @MainActor
  final class BeatHaptics {
    private var engine: CHHapticEngine?
    private var bar: CHHapticPatternPlayer?
    private var loop: CHHapticAdvancedPatternPlayer?

    /// Builds and starts the engine once. Hardware with no haptic actuator gets no engine, and
    /// every call after this does nothing.
    func prepare() {
      guard engine == nil, CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
      guard let engine = try? CHHapticEngine() else { return }
      engine.playsHapticsOnly = true
      engine.isAutoShutdownEnabled = true
      // Each play starts the engine again, so a stop needs no restart here. A reset loses the
      // players, so they are dropped and the next play makes new ones.
      engine.stoppedHandler = { @Sendable [weak self] _ in
        guard let self else { return }
        Task { @MainActor in self.dropPlayers() }
      }
      engine.resetHandler = { @Sendable [weak self] in
        guard let self else { return }
        Task { @MainActor in self.dropPlayers() }
      }
      try? engine.start()
      self.engine = engine
    }

    /// One bar at `bpm`, with beat 1 now.
    func playBar(bpm: Double) {
      guard let engine else { return }
      stopAll()
      do {
        try engine.start()
        let player = try engine.makePlayer(with: Self.pattern(bpm: bpm))
        try player.start(atTime: CHHapticTimeImmediate)
        bar = player
      } catch {
        bar = nil
      }
    }

    /// Bars at `bpm` until `stopLoop`, with beat 1 now.
    func startLoop(bpm: Double) {
      guard let engine else { return }
      stopAll()
      do {
        try engine.start()
        let player = try engine.makeAdvancedPlayer(with: Self.pattern(bpm: bpm))
        player.loopEnabled = true
        player.loopEnd = 4 * 60 / bpm
        try player.start(atTime: CHHapticTimeImmediate)
        loop = player
      } catch {
        loop = nil
      }
    }

    func stopLoop() {
      try? loop?.stop(atTime: CHHapticTimeImmediate)
      loop = nil
    }

    func shutDown() {
      stopAll()
      engine?.stop(completionHandler: nil)
    }

    private func stopAll() {
      try? bar?.stop(atTime: CHHapticTimeImmediate)
      bar = nil
      stopLoop()
    }

    private func dropPlayers() {
      bar = nil
      loop = nil
    }

    /// Four taps a beat apart. Heat runs from 0 at 130 BPM to 1 at 160 and scales every tap.
    private static func pattern(bpm: Double) throws -> CHHapticPattern {
      let beat = 60 / bpm
      let heat = Float(min(max((bpm - 130) / 30, 0), 1))
      let events = (0..<4).map { i -> CHHapticEvent in
        let accent: Float = i == 0 ? 1 : 0.5
        return CHHapticEvent(
          eventType: .hapticTransient,
          parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: accent * (0.7 + 0.3 * heat)),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.25 + 0.6 * heat),
          ],
          relativeTime: Double(i) * beat)
      }
      return try CHHapticPattern(events: events, parameters: [])
    }
  }
#endif
