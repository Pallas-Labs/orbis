#if os(iOS)
  import OrbisDesign
  import OrbisKit
  import SwiftUI

  /// About This Set: the Set's tempo, felt and seen, and its energy. It opens short on the tempo
  /// circle and the energy card; pulled up to `.large`, the sections show below.
  struct AboutThisSetSheet: View {
    let analysis: SetAnalysis
    /// Where the Set was left, which picks the section the sheet opens on.
    let position: TimeInterval
    let artwork: URL?

    static let short = PresentationDetent.height(420)

    @State private var detent = Self.short

    var body: some View {
      AboutThisSetContent(
        analysis: analysis, position: position, artwork: artwork, expanded: detent == .large
      )
      .presentationDetents([Self.short, .large], selection: $detent)
      .presentationBackgroundInteraction(.enabled)
      .presentationCornerRadius(28)
      .presentationDragIndicator(.visible)
    }
  }

  private struct AboutThisSetContent: View {
    let analysis: SetAnalysis
    let position: TimeInterval
    let artwork: URL?
    /// The sheet is at its tall detent. The sections show only then.
    let expanded: Bool

    @State private var selected: Int?
    @State private var clock: BeatClock
    @State private var haptics = BeatHaptics()
    @GestureState private var isHolding = false
    @Namespace private var highlight
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(analysis: SetAnalysis, position: TimeInterval, artwork: URL?, expanded: Bool) {
      self.analysis = analysis
      self.position = position
      self.artwork = artwork
      self.expanded = expanded
      let start = AboutThisSetReading.section(at: position, in: analysis.sections)
      _selected = State(initialValue: start)
      _clock = State(
        initialValue: BeatClock(
          bpm: start.map { analysis.sections[$0].bpm } ?? analysis.medianBpm ?? 120))
    }

    var body: some View {
      ScrollView {
        VStack(spacing: 0) {
          header
          metronome.padding(.top, 8)
          if let energy = AboutThisSetReading.Energy(analysis) {
            EnergyCard(energy: energy, played: position / max(analysis.durationSeconds, 1))
              .padding(.top, 16)
          }
          if !analysis.sections.isEmpty {
            sections.padding(.top, 12)
              .opacity(expanded ? 1 : 0)
              .animation(.easeOut(duration: 0.2), value: expanded)
              .accessibilityHidden(!expanded)
          }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 24)
      }
      .scrollBounceBehavior(.basedOnSize)
      .foregroundStyle(.white)
      .environment(\.colorScheme, .dark)
      .presentationBackground { surface }
      .accessibilityIdentifier("about-this-set")
      // Holding starts a bar on the touch: the circle kicks on beat 1 as the first tap lands.
      .onChange(of: isHolding) { _, holding in
        if holding {
          withAnimation(.snappy(duration: 0.2)) { clock.restart(bpm: clock.bpm) }
          haptics.startLoop(bpm: clock.bpm)
        } else {
          haptics.stopLoop()
        }
      }
      .onAppear { haptics.prepare() }
      .onDisappear { haptics.shutDown() }
    }

    private var header: some View {
      ZStack {
        Text("About This Set").font(.headline)
          .accessibilityAddTraits(.isHeader)
        HStack {
          Spacer()
          Button { dismiss() } label: {
            Image(systemName: "xmark").font(.footnote.weight(.bold))
              .foregroundStyle(.secondary)
              .frame(width: 30, height: 30)
              .background(.quaternary, in: .circle)
          }
          .accessibilityLabel("Close")
          .accessibilityIdentifier("about-this-set-close")
        }
      }
      .padding(.top, 18)
    }

    /// The tempo circle. Hold it to feel the beat for as long as the finger stays down.
    private var metronome: some View {
      VStack(spacing: 6) {
        Metronome(clock: clock, diameter: 140)
          .scaleEffect(isHolding && !reduceMotion ? 1.05 : 1)
          .animation(.snappy(duration: 0.2), value: isHolding)
          .contentShape(Circle())
          .gesture(hold)
        Text(isHolding ? "Feeling \(Int(clock.bpm.rounded())) BPM" : "Hold to feel the beat")
          .font(.caption)
          .opacity(isHolding ? 0.85 : 0.45)
          .contentTransition(.opacity)
          .animation(.snappy(duration: 0.2), value: isHolding)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Tempo, \(Int(clock.bpm.rounded())) beats per minute")
      .accessibilityAction(named: "Feel the beat") { feelBar(bpm: clock.bpm) }
      .accessibilityIdentifier("about-this-set-tempo")
    }

    private var hold: some Gesture {
      LongPressGesture(minimumDuration: 0.25)
        .sequenced(before: DragGesture(minimumDistance: 0))
        .updating($isHolding) { value, state, _ in
          if case .second(true, _) = value { state = true }
        }
    }

    /// Picking a section starts a bar at its tempo: the number rolls, the circle kicks on beat 1,
    /// and the phone taps that bar.
    private func pick(_ index: Int) {
      withAnimation(reduceMotion ? .linear(duration: 0.15) : OrbisCurve.lively.animation) {
        selected = index
      }
      feelBar(bpm: analysis.sections[index].bpm)
    }

    private func feelBar(bpm: Double) {
      withAnimation(.snappy(duration: 0.25)) { clock.restart(bpm: bpm) }
      haptics.playBar(bpm: bpm)
    }

    private var sections: some View {
      VStack(alignment: .leading, spacing: 2) {
        HStack {
          Text("Sections").font(.caption.weight(.semibold)).opacity(0.65)
          Spacer()
          Text("Tap one to feel its tempo").font(.caption).opacity(0.45)
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
        ForEach(analysis.sections.indices, id: \.self) { index in
          SectionRow(
            section: analysis.sections[index], isCurrent: index == selected, highlight: highlight
          ) {
            pick(index)
          }
          .accessibilityIdentifier("about-this-set-section-\(index)")
        }
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 6)
      .background(.white.opacity(0.08), in: .rect(cornerRadius: 20))
    }

    /// The dark sheet, tinted by the Set's artwork.
    private var surface: some View {
      ZStack {
        Color(red: 0.07, green: 0.04, blue: 0.13)
        if let artwork {
          CachedImage(url: artwork) { image in
            image.resizable().scaledToFill()
          } placeholder: {
            Color.clear
          }
          .blur(radius: 60)
          .opacity(0.45)
          .saturation(1.4)
          .allowsHitTesting(false)
        }
        LinearGradient(
          colors: [Color.orbis.tint.opacity(0.35), .clear], startPoint: .top, endPoint: .center)
      }
      .clipped()
    }
  }

  /// What the sheet reads from an analysis.
  enum AboutThisSetReading {
    /// The section that holds `time`, or the first one when `time` comes before them all.
    static func section(at time: TimeInterval, in sections: [SetAnalysis.Section]) -> Int? {
      guard !sections.isEmpty else { return nil }
      return sections.lastIndex { $0.startSeconds <= time } ?? 0
    }

    static func clock(_ seconds: TimeInterval) -> String {
      let s = Int(seconds.rounded())
      return s >= 3600
        ? String(format: "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60)
        : String(format: "%d:%02d", s / 60, s % 60)
    }

    static func length(_ section: SetAnalysis.Section) -> String {
      let m = Int(((section.endSeconds - section.startSeconds) / 60).rounded())
      return m >= 60 ? "\(m / 60) hr \(m % 60) min" : "\(m) min"
    }

    /// Loudness across the Set in 24 bars, and a word for how it sits.
    struct Energy {
      static let barCount = 24
      /// Each bar's mean short-term loudness in LUFS; nil where the Set was silent.
      let bars: [Double?]
      let lufs: Double
      let label: String

      init?(_ analysis: SetAnalysis) {
        guard let lufs = analysis.integratedLufs, !analysis.loudnessCurve.isEmpty else {
          return nil
        }
        let duration = max(analysis.durationSeconds, 1)
        var sums = [Double](repeating: 0, count: Self.barCount)
        var counts = [Int](repeating: 0, count: Self.barCount)
        for reading in analysis.loudnessCurve {
          let i = min(max(Int(reading.seconds / duration * Double(Self.barCount)), 0), Self.barCount - 1)
          sums[i] += reading.lufs
          counts[i] += 1
        }
        bars = zip(sums, counts).map { $1 == 0 ? nil : $0 / Double($1) }
        self.lufs = lufs
        label = Self.label(lufs: lufs, readings: analysis.loudnessCurve.map(\.lufs))
      }

      /// How loud, then how even: louder than -14 LUFS is loud, quieter than -20 is quiet; a
      /// spread of short-term loudness over 3 dB is varied.
      static func label(lufs: Double, readings: [Double]) -> String {
        let level = lufs > -14 ? "Loud" : lufs < -20 ? "Quiet" : "Moderate"
        let mean = readings.reduce(0, +) / Double(readings.count)
        let spread = (readings.map { ($0 - mean) * ($0 - mean) }.reduce(0, +)
          / Double(readings.count)).squareRoot()
        return "\(level), \(spread > 3 ? "varied" : "even")"
      }
    }
  }

  /// The beat count as a function of time. A tempo change starts a new bar, so the next kick is
  /// beat 1.
  struct BeatClock {
    private(set) var bpm: Double
    private var anchor = Date.now

    init(bpm: Double) {
      self.bpm = bpm
    }

    func beats(at date: Date) -> Double {
      max(date.timeIntervalSince(anchor), 0) * bpm / 60
    }

    /// Starts a new bar now, so the next kick is beat 1 at `newBPM`.
    mutating func restart(bpm newBPM: Double, at date: Date = .now) {
      anchor = date
      bpm = newBPM
    }
  }

  /// The number beats at the tempo it shows: a kick on each beat, a ring that leaves it, and the
  /// bar's four counts. Faster tempos glow brighter. Under Reduce Motion it holds still.
  private struct Metronome: View {
    let clock: BeatClock
    var diameter: CGFloat = 170
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      TimelineView(.animation(paused: reduceMotion)) { context in
        let beats = clock.beats(at: context.date)
        let phase = reduceMotion ? 0.6 : beats - beats.rounded(.down)
        let kick = reduceMotion ? 0 : exp(-phase * 7)
        let count = Int(beats.rounded(.down)) % 4
        let heat = min(max((clock.bpm - 130) / 30, 0), 1)
        VStack(spacing: 12) {
          ZStack {
            Circle().stroke(.white.opacity(0.35 * (1 - phase)), lineWidth: 2)
              .frame(width: diameter, height: diameter)
              .scaleEffect(reduceMotion ? 1 : 1 + 0.32 * phase)
            Circle().fill(Color.orbis.tint.opacity(0.3 + 0.3 * heat))
              .frame(width: diameter, height: diameter)
              .scaleEffect(1 + 0.05 * kick)
            VStack(spacing: -4) {
              Text("\(Int(clock.bpm.rounded()))")
                .font(.system(size: diameter * 0.42, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .contentTransition(reduceMotion ? .opacity : .numericText(value: clock.bpm))
              Text("BPM").font(.caption.weight(.bold)).tracking(2).opacity(0.7)
            }
            .scaleEffect(1 + 0.025 * kick)
          }
          .frame(height: diameter * 1.18)
          HStack(spacing: 10) {
            ForEach(0..<4, id: \.self) { i in
              Circle()
                .fill(.white.opacity(i == count && !reduceMotion ? 0.95 : 0.22))
                .frame(width: i == 0 ? 9 : 7, height: i == 0 ? 9 : 7)
            }
          }
        }
      }
    }
  }

  /// Loudness across the Set in bars, the played part bright.
  private struct EnergyCard: View {
    let energy: AboutThisSetReading.Energy
    /// The fraction of the Set already heard.
    let played: Double

    var body: some View {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .bottom, spacing: 3) {
          ForEach(energy.bars.indices, id: \.self) { i in
            let heard = Double(i) / Double(energy.bars.count) < played
            Capsule()
              .fill(.white.opacity(heard ? 0.95 : 0.35))
              .frame(height: Self.height(energy.bars[i]))
          }
        }
        .frame(height: 70, alignment: .bottom)
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 1) {
          Text(energy.label).font(.headline)
          Text("Energy · \(energy.lufs.formatted(.number.precision(.fractionLength(1)))) LUFS")
            .font(.caption).opacity(0.65)
        }
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.white.opacity(0.08), in: .rect(cornerRadius: 20))
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("about-this-set-energy")
    }

    /// -24 LUFS and below draws at the floor; -11 and above fills the card.
    private static func height(_ lufs: Double?) -> CGFloat {
      guard let lufs else { return 6 }
      return max(6, min((lufs + 24) / 13, 1) * 70)
    }
  }

  /// One row of the section list. The current row carries a highlight that slides between rows.
  private struct SectionRow: View {
    let section: SetAnalysis.Section
    let isCurrent: Bool
    let highlight: Namespace.ID
    let pick: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      Button(action: pick) {
        HStack(spacing: 12) {
          Text(AboutThisSetReading.clock(section.startSeconds))
            .font(.subheadline.monospacedDigit())
            .opacity(0.55)
            .lineLimit(1)
            .fixedSize()
            .frame(width: 62, alignment: .leading)
          VStack(alignment: .leading, spacing: 1) {
            Text(section.name).font(.body.weight(isCurrent ? .semibold : .regular))
            Text("\(Int(section.bpm.rounded())) BPM · \(AboutThisSetReading.length(section))")
              .font(.footnote).opacity(0.6)
          }
          Spacer()
          if isCurrent {
            Image(systemName: "waveform")
              .font(.body.weight(.semibold))
              .foregroundStyle(Color.orbis.tint)
              .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
              .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
              .accessibilityHidden(true)
          }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background {
          // Under Reduce Motion the highlight fades between rows rather than sliding.
          if isCurrent, reduceMotion {
            RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.1))
          } else if isCurrent {
            RoundedRectangle(cornerRadius: 14)
              .fill(.white.opacity(0.1))
              .matchedGeometryEffect(id: "current", in: highlight)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint("Plays one bar at its tempo")
      .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
  }
#endif
