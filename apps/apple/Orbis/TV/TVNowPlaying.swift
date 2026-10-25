#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// Now Playing for the room: the artwork, the track and the Set, the progress and the
  /// transport on the left; the Tracklist like lyrics on the right. Always dark, on the artwork's
  /// colour, the way `NowPlayingScreen` is on the phone.
  struct TVNowPlaying: View {
    @Bindable var model: AppModel
    @Binding var isShowingQueue: Bool
    @FocusState private var focus: Focus?

    /// Wide enough for the six round buttons of the transport, which the artwork then matches.
    private static let columnWidth: CGFloat = 720

    private enum Focus {
      case play
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
        ArtworkGlow(url: set.flatMap(SetPresentation.pageArtwork))
          .overlay(
            LinearGradient(colors: [.clear, .black.opacity(0.4)], startPoint: .center, endPoint: .bottom)
          )
          .ignoresSafeArea()
      }
      .environment(\.colorScheme, .dark)
      .defaultFocus($focus, .play)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-now-playing")
    }

    private func content(_ set: SavedSet) -> some View {
      let player = model.audioPlayer
      let cues = model.tracklists[set.id]?.cues.filter { $0.startSeconds != nil } ?? []
      let isPlaying = player.state == .playing || player.state == .loading
      return HStack(alignment: .top, spacing: 80) {
        VStack(alignment: .leading, spacing: 28) {
          Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
            .shadow(color: .black.opacity(0.45), radius: isPlaying ? 36 : 16, y: isPlaying ? 24 : 8)
            .scaleEffect(isPlaying ? 1 : 0.9)
            .orbisAnimation(.playbackToggled, value: isPlaying)
          TVTrackTitle(player: player, set: set)
          TVPlaybackProgress(player: player, fallbackDuration: set.durationSeconds.map(TimeInterval.init))
          transport
        }
        .frame(width: Self.columnWidth)
        .focusSection()
        if !cues.isEmpty {
          TVLyricsTracklist(model: model, set: set, cues: cues)
            .frame(maxWidth: .infinity)
            .focusSection()
        }
      }
      .padding(.top, 24)
      .task(id: set.id) {
        if set.tracklistState != .none { await model.loadTracklist(set.id) }
      }
    }

    /// Skip back, the previous track, play, the next track, and skip ahead, with Up Next apart at
    /// the trailing edge since it opens a list rather than moving the playhead.
    private var transport: some View {
      let player = model.audioPlayer
      let isPlaying = player.state == .playing || player.state == .loading
      return GlassEffectContainer {
        HStack(spacing: 24) {
          TVTransportButton(
            "Back \(Int(AudioPlayer.skipBack)) seconds", systemImage: "gobackward.\(Int(AudioPlayer.skipBack))"
          ) {
            player.skip(by: -AudioPlayer.skipBack)
          }
          .accessibilityIdentifier("now-playing-back")
          TVTransportButton("Previous track", systemImage: "backward.fill") { player.skipToPreviousCue() }
            .disabled(!player.canSkipCues)
            .accessibilityIdentifier("now-playing-previous-cue")
          TVTransportButton(
            isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill", isPrimary: true
          ) {
            model.togglePlayback()
          }
          .focused($focus, equals: .play)
          .accessibilityIdentifier("now-playing-play-toggle")
          TVTransportButton("Next track", systemImage: "forward.fill") { player.skipToNextCue() }
            .disabled(player.nextCue == nil)
            .accessibilityIdentifier("now-playing-next-cue")
          TVTransportButton(
            "Forward \(Int(AudioPlayer.skipAhead)) seconds", systemImage: "goforward.\(Int(AudioPlayer.skipAhead))"
          ) {
            player.skip(by: AudioPlayer.skipAhead)
          }
          .accessibilityIdentifier("now-playing-forward")
          Spacer(minLength: 0)
          TVTransportButton("Up Next", systemImage: "list.bullet") { isShowingQueue = true }
            .accessibilityIdentifier("now-playing-queue")
        }
      }
      .buttonStyle(.glass)
      .buttonBorderShape(.circle)
    }
  }

  /// One round transport button. Its glyph sits in a fixed square, so a wide glyph such as
  /// `forward.fill` gets the same circle as a round one; play and pause take the larger circle.
  private struct TVTransportButton: View {
    let title: String
    let systemImage: String
    let isPrimary: Bool
    let action: () -> Void

    init(_ title: String, systemImage: String, isPrimary: Bool = false, action: @escaping () -> Void) {
      self.title = title
      self.systemImage = systemImage
      self.isPrimary = isPrimary
      self.action = action
    }

    var body: some View {
      Button(action: action) {
        Image(systemName: systemImage)
          .font(isPrimary ? .headline : .body)
          .fontWeight(.semibold)
          .frame(width: isPrimary ? 64 : 44, height: isPrimary ? 64 : 44)
          .orbisSymbolReplace()
      }
      .accessibilityLabel(title)
    }
  }

  /// The title block: the track playing inside the mix leads when the Tracklist knows it, with
  /// the Set's own name under it; without one the Set leads.
  private struct TVTrackTitle: View {
    let player: AudioPlayer
    let set: SavedSet

    var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        if let cue = player.currentCue {
          Text(cue.title)
            .font(.orbis.title)
            .lineLimit(1)
            .accessibilityLabel("\(cue.title), \(cue.artist)")
            .accessibilityIdentifier("now-playing-cue")
          Text(set.title)
            .font(.title3)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .accessibilityLabel(set.title)
            .accessibilityIdentifier("now-playing-title")
        } else {
          Text(set.title)
            .font(.orbis.title)
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

  /// The bar and the clock, in their own view because the player publishes elapsed time twice a
  /// second and only this view should redraw with it.
  private struct TVPlaybackProgress: View {
    let player: AudioPlayer
    let fallbackDuration: TimeInterval?

    var body: some View {
      let duration = player.duration ?? fallbackDuration
      let length = duration ?? 0
      let fraction = length > 0 ? min(max(player.elapsed / length, 0), 1) : 0
      let ticks = player.cueStarts.filter { $0 > 0 && $0 < length }
      VStack(spacing: 10) {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.2))
            Capsule().fill(.white).frame(width: proxy.size.width * fraction)
            ForEach(Array(ticks.enumerated()), id: \.offset) { _, start in
              Rectangle()
                .fill(.black.opacity(0.5))
                .frame(width: 2)
                .offset(x: proxy.size.width * (start / length))
            }
          }
        }
        .frame(height: 8)
        .clipShape(.capsule)
        HStack {
          Text(SetPresentation.timestamp(player.elapsed))
            .accessibilityIdentifier("now-playing-elapsed")
          Spacer()
          if case .loading = player.state {
            ProgressView()
              .accessibilityLabel("Loading audio")
          }
          Spacer()
          Text(duration.map { "-\(SetPresentation.timestamp(max($0 - player.elapsed, 0)))" } ?? "--:--")
            .accessibilityIdentifier("now-playing-remaining")
        }
        .font(.orbis.detail.monospacedDigit())
        .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Position")
      .accessibilityValue(
        duration.map { "\(SetPresentation.spoken(player.elapsed)) of \(SetPresentation.spoken($0))" }
          ?? SetPresentation.spoken(player.elapsed)
      )
      .accessibilityIdentifier("now-playing-seek")
    }
  }

  /// The Tracklist the way Apple Music shows lyrics: one large line per track, the playing one
  /// bright, the ones already heard dimmed, and the list scrolled to keep the playing one in sight
  /// while nothing in it holds the focus. Pressing a line plays from it.
  private struct TVLyricsTracklist: View {
    @Bindable var model: AppModel
    let set: SavedSet
    let cues: [Cue]
    @FocusState private var focusedCue: Int?
    @State private var scrolledCue: Int?

    var body: some View {
      let player = model.audioPlayer
      let current = player.currentSetId == set.id ? player.currentCue?.position : nil
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(cues) { cue in
            let isCurrent = cue.position == current
            let isHeard = current.map { cue.position < $0 } ?? false
            Button {
              Task { await model.playCue(cue, in: set.id) }
            } label: {
              TVLyricLine(cue: cue, isCurrent: isCurrent, isHeard: isHeard)
            }
            // No system style: its focus lift would grow a focused line past the playing one,
            // so the line draws its own focus instead.
            .buttonStyle(TVLyricButtonStyle())
            .focused($focusedCue, equals: cue.position)
            .accessibilityLabel(
              "\(cue.title), \(cue.artist)"
                + (cue.startSeconds.map { ", starts at \(SetPresentation.spoken($0))" } ?? "")
            )
            .accessibilityAddTraits(isCurrent ? .isSelected : [])
            .accessibilityIdentifier("now-playing-cue-\(cue.position)")
            .id(cue.position)
          }
        }
        .scrollTargetLayout()
      }
      // The margins keep a focused line out of the faded band.
      .contentMargins(.vertical, 100, for: .scrollContent)
      .scrollEdgeEffectStyle(.soft, for: .vertical)
      .scrollClipDisabled()
      .scrollIndicators(.hidden)
      .scrollPosition(id: $scrolledCue, anchor: .center)
      .task(id: current) {
        guard let current, focusedCue == nil else { return }
        withAnimation { scrolledCue = current }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("now-playing-tracklist")
    }
  }

  /// The label as it is, with no lift, platter, or tint of the system's: the line it wraps shows
  /// the focus itself.
  private struct TVLyricButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      configuration.label
    }
  }

  /// One line of the Tracklist, the way lyrics are drawn: the playing one bright and large, the
  /// ones already heard dimmed. The line under the remote sits on glass and brightens, but never
  /// past the playing one.
  private struct TVLyricLine: View {
    let cue: Cue
    let isCurrent: Bool
    let isHeard: Bool
    @Environment(\.isFocused) private var isFocused

    var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        // tvOS has no large title style: `.largeTitle` resolves no larger than `.title`, so the
        // step is title (76 pt) over title2 (57 pt).
        Text(cue.title)
          .font(isCurrent ? .title.weight(.heavy) : .title2.weight(.heavy))
        Text(
          isCurrent
            ? "\(cue.artist) · playing"
            : "\(cue.artist) · \(cue.startSeconds.map(SetPresentation.timestamp) ?? "")"
        )
        .font(.title3.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(.secondary)
      }
      .opacity(isCurrent ? 1 : isFocused ? 0.85 : isHeard ? 0.4 : 0.65)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 24)
      .padding(.vertical, 12)
      .glassEffect(isFocused ? .regular : .identity, in: .rect(cornerRadius: Radius.row))
      .orbisAnimation(.pressed, value: isFocused)
    }
  }

  /// The Listening Queue: what plays next, in order, with the Set playing now marked. Done is
  /// there so the empty and failed states still have something to focus.
  struct TVQueue: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
      let playing = model.playingSet
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .firstTextBaseline) {
            Text("Up Next")
              .font(.orbis.largeTitle)
              .accessibilityAddTraits(.isHeader)
            Spacer()
            Button("Done") { dismiss() }
              .buttonStyle(.glass)
              .accessibilityIdentifier("queue-done")
          }
          .padding(.bottom, 24)
          content
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(url: playing.flatMap(SetPresentation.pageArtwork), reach: 0.6)
      }
      .environment(\.colorScheme, .dark)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("queue-screen")
      .task { await model.loadQueue() }
    }

    @ViewBuilder private var content: some View {
      switch model.queue {
      case .idle, .loading:
        TVPageState { TVLoading() }
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading the queue") {
          Task { await model.loadQueue() }
        }
        .accessibilityIdentifier("queue-unavailable")
      case .loaded(let queue):
        if queue.entries.isEmpty {
          TVPageState {
            ContentUnavailableView {
              Label("Nothing queued", systemImage: "list.bullet")
            } description: {
              Text("Play a set, or add one with Play Next.")
            }
          }
          .accessibilityIdentifier("queue-empty")
        } else {
          ListingLabel(queue.entries.count == 1 ? "1 set" : "\(queue.entries.count) sets")
            .padding(.bottom, 8)
          ForEach(Array(queue.entries.enumerated()), id: \.element.id) { position, set in
            entry(set, position: position + 1, isActive: queue.isActive(set.id))
          }
        }
      }
    }

    /// One queued Set. The Set playing now carries a mark as well as the tint, because a colour
    /// alone says nothing to a person who cannot see it.
    private func entry(_ set: SavedSet, position: Int, isActive: Bool) -> some View {
      Button {
        Task { await model.playSet(set.id) }
      } label: {
        HStack(spacing: 28) {
          Group {
            if isActive {
              Image(systemName: "speaker.wave.2.fill")
                .foregroundStyle(Color.orbis.tint)
            } else {
              Text(position, format: .number)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
          }
          .font(.title3)
          .frame(minWidth: 48, alignment: .trailing)
          Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .lead)
          VStack(alignment: .leading, spacing: 4) {
            Text(set.title)
              .font(.title3.weight(.semibold))
              .foregroundStyle(isActive ? Color.orbis.tint : Color.primary)
            Text(
              [set.creator, set.durationSeconds.map(SetPresentation.length)].compactMap { $0 }.joined(separator: " · ")
            )
            .font(.body)
            .foregroundStyle(.secondary)
          }
          .lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
      .buttonStyle(.card)
      .accessibilityLabel(isActive ? "\(set.title), playing" : "\(set.title), position \(position)")
      .accessibilityAddTraits(isActive ? .isSelected : [])
      .accessibilityIdentifier("queue-entry-\(set.id)")
    }
  }
#endif
