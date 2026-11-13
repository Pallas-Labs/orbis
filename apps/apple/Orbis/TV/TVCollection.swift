import OrbisKit
#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// A collection on the TV: for Heavy Rotation, the range as three buttons; then the two ways to
  /// play it, and its Sets as tiles in rank order. A saved Collection's filter is edited on a
  /// phone, iPad or Mac; the TV shows and plays it.
  struct TVCollectionPage: View {
    @Bindable var model: AppModel
    let kind: CollectionKind
    /// The destination whose stack shows the page, which the Sets opened from it are pushed on.
    let place: Destination
    @FocusState private var focus: Focus?
    @State private var pendingShuffle: Bool?

    private enum Focus: Hashable {
      case play
    }

    private var range: ListeningRange { model.rotationRange }
    private var state: Loadable<[SavedSet]> { model.members(of: kind) }
    private var title: String { kind.title(in: model) }
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
        "Play \(title)?", isPresented: isConfirmingPlay, titleVisibility: .visible
      ) {
        Button("Replace the queue") { startPlayback() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now.")
      }
      .task(id: kind == .heavyRotation ? "\(range)" : "\(kind)") {
        await model.loadMembers(of: kind)
      }
      .navigationDestination(item: openedSet(model, place)) { id in
        TVSetPage(model: model, setId: id).id(id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-rotation-page")
    }

    private var hero: some View {
      HStack(alignment: .center, spacing: 64) {
        SleeveFan(
          seed: title,
          artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
          category: SetPresentation.category(for: title),
          width: 400
        )
        .frame(width: 600, height: 340)
        VStack(alignment: .leading, spacing: 20) {
          Eyebrow("Collection")
          Text(title)
            .font(.orbis.largeTitle)
            .accessibilityAddTraits(.isHeader)
          Text(kind.summary(in: model))
            .font(.title3)
            .foregroundStyle(.secondary)
          if kind == .heavyRotation {
            HStack(spacing: 20) {
              ForEach(ListeningRange.allCases) { option in
                Button(option.title) { model.rotationRange = option }
                  .buttonStyle(.glass)
                  .tint(option == range ? Color.orbis.tint : nil)
                  .accessibilityAddTraits(option == range ? .isSelected : [])
                  .accessibilityIdentifier("rotation-range-\(option.rawValue)")
              }
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
          UnavailableState(failure: failure, context: "loading \(title)") {
            Task { await model.loadMembers(of: kind) }
          }
        }
        .accessibilityIdentifier("rotation-error")
      case .loaded(let sets) where sets.isEmpty:
        TVPageState {
          ContentUnavailableView {
            Label(
              kind == .heavyRotation ? "Not enough listening yet" : "Nothing fits yet",
              systemImage: "chart.bar")
          } description: {
            Text(
              kind == .heavyRotation
                ? "Play three Sets for a few minutes each, and the ones you hear most show up here."
                : "Sets you hear that fit this filter show up here.")
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
      let kind = kind
      Task { await model.play(kind, shuffled: shuffled) }
    }
  }

  extension View {
    /// Pushes the open collection on `place`'s stack while it is open there.
    func tvCollectionPage(_ model: AppModel, in place: Destination) -> some View {
      navigationDestination(
        isPresented: Binding(
          get: { model.openedCollection?.place == place },
          set: { if !$0, model.openedCollection?.place == place { model.closeCollection() } }
        )
      ) {
        if let kind = model.openedCollection?.kind {
          TVCollectionPage(model: model, kind: kind, place: place)
        }
      }
    }
  }
#endif
