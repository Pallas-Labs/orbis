import OrbisDesign
import SwiftUI

/// Now Playing, laid out the way Apple Music lays out its own: the artwork, the title with its
/// menu, the seek bar and the transport, and a bottom row for the Tracklist, AirPlay and Up Next.
/// The Tracklist takes the artwork's place the way lyrics do, so the mix can be read and stepped
/// through without leaving the player. Always dark, on the artwork's colour. The screen follows
/// the player, and closes when it empties.
///
/// Given room on both sides, as on an iPad or an unfolded iPhone Duo, the player shares the screen
/// with a panel that shows the Tracklist or Up Next: stacked when the window stands upright, side
/// by side when it lies on its side. What the panel shows is the model's, so a fold carries it to
/// the column, where the Tracklist is in the artwork's place and Up Next is a sheet.
struct NowPlayingScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var isRenaming = false
  /// What the column showed before Up Next opened as a sheet, which closing the sheet goes back
  /// to.
  @State private var panelBeforeQueue: NowPlayingPanel?
  /// True when the window has room for the player and the panel together.
  @State private var isSplit = false
  /// True when that room lies side by side rather than stacked.
  @State private var isSideBySide = false
  /// The player column's width, which the artwork takes three quarters of in the split.
  @State private var playerWidth: CGFloat = 0
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  /// Closes the screen when something other than a sheet presents it, such as the player that
  /// grows out of the mini player. Nil dismisses the sheet.
  var close: (() -> Void)?
  /// Marks the artwork's frame, for a copy that flies in from the mini player's thumb.
  var artworkAnchor: Namespace.ID?
  /// True while that copy is in flight, so the picture shows once.
  var hidesArtwork = false
  /// False when the view that presents the screen draws `NowPlayingBackground` itself, so it can
  /// grow the background separately from the page.
  var drawsBackground = true

  private func closeScreen() {
    if let close { close() } else { dismiss() }
  }

  var body: some View {
    let player = model.audioPlayer
    let set = model.playingSet
    Group {
      if let set {
        content(set)
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("now-playing")
      } else {
        ContentUnavailableView {
          Label("Nothing playing", systemImage: "play.slash")
        } description: {
          Text("Play a set from your library.")
        }
        .accessibilityIdentifier("now-playing-empty")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      if drawsBackground { NowPlayingBackground(set: set) }
    }
    #if os(iOS)
      .onGeometryChange(for: CGSize.self) {
        $0.size
      } action: {
        resize(to: $0)
      }
    #endif
    .environment(\.colorScheme, .dark)
    .setChangeStatus(model)
    .sheet(isPresented: isShowingQueue) {
      // Dark like the player it opens over, not the light of the app behind.
      QueueScreen(model: model).preferredColorScheme(.dark)
    }
    #if os(iOS)
      // The swipe down is invisible and VoiceOver cannot make it, so the chevron where the
      // grabber sat is the way out anyone can see.
      // Side by side, the middle of the window is the fold, so the chevron tops the player.
      .overlay(alignment: isSideBySide ? .topLeading : .top) {
        closeButton(systemImage: "chevron.down").padding(.leading, isSideBySide ? 24 : 0)
      }
    #elseif os(macOS)
      // A Mac sheet has no grabber to pull down and no swipe, so Now Playing closes from a button
      // and from Escape.
      .overlay(alignment: .topLeading) { closeButton(systemImage: "xmark").padding(12) }
    #endif
    .accessibilityAction(.escape) { closeScreen() }
    .onChange(of: player.currentSetId) { _, id in
      if id == nil { closeScreen() }
    }
  }

  /// The height the close button takes at the top, which the column starts below.
  private static let closeClearance: CGFloat = 44
  /// The artwork's widest in the column: about three quarters of a phone's width. At the column's
  /// full width a 16:9 picture crowds the page.
  private static let columnArtworkWidth: CGFloat = 296
  /// The widest the player gets beside its panel, and the widest its artwork gets.
  private static let splitPlayerWidth: CGFloat = 420
  /// The shortest side a window needs for the player and the panel together.
  private static let splitMinimum: CGFloat = 600

  /// Three quarters of the player column in the split, at most 420 points.
  private var artworkWidth: CGFloat {
    isSplit ? min(Self.splitPlayerWidth, playerWidth * 0.75) : Self.columnArtworkWidth
  }

  private var isStacked: Bool { isSplit && !isSideBySide }

  /// Up Next is a sheet only in the column; in the split the panel shows it.
  private var isShowingQueue: Binding<Bool> {
    Binding(
      get: { !isSplit && model.nowPlayingPanel == .upNext },
      set: { isShown in
        guard !isShown, !isSplit, model.nowPlayingPanel == .upNext else { return }
        model.nowPlayingPanel = panelBeforeQueue
      })
  }

  /// What the panel shows: the model's choice, or else the Tracklist when the Set has one.
  private func shownPanel(cues: [Cue]) -> NowPlayingPanel {
    model.nowPlayingPanel ?? (cues.isEmpty ? .upNext : .tracklist)
  }

  /// Chooses the column or the split from the room the window gives, not from the device. A fold
  /// changes the layout at once: the window's own resize is the only motion, and the Up Next
  /// sheet closes without animation as the panel takes it.
  private func resize(to size: CGSize) {
    let split = min(size.width, size.height) >= Self.splitMinimum
    let beside = split && size.width > size.height
    guard split != isSplit || beside != isSideBySide else { return }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      isSplit = split
      isSideBySide = beside
    }
  }

  private func closeButton(systemImage: String) -> some View {
    Button("Close", systemImage: systemImage, action: closeScreen)
      .labelStyle(.iconOnly)
      .buttonStyle(.orbisIcon)
      .font(.title3)
      .keyboardShortcut(.cancelAction)
      .accessibilityIdentifier("now-playing-close")
  }

  /// On a Mac the window is wide enough for the Tracklist to sit beside the player for the whole
  /// Set, where a phone swaps it in for the artwork.
  @ViewBuilder private func content(_ set: SavedSet) -> some View {
    let cues = model.tracklists[set.id]?.cues.filter { $0.startSeconds != nil } ?? []
    #if os(macOS)
      HStack(alignment: .top, spacing: 56) {
        playerColumn(set, cues: cues, showsTracklistInPlace: false)
          .frame(maxWidth: 560)
        if !cues.isEmpty {
          LyricsTracklist(model: model, set: set, cues: cues)
            .frame(maxWidth: .infinity)
            .padding(.top, 36)
        }
      }
      .padding(.horizontal, 32)
      .padding(.top, 24)
    #else
      let layout =
        isSideBySide
        ? AnyLayout(HStackLayout(alignment: .top, spacing: 8))
        : AnyLayout(VStackLayout(spacing: 16))
      // One tree in every pose: the layout changes around the player, so a fold keeps it.
      let page = VStack(spacing: 0) {
        layout {
          playerColumn(
            set, cues: cues,
            showsTracklistInPlace: !isSplit && model.nowPlayingPanel == .tracklist,
            includesBottomRow: !isStacked
          )
          .frame(maxWidth: isSideBySide ? Self.splitPlayerWidth + 48 : .infinity)
          .fixedSize(horizontal: false, vertical: isStacked)
          if isSplit {
            panel(set, cues: cues)
              .padding(.horizontal, isSideBySide ? 0 : 24)
              .padding(.trailing, isSideBySide ? 24 : 0)
              .padding(.top, isSideBySide ? Self.closeClearance : 0)
              .padding(.bottom, 12)
          }
        }
        if isStacked {
          bottomRow(cues: cues)
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
      }
      // At the largest text sizes the column is taller than the screen, so it scrolls rather
      // than push the bottom row off.
      if dynamicTypeSize.isAccessibilitySize, !isSplit {
        ScrollView { page }
      } else {
        page
      }
    #endif
  }

  /// The panel beside or under the player in the split: the Tracklist or Up Next, chosen from
  /// its segments or from the bottom row's buttons.
  private func panel(_ set: SavedSet, cues: [Cue]) -> some View {
    let shown = shownPanel(cues: cues)
    return VStack(spacing: 8) {
      Picker(
        "Show",
        selection: Binding(get: { shown }, set: { model.nowPlayingPanel = $0 })
      ) {
        ForEach(NowPlayingPanel.allCases) { panel in
          Text(panel.rawValue).tag(panel)
        }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("now-playing-panel-picker")
      switch shown {
      case .tracklist:
        if cues.isEmpty {
          ContentUnavailableView {
            Label("No Tracklist", systemImage: "quote.bubble")
          } description: {
            Text("This set has no Tracklist yet.")
          }
          .frame(maxHeight: .infinity)
        } else {
          LyricsTracklist(model: model, set: set, cues: cues)
        }
      case .upNext:
        QueueList(model: model, background: .clear)
          .accessibilityIdentifier("now-playing-up-next")
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(.white.opacity(0.08), in: .rect(cornerRadius: 24))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("now-playing-panel")
  }

  private func playerColumn(
    _ set: SavedSet, cues: [Cue], showsTracklistInPlace: Bool, includesBottomRow: Bool = true
  ) -> some View {
    let player = model.audioPlayer
    let isPlaying = player.state == .playing || player.state == .loading
    return VStack(spacing: 0) {
      if showsTracklistInPlace, !cues.isEmpty {
        Button {
          model.nowPlayingPanel = nil
        } label: {
          HStack(spacing: 12) {
            Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .row)
              .frame(width: 70)
            VStack(alignment: .leading, spacing: 1) {
              Text(set.title)
                .font(.headline)
                .lineLimit(1)
              Text(cues.count == 1 ? "1 track · tap one to jump" : "\(cues.count) tracks · tap one to jump")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows the artwork again")
        .padding(.top, Self.closeClearance)
        LyricsTracklist(model: model, set: set, cues: cues)
      } else {
        Spacer(minLength: Self.closeClearance)
        // The artwork sits back while the Set is paused and steps forward when it plays, the way
        // Apple Music's does: the state of the player, read from across the room.
        Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
          .frame(maxWidth: artworkWidth)
          .nowPlayingArtworkAnchor(artworkAnchor)
          .opacity(hidesArtwork ? 0 : 1)
          // One radius: a blur that changes size is redrawn every frame of the step.
          .shadow(color: .black.opacity(0.45), radius: 20, y: 12)
          .scaleEffect(isPlaying ? 1 : 0.86)
          .orbisAnimation(.playbackToggled, value: isPlaying)
        Spacer(minLength: 28)
        HStack(alignment: .center, spacing: 12) {
          TrackTitle(player: player, set: set)
            .frame(maxWidth: .infinity, alignment: .leading)
          SetManagementSection(model: model, set: set, isRenaming: $isRenaming, style: .inline)
        }
      }
      Transport(
        player: player,
        fallbackDuration: set.durationSeconds.map(TimeInterval.init),
        identifierPrefix: "now-playing",
        prominentPlay: false,
        showsCueSkips: true,
        cueStarts: player.cueStarts
      )
      .padding(.top, 20)
      if !showsTracklistInPlace {
        NextCueBar(player: player) { model.nowPlayingPanel = .tracklist }
          .padding(.top, 16)
      }
      if includesBottomRow {
        Spacer(minLength: 20)
        bottomRow(cues: cues)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, includesBottomRow ? 12 : 0)
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width - 48
    } action: {
      playerWidth = $0
    }
    .orbisAnimation(.cueChanged, value: model.nowPlayingPanel)
    .task(id: model.tracklistRead(set.id)) {
      if set.tracklistState != .none { await model.loadTracklist(set.id) }
    }
  }

  /// The Tracklist, AirPlay and Up Next. In the column, the Tracklist takes the artwork's place
  /// and Up Next opens a sheet; in the split, each chooses the panel's segment.
  private func bottomRow(cues: [Cue]) -> some View {
    let shown = shownPanel(cues: cues)
    let showsTracklist = isSplit ? shown == .tracklist : model.nowPlayingPanel == .tracklist
    return HStack {
      #if os(iOS)
        Button("Tracklist", systemImage: showsTracklist ? "quote.bubble.fill" : "quote.bubble") {
          if isSplit {
            model.nowPlayingPanel = .tracklist
          } else {
            model.nowPlayingPanel = showsTracklist ? nil : .tracklist
          }
        }
        .disabled(cues.isEmpty)
        .accessibilityIdentifier("now-playing-tracklist")
        Spacer()
      #endif
      AirPlayButton()
      Spacer()
      Button("Up Next", systemImage: "list.bullet") {
        if !isSplit { panelBeforeQueue = model.nowPlayingPanel }
        model.nowPlayingPanel = .upNext
      }
      .accessibilityAddTraits(isSplit && shown == .upNext ? .isSelected : [])
      .accessibilityIdentifier("now-playing-queue")
    }
    .labelStyle(.iconOnly)
    .buttonStyle(.orbisIcon)
    .font(.title3)
    .padding(.horizontal, 12)
  }
}

extension View {
  @ViewBuilder fileprivate func nowPlayingArtworkAnchor(_ namespace: Namespace.ID?) -> some View {
    if let namespace {
      matchedGeometryEffect(id: MiniPlayer.transitionID, in: namespace)
    } else {
      self
    }
  }
}

/// Now Playing's backdrop: the artwork's glow, darkened toward the controls.
struct NowPlayingBackground: View {
  let set: SavedSet?

  var body: some View {
    ArtworkGlow(url: set.flatMap(SetPresentation.pageArtwork))
      .overlay(LinearGradient(colors: [.clear, .black.opacity(0.4)], startPoint: .center, endPoint: .bottom))
      .environment(\.colorScheme, .dark)
      .ignoresSafeArea()
  }
}

/// The title block. The track playing inside the mix leads when the Tracklist knows it, with the
/// Set's own name under it; without one the Set leads. Its own view because the Cue follows the
/// clock, and the rest of Now Playing should not redraw twice a second with it.
private struct TrackTitle: View {
  let player: AudioPlayer
  let set: SavedSet

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let cue = player.currentCue {
        Text(cue.title)
          .font(.title3.weight(.bold))
          .lineLimit(1)
          .accessibilityLabel("\(cue.title) · \(cue.artist)")
          .accessibilityIdentifier("now-playing-cue")
        Text(set.title)
          .font(.title3)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .accessibilityLabel(set.title)
          .accessibilityIdentifier("now-playing-title")
      } else {
        Text(set.title)
          .font(.title3.weight(.bold))
          .lineLimit(2)
          .accessibilityIdentifier("now-playing-title")
        Text(set.creator ?? set.source.label)
          .font(.title3)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .orbisAnimation(.cueChanged, value: player.currentCue?.position)
  }
}

/// The track the mix moves into next and how long until it does. Tapping it opens the Tracklist.
private struct NextCueBar: View {
  let player: AudioPlayer
  let open: () -> Void

  var body: some View {
    if let next = player.nextCue, let start = next.startSeconds {
      Button(action: open) {
        HStack(spacing: 12) {
          Text("Next in \(SetPresentation.timestamp(max(start - player.elapsed, 0)))")
            .font(.footnote.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.secondary)
          Text("\(next.artist) — \(next.title)")
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.bold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .background(.white.opacity(0.12), in: .rect(cornerRadius: Radius.field))
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("now-playing-next-cue-bar")
    }
  }
}

/// The Tracklist the way Apple Music shows lyrics: one large line per track, the playing one bright,
/// the ones already heard dimmed, and the view scrolled to keep the playing one in sight. Tapping a
/// line plays from it.
private struct LyricsTracklist: View {
  @Bindable var model: AppModel
  let set: SavedSet
  let cues: [Cue]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let player = model.audioPlayer
    let current = player.currentSetId == set.id ? player.currentCue?.position : nil
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          ForEach(cues) { cue in
            let isCurrent = cue.position == current
            let isHeard = current.map { cue.position < $0 } ?? false
            Button {
              Task { await model.playCue(cue, in: set.id) }
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(cue.title)
                  .font(isCurrent ? .largeTitle.weight(.heavy) : .title.weight(.heavy))
                Text(
                  isCurrent
                    ? "\(cue.artist) · playing"
                    : "\(cue.artist) · \(cue.startSeconds.map(SetPresentation.timestamp) ?? "")"
                )
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
              }
              .opacity(isCurrent ? 1 : isHeard ? 0.4 : 0.65)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isCurrent ? .isSelected : [])
            .accessibilityIdentifier("now-playing-cue-\(cue.position)")
            .id(cue.position)
          }
        }
        .padding(.vertical, 24)
      }
      .scrollIndicators(.hidden)
      .mask {
        LinearGradient(
          stops: [
            .init(color: .clear, location: 0), .init(color: .black, location: 0.08),
            .init(color: .black, location: 0.88), .init(color: .clear, location: 1),
          ],
          startPoint: .top, endPoint: .bottom
        )
      }
      .onAppear { if let current { proxy.scrollTo(current, anchor: .center) } }
      .onChange(of: current) { _, position in
        guard let position else { return }
        if reduceMotion {
          proxy.scrollTo(position, anchor: .center)
        } else {
          withAnimation(.smooth) { proxy.scrollTo(position, anchor: .center) }
        }
      }
    }
  }
}
