#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// Heavy Rotation on the TV: the range as three buttons, the two ways to play it, then its
  /// Sets as tiles in rank order.
  struct TVHeavyRotationPage: View {
    @Bindable var model: AppModel
    /// The destination whose stack shows the page, which the Sets opened from it are pushed on.
    let place: Destination
    @FocusState private var focus: Focus?
    @State private var pendingShuffle: Bool?

    private enum Focus: Hashable {
      case play
    }

    private var range: ListeningRange { model.rotationRange }
    private var state: Loadable<[SavedSet]> { model.rotationSets[range] ?? .idle }
    private var sets: [SavedSet] {
      if case .loaded(let sets) = state { sets } else { [] }
    }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 40) {
          hero
          content
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(url: sets.first.map { SetPresentation.row($0).artwork } ?? nil, reach: 0.6)
      }
      .defaultFocus($focus, .play)
      .confirmationDialog(
        "Play Heavy Rotation?", isPresented: isConfirmingPlay, titleVisibility: .visible
      ) {
        Button("Replace the queue") { startPlayback() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now.")
      }
      .task(id: range) { await model.loadRotation(range) }
      .navigationDestination(item: openedSet(model, place)) { id in
        TVSetPage(model: model, setId: id).id(id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-rotation-page")
    }

    private var hero: some View {
      HStack(alignment: .center, spacing: 64) {
        SleeveFan(
          seed: "Heavy Rotation",
          artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
          category: SetPresentation.category(for: "Heavy Rotation"),
          width: 400
        )
        .frame(width: 600, height: 340)
        VStack(alignment: .leading, spacing: 20) {
          Eyebrow("Collection")
          Text("Heavy Rotation")
            .font(.orbis.largeTitle)
            .accessibilityAddTraits(.isHeader)
          Text(range.summary)
            .font(.title3)
            .foregroundStyle(.secondary)
          HStack(spacing: 20) {
            ForEach(ListeningRange.allCases) { option in
              Button(option.title) { model.rotationRange = option }
                .buttonStyle(.glass)
                .tint(option == range ? Color.orbis.tint : nil)
                .accessibilityAddTraits(option == range ? .isSelected : [])
                .accessibilityIdentifier("rotation-range-\(option.rawValue)")
            }
          }
          HStack(spacing: 20) {
            Button {
              play(shuffled: false)
            } label: {
              Label("Play", systemImage: "play.fill")
            }
            .buttonStyle(.glassProminent)
            .tint(Color.orbis.tint)
            .focused($focus, equals: .play)
            .accessibilityIdentifier("rotation-play")
            Button {
              play(shuffled: true)
            } label: {
              Label("Shuffle", systemImage: "shuffle")
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("rotation-shuffle")
          }
          .disabled(sets.isEmpty)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .focusSection()
    }

    @ViewBuilder private var content: some View {
      switch state {
      case .idle, .loading:
        TVPageState { TVLoading() }
          .accessibilityIdentifier("rotation-loading")
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading Heavy Rotation") {
            Task { await model.loadRotation(range) }
          }
        }
        .accessibilityIdentifier("rotation-error")
      case .loaded(let sets) where sets.isEmpty:
        TVPageState {
          ContentUnavailableView {
            Label("Not enough listening yet", systemImage: "chart.bar")
          } description: {
            Text("Play three Sets for a few minutes each, and the ones you hear most show up here.")
          }
        }
        .accessibilityIdentifier("rotation-empty")
      case .loaded(let sets):
        TVSetGrid(model: model, sets: sets, identifierPrefix: "rotation-member")
          .accessibilityIdentifier("rotation-members")
      }
    }

    private var isConfirmingPlay: Binding<Bool> {
      Binding(get: { pendingShuffle != nil }, set: { if !$0 { pendingShuffle = nil } })
    }

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
    /// Pushes the Heavy Rotation collection on `place`'s stack while it is open there.
    func tvHeavyRotationPage(_ model: AppModel, in place: Destination) -> some View {
      navigationDestination(
        isPresented: Binding(
          get: { model.rotationPlace == place },
          set: { if !$0, model.rotationPlace == place { model.closeHeavyRotation() } }
        )
      ) {
        TVHeavyRotationPage(model: model, place: place)
      }
    }
  }
#endif
