import OrbisDesign
import OrbisKit
import SwiftUI

extension CollectionKind {
  /// The words a page and its folder use for the collection.
  @MainActor func title(in model: AppModel) -> String {
    switch self {
    case .heavyRotation: HeavyRotationView.title
    case .saved(let id): model.collection(id)?.name ?? "Collection"
    }
  }

  @MainActor func summary(in model: AppModel) -> String {
    switch self {
    case .heavyRotation: model.rotationRange.summary
    case .saved(let id): model.collection(id)?.summary ?? ""
    }
  }
}

/// The names Heavy Rotation goes by, kept on one type so every platform says the same.
enum HeavyRotationView {
  static let title = "Heavy Rotation"
}

#if !os(tvOS)
  /// A collection: Heavy Rotation or a saved Collection. The service ranks its Sets; the page
  /// shows them like a Playlist and plays them in rank order or shuffled. Listening decides what is
  /// in it, so a saved Collection edits its filter, not its Sets.
  struct CollectionView: View {
    @Bindable var model: AppModel
    let kind: CollectionKind
    /// The play a person asked for while something else was playing, held until they confirm.
    @State private var pendingShuffle: Bool?
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.setZoom) private var zoom

    /// The place the page's rows open Sets from, apart from Home's shelf showing the same Sets.
    static let place = "rotation-row"

    private var heroLayout: HeroLayout { HeroLayout(sizeClass) }
    private var state: Loadable<[SavedSet]> { model.members(of: kind) }
    private var sets: [SavedSet] {
      if case .loaded(let sets) = state { sets } else { [] }
    }
    private var saved: ListeningCollection? {
      if case .saved(let id) = kind { model.collection(id) } else { nil }
    }
    private var title: String { kind.title(in: model) }
    /// What the page reads again on: the range for Heavy Rotation, the filter for a Collection.
    private struct ReadKey: Equatable {
      let kind: CollectionKind
      let range: ListeningRange
      let saved: ListeningCollection?
    }
    private var readKey: ReadKey {
      ReadKey(kind: kind, range: model.rotationRange, saved: saved)
    }

    var body: some View {
      List {
        hero
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        // A refused delete shows where it was asked for.
        if let saved, model.collectionFailure != nil {
          FailureRows(
            failure: model.collectionFailure, context: "deleting \(saved.name)",
            identifier: "collection-error")
        }
        rows
      }
      .scrollContentBackground(.hidden)
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollEdgeEffectStyle(.soft, for: .bottom)
      .accessibilityIdentifier("rotation-members")
      .background {
        ArtworkGlow(url: sets.first.map { SetPresentation.row($0).artwork } ?? nil, reach: 0.6)
      }
      .navigationTitle(title)
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        if let saved {
          ToolbarItem {
            Menu {
              Button("Edit filter", systemImage: "slider.horizontal.3") { isEditing = true }
              Button("Delete collection", systemImage: "trash", role: .destructive) {
                isConfirmingDelete = true
              }
            } label: {
              Label("Collection actions", systemImage: "ellipsis.circle")
            }
            .accessibilityIdentifier("collection-actions")
          }
        }
      }
      // Play and Shuffle start from here, so their refusals show here.
      .setChangeStatus(model)
      .confirmationDialog(
        "Play \(title)?", isPresented: isConfirmingPlay, titleVisibility: .visible
      ) {
        Button("Replace the queue") { startPlayback() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now.")
      }
      .confirmationDialog(
        "Delete this collection?", isPresented: $isConfirmingDelete, titleVisibility: .visible
      ) {
        Button("Delete collection", role: .destructive) {
          guard case .saved(let id) = kind else { return }
          Task { await model.deleteCollection(id) }
        }
        Button("Keep it", role: .cancel) {}
      } message: {
        Text("Your Sets and your listening stay. Only this filter is removed.")
      }
      .sheet(isPresented: $isEditing) {
        CollectionEditor(model: model, editing: saved)
      }
      .task(id: readKey) {
        await model.loadMembers(of: kind)
        // So a Set's page opens with its Tracklist in place.
        await model.loadTracklists(sets)
      }
    }

    /// The collection, large: its top Sets' artwork fanned out, its name, what it holds, and the
    /// two ways to play it.
    private var hero: some View {
      let count = sets.count == 1 ? "1 set" : "\(sets.count) sets"
      let summary = kind.summary(in: model)
      let layout = heroLayout.stack(spacing: 14)
      return layout {
        SleeveFan(
          seed: title,
          artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
          category: SetPresentation.category(for: title),
          width: heroLayout.isBeside ? 220 : 200
        )
        .frame(height: heroLayout.isBeside ? 170 : 150)
        VStack(alignment: heroLayout.alignment, spacing: 14) {
          VStack(alignment: heroLayout.alignment, spacing: 5) {
            Eyebrow("Collection")
            Text(title)
              .font(heroLayout.isBeside ? Font.orbis.largeTitle : Font.orbis.title)
              .accessibilityAddTraits(.isHeader)
              .accessibilityIdentifier("collection-title")
            Text(sets.isEmpty ? summary : "\(count) · \(summary)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(heroLayout.textAlignment)
          }
          if kind == .heavyRotation {
            Picker("Range", selection: $model.rotationRange) {
              ForEach(ListeningRange.allCases) { range in
                Text(range.title).tag(range)
              }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 360)
            .accessibilityIdentifier("rotation-range")
          }
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
        UnavailableState(failure: failure, context: "loading \(title)") {
          Task { await model.loadMembers(of: kind) }
        }
        .listRowBackground(Color.clear)
        .accessibilityIdentifier("rotation-error")
      case .loaded(let sets) where sets.isEmpty:
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
      let kind = kind
      Task { await model.play(kind, shuffled: shuffled) }
    }
  }

  /// Makes or edits a Collection: a name and the filter over listening that fills it.
  struct CollectionEditor: View {
    @Bindable var model: AppModel
    /// The Collection whose filter this edits; nil makes a new one.
    let editing: ListeningCollection?
    /// What to do with a Collection once it is saved, such as open it.
    var saved: (ListeningCollection) -> Void = { _ in }
    @State private var filter: CollectionFilter
    @Environment(\.dismiss) private var dismiss

    init(
      model: AppModel, editing: ListeningCollection?,
      saved: @escaping (ListeningCollection) -> Void = { _ in }
    ) {
      _model = Bindable(model)
      self.editing = editing
      self.saved = saved
      _filter = State(initialValue: editing?.filter ?? CollectionFilter())
    }

    /// The Library's creators, and the saved one when no Set in the Library is by them now.
    private var creators: [(id: String, name: String)] {
      var creators = model.libraryCreators
      if let id = editing?.creatorId, !creators.contains(where: { $0.id == id }) {
        creators.append((id, editing?.creator ?? id))
      }
      return creators
    }

    var body: some View {
      NavigationStack {
        Form {
          Section {
            TextField("Name", text: $filter.name)
              .accessibilityIdentifier("collection-name")
          }
          Section {
            Picker("Range", selection: $filter.range) {
              ForEach(ListeningRange.allCases) { Text($0.title).tag($0) }
            }
            .accessibilityIdentifier("collection-range")
            Picker("Source", selection: $filter.source) {
              Text("Any source").tag(String?.none)
              ForEach(CollectionFilter.sources, id: \.id) { source in
                Text(source.label).tag(String?.some(source.id))
              }
            }
            .accessibilityIdentifier("collection-source")
            Picker("Creator", selection: $filter.creatorId) {
              Text("Any creator").tag(String?.none)
              ForEach(creators, id: \.id) { creator in
                Text(creator.name).tag(String?.some(creator.id))
              }
            }
            .accessibilityIdentifier("collection-creator")
            Picker("Tag", selection: $filter.tag) {
              Text("Any tag").tag(String?.none)
              ForEach(model.availableTags, id: \.self) { tag in
                Text(tag).tag(String?.some(tag))
              }
            }
            .accessibilityIdentifier("collection-tag")
            Picker("Heard", selection: $filter.minimumMinutes) {
              ForEach(CollectionFilter.minimums, id: \.self) { minutes in
                Text(CollectionFilter.minimumLabel(minutes)).tag(minutes)
              }
            }
            .accessibilityIdentifier("collection-minimum")
          } footer: {
            Text("Ranked by how long you listened, as Heavy Rotation is.")
          }
          // The sheet covers the screen's own status, so a refused save is said here.
          if model.collectionFailure != nil {
            Section {
              FailureRows(
                failure: model.collectionFailure, context: "saving a collection",
                identifier: "collection-save-error")
            }
          }
        }
        .navigationTitle(editing == nil ? "New collection" : "Edit collection")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", role: .cancel) { dismiss() }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(editing == nil ? "Create" : "Save") {
              let filter = filter
              Task {
                if let collection = await model.saveCollection(filter, id: editing?.id) {
                  dismiss()
                  saved(collection)
                }
              }
            }
            .disabled(
              model.isWorkingOnCollection
                || filter.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
            .accessibilityIdentifier("collection-save")
          }
        }
      }
      .interactiveDismissDisabled(model.isWorkingOnCollection)
      .task {
        model.collectionFailure = nil
        if case .idle = model.library { await model.loadLibrary() }
      }
    }
  }

  extension View {
    /// Pushes the collection open on `place`'s stack. The page pushes the Sets opened from it
    /// itself; pushed from the stack's root instead, Back from a Set would pop the collection too.
    func collectionPage<SetPage: View>(
      _ model: AppModel, in place: Destination, zoom: SetZoom?,
      @ViewBuilder setPage: @escaping (String) -> SetPage
    ) -> some View {
      let shown = Binding<Bool>(
        get: { model.openedCollection?.place == place },
        set: { if !$0, model.openedCollection?.place == place { model.closeCollection() } }
      )
      let openedSet = Binding<String?>(
        get: { model.openedSets[place] },
        set: { model.openedSets[place] = $0 }
      )
      return navigationDestination(isPresented: shown) {
        if let kind = model.openedCollection?.kind {
          CollectionView(model: model, kind: kind)
            .environment(\.setZoom, zoom)
            .navigationDestination(item: openedSet, destination: setPage)
        }
      }
    }
  }
#endif

/// The folder that opens a collection, among the Playlists' folders.
struct CollectionSleeve: View {
  let model: AppModel
  let kind: CollectionKind
  var fanWidth: CGFloat = 112
  var height: CGFloat = 150

  var body: some View {
    let title = kind.title(in: model)
    switch kind {
    case .heavyRotation:
      PlaylistSleeve(
        name: title,
        count: model.heavyRotation.count,
        artwork: model.heavyRotation.prefix(3).map { SetPresentation.row($0).artwork },
        category: SetPresentation.category(for: title),
        fanWidth: fanWidth, height: height
      )
    case .saved:
      let sets: [SavedSet] =
        if case .loaded(let sets) = model.members(of: kind) { sets } else { [] }
      PlaylistSleeve(
        name: title,
        count: sets.count,
        artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
        category: SetPresentation.category(for: title),
        fanWidth: fanWidth, height: height,
        detail: kind.summary(in: model)
      )
    }
  }
}
