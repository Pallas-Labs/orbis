import OrbisDesign
import SwiftUI

#if !os(tvOS)
  /// Heavy Rotation as a collection: the Sets heard most over a range, ranked by the service,
  /// opened like a Playlist. The page picks the range and plays the Sets in rank order or
  /// shuffled; it has nothing to edit, because listening decides what is in it.
  struct HeavyRotationView: View {
    @Bindable var model: AppModel
    /// The play a person asked for while something else was playing, held until they confirm.
    @State private var pendingShuffle: Bool?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.setZoom) private var zoom

    /// The place the page's rows open Sets from, apart from Home's shelf showing the same Sets.
    static let place = "rotation-row"
    static let title = "Heavy Rotation"

    private var heroLayout: HeroLayout { HeroLayout(sizeClass) }
    private var range: ListeningRange { model.rotationRange }
    private var state: Loadable<[SavedSet]> { model.rotationSets[range] ?? .idle }
    private var sets: [SavedSet] {
      if case .loaded(let sets) = state { sets } else { [] }
    }

    var body: some View {
      List {
        hero
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        rows
      }
      .scrollContentBackground(.hidden)
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollEdgeEffectStyle(.soft, for: .bottom)
      .accessibilityIdentifier("rotation-members")
      .background {
        ArtworkGlow(url: sets.first.map { SetPresentation.row($0).artwork } ?? nil, reach: 0.6)
      }
      .navigationTitle(Self.title)
      .toolbarTitleDisplayMode(.inline)
      // Play and Shuffle start from here, so their refusals show here.
      .setChangeStatus(model)
      .confirmationDialog(
        "Play Heavy Rotation?", isPresented: isConfirmingPlay, titleVisibility: .visible
      ) {
        Button("Replace the queue") { startPlayback() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now.")
      }
      .task(id: range) {
        await model.loadRotation(range)
        // So a Set's page opens with its Tracklist in place.
        await model.loadTracklists(sets)
      }
    }

    /// The collection, large: its top Sets' artwork fanned out, its name, the range, and the two
    /// ways to play it.
    private var hero: some View {
      let count = sets.count == 1 ? "1 set" : "\(sets.count) sets"
      let layout = heroLayout.stack(spacing: 14)
      return layout {
        SleeveFan(
          seed: Self.title,
          artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
          category: SetPresentation.category(for: Self.title),
          width: heroLayout.isBeside ? 220 : 200
        )
        .frame(height: heroLayout.isBeside ? 170 : 150)
        VStack(alignment: heroLayout.alignment, spacing: 14) {
          VStack(alignment: heroLayout.alignment, spacing: 5) {
            Eyebrow("Collection")
            Text(Self.title)
              .font(heroLayout.isBeside ? Font.orbis.largeTitle : Font.orbis.title)
              .accessibilityAddTraits(.isHeader)
            Text(sets.isEmpty ? range.summary : "\(count) · \(range.summary)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(heroLayout.textAlignment)
          }
          Picker("Range", selection: $model.rotationRange) {
            ForEach(ListeningRange.allCases) { range in
              Text(range.title).tag(range)
            }
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 360)
          .accessibilityIdentifier("rotation-range")
          playButtons
        }
        .frame(maxWidth: heroLayout.isBeside ? CGFloat.infinity : nil, alignment: .leading)
      }
      .frame(maxWidth: .infinity, alignment: heroLayout.frameAlignment)
      .padding(.vertical, 8)
    }

    private var playButtons: some View {
      HStack(spacing: 10) {
        Button {
          play(shuffled: false)
        } label: {
          Label("Play", systemImage: "play.fill")
            .font(.headline)
            .padding(.horizontal, 10)
            // A List tints a row's symbols with the accent, which is this button's own fill.
            .foregroundStyle(.white)
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .accessibilityIdentifier("rotation-play")
        Button {
          play(shuffled: true)
        } label: {
          Label("Shuffle", systemImage: "shuffle")
            .font(.headline)
            .padding(.horizontal, 6)
        }
        .buttonStyle(.glass)
        .accessibilityIdentifier("rotation-shuffle")
      }
      .controlSize(.large)
      .disabled(sets.isEmpty)
    }

    @ViewBuilder private var rows: some View {
      switch state {
      case .idle, .loading:
        LoadingState()
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
          .accessibilityIdentifier("rotation-loading")
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading Heavy Rotation") {
          Task { await model.loadRotation(range) }
        }
        .listRowBackground(Color.clear)
        .accessibilityIdentifier("rotation-error")
      case .loaded(let sets) where sets.isEmpty:
        ContentUnavailableView {
          Label("Not enough listening yet", systemImage: "chart.bar")
        } description: {
          Text("Play three Sets for a few minutes each, and the ones you hear most show up here.")
        }
        .listRowBackground(Color.clear)
        .accessibilityIdentifier("rotation-empty")
      case .loaded(let sets):
        ForEach(sets) { set in
          let presentation = SetPresentation.row(set)
          SetRow(
            title: presentation.title,
            source: presentation.source,
            artwork: presentation.artwork,
            creator: presentation.creator,
            length: presentation.length,
            tags: presentation.tags,
            state: presentation.state,
            progress: presentation.progress,
            playback: SetPresentation.playback(
              of: set, currentSetId: model.audioPlayer.currentSetId,
              isPlaying: model.audioPlayer.state == .playing),
            togglePlayback: { model.togglePlayback(set.id) },
            select: {
              zoom?.open(from: Self.place)
              model.openSet(set.id)
            }
          )
          .zoomsSetPage(set.id, place: Self.place)
          .accessibilityIdentifier("rotation-member-\(set.id)")
        }
      }
    }

    private var isConfirmingPlay: Binding<Bool> {
      Binding(get: { pendingShuffle != nil }, set: { if !$0 { pendingShuffle = nil } })
    }

    /// Plays now, or asks first when something else is playing, since either way the queue is
    /// replaced.
    private func play(shuffled: Bool) {
      pendingShuffle = shuffled
      if !model.isPlayingNow { startPlayback() }
    }

    private func startPlayback() {
      let shuffled = pendingShuffle ?? false
      pendingShuffle = nil
      let range = range
      Task { await model.playHeavyRotation(range, shuffled: shuffled) }
    }
  }

  extension View {
    /// Pushes the Heavy Rotation collection on `place`'s stack while it is open there. The page
    /// pushes the Sets opened from it itself; pushed from the stack's root instead, Back from a
    /// Set would pop the collection too.
    func heavyRotationPage<SetPage: View>(
      _ model: AppModel, in place: Destination, zoom: SetZoom?,
      @ViewBuilder setPage: @escaping (String) -> SetPage
    ) -> some View {
      let shown = Binding<Bool>(
        get: { model.rotationPlace == place },
        set: { if !$0, model.rotationPlace == place { model.closeHeavyRotation() } }
      )
      let openedSet = Binding<String?>(
        get: { model.openedSets[place] },
        set: { model.openedSets[place] = $0 }
      )
      return navigationDestination(isPresented: shown) {
        HeavyRotationView(model: model)
          .environment(\.setZoom, zoom)
          .navigationDestination(item: openedSet, destination: setPage)
      }
    }
  }
#endif

/// The folder that opens the Heavy Rotation collection, among the Playlists' folders.
struct HeavyRotationSleeve: View {
  let model: AppModel
  var fanWidth: CGFloat = 112
  var height: CGFloat = 150

  var body: some View {
    PlaylistSleeve(
      name: "Heavy Rotation",
      count: model.heavyRotation.count,
      artwork: model.heavyRotation.prefix(3).map { SetPresentation.row($0).artwork },
      category: SetPresentation.category(for: "Heavy Rotation"),
      fanWidth: fanWidth, height: height
    )
  }
}
