import OrbisDesign
import OrbisKit
import SwiftUI

#if os(iOS)
  /// iPhone and iPad, at every width. One tab view in the adaptable style: tabs along the bottom
  /// where the window is narrow, and a sidebar with the Playlists under the destinations where it
  /// is wide, such as an iPad or an unfolded iPhone Duo. The tree is the same at every width, so a
  /// fold or a resize keeps each tab's stack, the open player and every scroll position.
  ///
  /// Search is a tab like the others, as in Apple Music. The search role would split it off into
  /// a circle that turns into a field, and the field belongs at the top of Search. Now playing
  /// rides the tab view as its bottom accessory, the way a music app carries it, and the bar
  /// recedes as the list scrolls.
  struct TabShell: View {
    @Bindable var model: AppModel

    private enum Selection: Hashable {
      case destination(Destination)
      case playlist(String)
    }

    /// A tap on the tab already open takes it back to its first page, and on Search asks for the
    /// field too, as a second tap does in Apple Music. A Playlist in the sidebar opens on the
    /// Playlists tab, so the selection always reads as a destination and the Playlists tab keeps
    /// one stack.
    private var tabSelection: Binding<Selection> {
      Binding(
        get: { .destination(model.destination) },
        set: { next in
          switch next {
          case .destination(let destination):
            if destination == model.destination {
              model.returnToRoot()
              if destination == .search { model.searchFocusRequests += 1 }
            }
            model.destination = destination
          case .playlist(let id):
            model.showPlaylist(id)
          }
        })
    }
    /// Where the mini player sits in the window, which Now Playing grows out of.
    @State private var miniPlayerFrame: CGRect = .zero
    /// The mini player, following `showsMiniPlayer` once a page has finished zooming in or out:
    /// the bar leaving or arriving mid-zoom moves the tab bar under the page as it lands.
    @State private var showsAccessory = false
    @State private var pageMoved: ContinuousClock.Instant?
    /// True when the window is wide and lies on its side, where a grid of cards takes an even
    /// count of columns so the middle gap, not a card, meets the fold.
    @State private var prefersEvenColumns = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// About as long as the zoom into a Set's page.
    private static let pageZoom: Duration = .milliseconds(450)

    var body: some View {
      TabView(selection: tabSelection) {
        ForEach([Destination.home, .library, .playlists, .people, .search]) { destination in
          Tab(
            destination.rawValue, systemImage: destination.symbol,
            value: Selection.destination(destination)
          ) {
            NavigationStack {
              DestinationView(model: model, destination: destination)
            }
          }
        }
        // The sidebar lists every Playlist, so a person moves between them without going back
        // to the grid. The tab bar has no room for them: on an iPhone each Playlist took a place
        // in the bar and pushed Search under More (PAL-2443). `defaultVisibility` works only
        // where the bar can be customized, and `tabPlacement(.sidebarOnly)` still left them in
        // the compact bar, so the section is hidden where the bar replaces the sidebar.
        TabSection("Playlists") {
          ForEach(model.playlistItems) { playlist in
            Tab(
              playlist.name, systemImage: "rectangle.stack",
              value: Selection.playlist(playlist.id)
            ) {
              // Never shown: choosing a Playlist selects the Playlists tab, which opens it.
              Color.clear
            }
          }
        }
        .defaultVisibility(.hidden, for: .tabBar)
        .hidden(sizeClass == .compact)
      }
      .tabViewStyle(.sidebarAdaptable)
      .sidebarWhereThereIsRoom()
      .tabBarMinimizeBehavior(.onScrollDown)
      // `isEnabled` is why the target is iOS 26.1: 26.0 reserves an empty pill for an empty
      // accessory, and the only way round it there is to rebuild the tab view.
      .tabViewBottomAccessory(isEnabled: showsAccessory) {
        NowPlayingBar(model: model) { model.isNowPlayingOpen = true }
          .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
          } action: {
            miniPlayerFrame = $0
          }
      }
      // VoiceOver reads only the player while it is open; the bar and tabs sit outside it.
      .accessibilityHidden(model.isNowPlayingOpen)
      .nowPlayingExpansion(
        model: model, isPresented: $model.isNowPlayingOpen, from: miniPlayerFrame
      )
      .onGeometryChange(for: Bool.self) { proxy in
        proxy.size.width > proxy.size.height
      } action: { isLandscape in
        prefersEvenColumns = isLandscape && sizeClass == .regular
      }
      .onChange(of: sizeClass) { _, sizeClass in
        if sizeClass != .regular { prefersEvenColumns = false }
      }
      .environment(\.prefersEvenColumns, prefersEvenColumns)
      .onChange(of: model.openedSetId) { pageMoved = .now }
      .task(id: model.showsMiniPlayer) {
        // Only a page in motion is worth waiting for; a Set starting or ending changes the bar
        // at once.
        if let pageMoved {
          try? await Task.sleep(until: pageMoved + Self.pageZoom)
          guard !Task.isCancelled else { return }
        }
        showsAccessory = model.showsMiniPlayer
      }
      // The player goes with the last Set, so the next one played starts folded in the bar.
      .onChange(of: model.audioPlayer.currentSetId == nil) { _, isEmpty in
        if isEmpty {
          model.isNowPlayingOpen = false
          model.nowPlayingPanel = nil
        }
      }
    }
  }

  extension View {
    /// An iPhone wide enough for a sidebar, such as an unfolded iPhone Duo, opens on it. The
    /// placement is iOS 27; iPadOS adapts by itself and ignores it.
    @ViewBuilder fileprivate func sidebarWhereThereIsRoom() -> some View {
      if #available(iOS 27, *) {
        defaultTabBarPlacement(.sidebar)
      } else {
        self
      }
    }
  }
#endif

extension EnvironmentValues {
  /// Asks a grid of cards for an even count of columns, so that on an unfolded iPhone Duo on its
  /// side no card straddles the fold.
  @Entry var prefersEvenColumns = false
}

/// A grid of cards at least 160 points wide, as many as fit, or one fewer when the shell asks for
/// an even count.
struct CardGrid<Content: View>: View {
  let spacing: CGFloat
  @ViewBuilder let content: Content
  @Environment(\.prefersEvenColumns) private var prefersEvenColumns
  @State private var width: CGFloat = 0

  private static var minimum: CGFloat { 160 }
  private static var gutter: CGFloat { 14 }

  /// The columns for a grid this wide: the adaptive column a phone has always had, or a fixed
  /// even count.
  static func columns(width: CGFloat, prefersEven: Bool) -> [GridItem] {
    let fits = Int((width + gutter) / (minimum + gutter))
    guard prefersEven, fits >= 2 else {
      return [GridItem(.adaptive(minimum: minimum), spacing: gutter)]
    }
    let count = fits.isMultiple(of: 2) ? fits : fits - 1
    return Array(repeating: GridItem(.flexible(), spacing: gutter), count: count)
  }

  var body: some View {
    LazyVGrid(
      columns: Self.columns(width: width, prefersEven: prefersEvenColumns), spacing: spacing
    ) {
      content
    }
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width
    } action: {
      width = $0
    }
  }
}

#if os(macOS)
  /// The Mac. The destinations are sidebar items, and the Playlists follow them.
  struct SidebarShell: View {
    @Bindable var model: AppModel

    private enum Selection: Hashable {
      case destination(Destination)
      case playlist(String)
    }

    private var selection: Binding<Selection?> {
      Binding(
        get: {
          if model.destination == .playlists, let id = model.openedPlaylistId {
            return .playlist(id)
          }
          return .destination(model.destination)
        },
        set: { selected in
          guard let selected else { return }
          switch selected {
          case .destination(let destination):
            // Choosing Search again asks for its field, as a second tap on the tab does.
            if destination == .search { model.searchFocusRequests += 1 }
            // Playlists in the sidebar is the grid of folders, not the last one opened.
            if destination == .playlists { model.closePlaylist() }
            model.destination = destination
          case .playlist(let id):
            model.showPlaylist(id)
          }
        }
      )
    }

    /// A heading over nothing reads as a list that failed to load, so the section waits for a
    /// Playlist, or for the failure it has to explain.
    private var showsPlaylistsSection: Bool {
      if case .failed = model.playlists { return true }
      return !model.playlistItems.isEmpty
    }
    @Namespace private var nowPlaying

    var body: some View {
      NavigationSplitView(columnVisibility: .constant(.all)) {
        List(selection: selection) {
          Label("Search", systemImage: "magnifyingglass")
            .tag(Selection.destination(.search))
            .accessibilityIdentifier("sidebar-search")
          ForEach(Destination.shellCases) { destination in
            Label(destination.rawValue, systemImage: destination.symbol)
              .tag(Selection.destination(destination))
              .accessibilityIdentifier("sidebar-\(destination.rawValue.lowercased())")
          }
          if showsPlaylistsSection {
            Section("Playlists") {
              ForEach(model.playlistItems) { playlist in
                PlaylistRow(
                  playlist.name,
                  count: playlist.setCount,
                  category: SetPresentation.category(for: playlist.name)
                )
                .tag(Selection.playlist(playlist.id))
                .accessibilityIdentifier("playlist-\(playlist.name)")
              }
              if case .failed(let failure) = model.playlists {
                playlistsErrorRow(failure)
              }
            }
          }
        }
        .listStyle(.sidebar)
        .environment(\.defaultMinListRowHeight, 32)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 340)
        .navigationTitle("")
        .safeAreaBar(edge: .bottom) {
          SettingsLink { Label("Settings", systemImage: "gearshape") }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .accessibilityIdentifier("sidebar-settings")
        }
        .accessibilityIdentifier("sidebar")
      } detail: {
        // One stack serves every destination here. A new identity per destination keeps a page
        // pushed in one, and the page's own state, out of the next.
        NavigationStack {
          DestinationView(model: model, destination: model.destination)
        }
        .id(model.destination)
        .safeAreaBar(edge: .bottom) {
          if model.showsMiniPlayer {
            NowPlayingBar(model: model, surface: .floating, transition: nowPlaying) {
              model.isNowPlayingOpen = true
            }
            .frame(maxWidth: 560)
            .padding()
          }
        }
      }
      // A Mac sheet, as large as the window allows: the player and its Tracklist sit side by
      // side.
      .sheet(isPresented: $model.isNowPlayingOpen) {
        NowPlayingScreen(model: model)
          .frame(minWidth: 900, idealWidth: 1100, minHeight: 640, idealHeight: 760)
      }
      .toolbar(removing: .sidebarToggle)
      .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
    }

    /// A playlist section that failed to load must say so, because an empty section reads
    /// as "no playlists" and invites relaunching the app instead of trying again here.
    private func playlistsErrorRow(_ failure: OrbisFailure) -> some View {
      VStack(alignment: .leading, spacing: 4) {
        Text(failure.message)
          .font(.orbis.caption)
          .foregroundStyle(.secondary)
        Button("Try again") { Task { await model.loadPlaylists() } }
          .buttonStyle(.plain)
          .foregroundStyle(Color.orbis.tint)
          .accessibilityIdentifier("playlists-retry")
      }
      .accessibilityIdentifier("playlists-error")
    }
  }
#endif

struct DestinationView: View {
  @Bindable var model: AppModel
  let destination: Destination
  /// Replacing the queue is worth a question only while something is playing.
  @State private var isConfirmingPlaylist = false
  /// The empty Library's action asks the paste field to take focus.
  @State private var focusLink = false
  /// Filing happens in a sheet from the toolbar's +, and the naming step follows in the same
  /// sheet, so the Library itself is the collection and nothing else.
  @State private var isFilingSheetShown = false

  @State private var libraryQuery = ""
  /// The Set whose Tags are open for editing from its row's menu.
  @State private var taggingSet: SavedSet?
  /// The Sets picked in the Library's selection mode, or nil when it is not selecting.
  @State private var selectedIds: Set<String>?
  @State private var isBulkTagging = false
  /// A Set's page zooms out of the artwork that opened it.
  @Namespace private var setZoomNamespace
  @State private var setZoomOrigin: String?

  #if os(macOS)
    private var matchingLibrary: Loadable<[SavedSet]> {
      guard case .loaded(let sets) = model.visibleSets,
        !libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return model.visibleSets }
      return .loaded(
        sets.filter { set in
          set.title.localizedCaseInsensitiveContains(libraryQuery)
            || (set.creator?.localizedCaseInsensitiveContains(libraryQuery) ?? false)
            || set.tags.contains { $0.localizedCaseInsensitiveContains(libraryQuery) }
        })
    }
  #endif

  private var setZoom: SetZoom { SetZoom(namespace: setZoomNamespace, origin: $setZoomOrigin) }

  var body: some View {
    page
      // Every root plays, queues, or changes Sets from its rows and menus, so a refusal shows
      // where the tap was rather than nowhere.
      .setChangeStatus(model)
      .environment(\.setZoom, setZoom)
  }

  @ViewBuilder private var page: some View {
    switch destination {
    case .home:
      home
    case .library:
      SetList(
        state: librarySets,
        heading: libraryHeading,
        empty: AnyView(
          EmptyLibraryState(recover: { openFilingSheet() })
            .accessibilityIdentifier("library-empty")
        ),
        failureContext: "loading the library",
        hiddenTags: model.activeTags,
        filters: clearFilters,
        // Only a filter can hide every Set. Without one, an empty list is an empty collection
        // and keeps the empty collection's copy.
        noMatches: librarySearchIsActive
          ? AnyView(
            NoResultsState(recoverLabel: "Clear search", recover: { libraryQuery = "" })
              .accessibilityIdentifier("library-no-matches")
          )
          : !model.isFilteringLibrary
            ? nil
            : AnyView(
              NoResultsState(recoverLabel: "Clear filters", recover: { model.clearLibraryFilters() })
                .accessibilityIdentifier("library-no-matches")
            ),
        hero: MacPageTitle.slot("Library"),
        rails: (model.availableTags.isEmpty && model.activeCreator == nil) || librarySearchIsActive
          ? nil : tagTiles,
        footer: librarySearchIsActive ? "\(libraryMatchCount) sets" : libraryFooter,
        retry: { await model.loadLibrary() },
        select: { set in model.openSet(set.id) },
        currentSetId: model.audioPlayer.currentSetId,
        isPlaying: model.audioPlayer.state == .playing,
        togglePlayback: { set in model.togglePlayback(set.id) },
        groupsByDay: model.librarySort == .newest,
        menuTags: model.availableTags,
        toggleTag: { set, tag in
          Task { await model.setTag(tag, on: [set.id], to: !set.tags.contains(tag)) }
        },
        editTags: { taggingSet = $0 },
        selection: selectedIds,
        toggleSelection: { set in
          selectedIds = selectedIds.map { $0.symmetricDifference([set.id]) }
        },
        backdrop: .artwork(libraryLead.flatMap(SetPresentation.pageArtwork))
      )
      .refreshable { await model.refreshLibraryQuietly() }
      // The first screenful's Tracklists, so a Set opened from here lands with its Tracklist
      // rather than pushing its facts down mid-zoom.
      .task(id: libraryPrefetch.map(\.id)) { await model.loadTracklists(libraryPrefetch) }
      .macPageSearch(text: $libraryQuery, prompt: "Find in Library")
      .macSearchToolbarBackground(isSearching: librarySearchIsActive)
      .sidebarPageTitle("Library")
      // Pinned rather than left to the default, so the large title stays large whatever the
      // tab's content state is; the Set page pins its inline counterpart the same way. A Mac
      // has no large title to pin.
      .largeTitleOnIOS()
      .toolbar { libraryToolbar }
      .sheet(isPresented: $isFilingSheetShown) { filingSheet }
      .onChange(of: model.reveal != nil) { _, hasReveal in
        if hasReveal, model.destination == destination { isFilingSheetShown = true }
      }
      .onChange(of: model.playlistImport.isImporting) { _, importing in
        if importing, model.destination == destination { isFilingSheetShown = true }
      }
      .safeAreaBar(edge: .bottom) {
        if let selectedIds { selectionBar(count: selectedIds.count) }
      }
      .sheet(isPresented: $isBulkTagging) {
        BulkTagSheet(model: model, ids: Array(selectedIds ?? []))
      }
      .sheet(item: $taggingSet) { set in
        TagSheet(tags: set.tags, suggestions: model.availableTags) { tags in
          Task { await model.replaceTags(set.id, with: tags) }
        }
      }
      .confirmationDialog(
        "Play this playlist?", isPresented: $isConfirmingPlaylist, titleVisibility: .visible
      ) {
        Button("Replace the queue") { playSelectedPlaylist() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now and starts the first set in the playlist.")
      }
      .navigationDestination(item: openedSet) { id in setPage(id) }
    case .playlists:
      PlaylistsDestination(model: model)
        #if os(iOS)
          .playlistPage(model, in: .playlists, zoom: setZoom) { id in setPage(id) }
        #endif
        .collectionPage(model, in: .playlists, zoom: setZoom) { id in setPage(id) }
        .navigationDestination(item: openedSet) { id in setPage(id) }
    case .people:
      PeopleDestination(model: model)
    case .search:
      SearchDestination(model: model)
        // The one open Set is shared with the Library, so a Set found here opens the same page.
        .navigationDestination(item: openedSet) { id in setPage(id) }
    }
  }

  /// The large title already says Library, so the list carries no heading of its own; the
  /// active filter is underlined in the ledger row instead.
  private var libraryHeading: Text? { nil }

  private var libraryPrefetch: [SavedSet] {
    guard case .loaded(let sets) = librarySets else { return [] }
    return Array(sets.prefix(12))
  }

  private var librarySets: Loadable<[SavedSet]> {
    #if os(macOS)
      let sets = matchingLibrary
    #else
      let sets = model.visibleSets
    #endif
    guard case .loaded(let loaded) = sets else { return sets }
    return .loaded(model.librarySort.ordered(loaded))
  }

  /// The Set at the top of the Library as it is ordered and filtered now, which the page takes
  /// its light from, so filtering by a Tag recolours the page.
  private var libraryLead: SavedSet? {
    guard case .loaded(let sets) = librarySets else { return nil }
    return sets.first
  }

  private var librarySearchIsActive: Bool {
    #if os(macOS)
      !libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    #else
      false
    #endif
  }

  private var libraryMatchCount: Int {
    guard case .loaded(let sets) = librarySets else { return 0 }
    return sets.count
  }

  /// Home: what is new and where to go, in rails, with a waiting link above them. The full
  /// collection is the Library tab.
  private var home: some View {
    let rails = HomeRails(model: model)
    return ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        MacPageTitle.slot("Home")
        if case .loaded = model.library {
          rails
        }
      }
      .padding(.horizontal)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .background {
      ArtworkGlow(url: rails.lead.flatMap(SetPresentation.pageArtwork), reach: 0.75)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
    .refreshable {
      await model.refreshLibraryQuietly()
      await model.refreshPlaylistsQuietly()
    }
    .overlay {
      // The rails are built from the library, so until it arrives Home says what it is waiting
      // on, as the Library tab does, rather than showing a blank page.
      switch model.library {
      case .idle, .loading:
        LoadingState()
          .accessibilityIdentifier("home-loading")
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading the library") {
          Task { await model.loadLibrary() }
        }
        .accessibilityIdentifier("home-error")
      case .loaded(let sets):
        // Before the first Set, Home has no rails to show; it says so and offers the first filing.
        if sets.isEmpty {
          EmptyLibraryState(recover: { openFilingSheet() })
            .accessibilityIdentifier("home-empty")
        }
      }
    }
    .sidebarPageTitle("Home")
    .largeTitleOnIOS()
    .toolbar {
      ToolbarItem {
        Button("File a set", systemImage: "plus") { openFilingSheet() }
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("home-file")
      }
      #if os(iOS)
        settingsButton
      #endif
    }
    .sheet(isPresented: $isFilingSheetShown) { filingSheet }
    .onChange(of: model.reveal != nil) { _, hasReveal in
      // Every tab visited is still alive; only the one on show opens the sheet.
      if hasReveal, model.destination == destination { isFilingSheetShown = true }
    }
    .onChange(of: model.playlistImport.isImporting) { _, importing in
      // The clipboard banner imports without the sheet open. Only the screen on show opens it.
      if importing, model.destination == destination { isFilingSheetShown = true }
    }
    #if os(iOS)
      .playlistPage(model, in: .home, zoom: setZoom) { id in setPage(id) }
    #endif
    .collectionPage(model, in: .home, zoom: setZoom) { id in setPage(id) }
    .navigationDestination(item: openedSet) { id in setPage(id) }
  }

  private func setPage(_ id: String) -> some View {
    SetDetailScreen(model: model, setId: id)
      .zoomTransition(from: SetZoom.sourceID(id, place: setZoomOrigin), in: setZoomNamespace)
  }

  /// The Set pushed from this stack's root. While a Playlist is pushed here, its page pushes
  /// the Set instead.
  private var openedSet: Binding<String?> {
    Binding(
      get: { isPlaylistOpenHere ? nil : model.openedSets[destination] },
      set: { model.openedSets[destination] = $0 }
    )
  }

  private var isPlaylistOpenHere: Bool {
    #if os(iOS)
      model.playlistPlace == destination && model.openedPlaylistId != nil
    #else
      false
    #endif
  }

  private var filedSets: [SavedSet] {
    if case .loaded(let sets) = model.library { sets } else { [] }
  }

  private func openFilingSheet() {
    isFilingSheetShown = true
    #if os(iOS)
      Task {
        guard model.reveal == nil, !model.isFiling, !model.playlistImport.isImporting,
          let link = await ClipboardLink.read(), !ClipboardLink.isFiled(link, in: filedSets)
        else {
          focusLink = true
          return
        }
        // A playlist stays on the clipboard after its import, and no Set ever matches its link,
        // so filing it on every open would import it again each time. It waits for Import.
        if PlaylistLink.kind(of: link) == .playlist {
          model.linkToFile = link
          focusLink = true
        } else {
          await model.pasteAndFile(link)
        }
      }
    #else
      focusLink = true
    #endif
  }

  private var tagTiles: AnyView {
    AnyView(
      VStack(alignment: .leading, spacing: 10) {
        if let creator = model.activeCreator {
          Button {
            model.activeCreator = nil
          } label: {
            Label(creator.name, systemImage: "xmark.circle.fill")
              .font(.orbis.detail)
          }
          .buttonStyle(.bordered)
          .tint(Color.orbis.tint)
          .accessibilityLabel("Showing sets by \(creator.name). Clear.")
          .accessibilityIdentifier("creator-filter")
        }
        ScrollView(.horizontal, showsIndicators: false) {
          GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
              ForEach(model.availableTags, id: \.self) { tag in
                let active = model.activeTags.contains(tag)
                Button {
                  model.toggleTagFilter(tag)
                } label: {
                  GlassTagChip(
                    tag, count: model.tagCounts[tag] ?? 0,
                    category: SetPresentation.category(for: tag), selected: active)
                }
                .buttonStyle(.plain)
                .orbisAnimation(.tagToggled, value: active)
                .accessibilityIdentifier("tag-filter-\(tag)")
              }
            }
            .padding(.horizontal, 16)
          }
        }
        .padding(.horizontal, -16)
        .scrollClipDisabled()
      }
    )
  }

  /// The count, and while a filter is on, what the filter is, so a short list explains itself.
  private var libraryFooter: String {
    guard model.isFilteringLibrary else {
      let total = model.totalCount
      return total == 1 ? "1 set" : "\(total) sets"
    }
    var parts = [model.visibleCount == 1 ? "1 set" : "\(model.visibleCount) sets"]
    if !model.activeTags.isEmpty {
      parts.append("tagged \(model.activeTags.formatted(.list(type: .and)))")
    }
    if let creator = model.activeCreator { parts.append("by \(creator.name)") }
    return parts.joined(separator: " ")
  }

  private func selectionBar(count: Int) -> some View {
    HStack {
      Text("\(count) selected")
        .font(.headline)
        .monospacedDigit()
        .contentTransition(.numericText())
        .accessibilityIdentifier("library-selection-count")
      Spacer()
      // The bar is the glass; a glass button on it would be glass on glass.
      Button("Tag", systemImage: "tag") { isBulkTagging = true }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(Color.orbis.tint)
        .disabled(count == 0)
        .accessibilityIdentifier("library-bulk-tag")
    }
    .padding(.leading, 20)
    .padding(.trailing, 8)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: .capsule)
    .padding(.horizontal)
    .padding(.bottom, 8)
  }

  private var clearFilters: AnyView? {
    guard model.isFilteringLibrary, !librarySearchIsActive else { return nil }
    return AnyView(
      Button("Clear") { model.clearLibraryFilters() }
        .font(.orbis.label)
        .foregroundStyle(Color.orbis.tint)
        .buttonStyle(.plain)
        .accessibilityLabel("Clear filters")
        .accessibilityIdentifier("library-clear-filters")
    )
  }

  private var filingSheet: some View {
    FilingSheet(model: model, focusLink: $focusLink) { isFilingSheetShown = false }
  }

  /// Selection mode shows only Done, so nothing else starts while Sets are picked.
  @ToolbarContentBuilder
  private var libraryToolbar: some ToolbarContent {
    if selectedIds == nil {
      ToolbarItem {
        Button("File a set", systemImage: "plus") { openFilingSheet() }
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("library-file")
      }
      ToolbarItem {
        Menu {
          // Playing a Playlist is only offered while the Library is showing one: with
          // Everything selected there is no Playlist to play.
          if model.selectedPlaylistId != nil {
            Button("Play playlist", systemImage: "play.circle") {
              if model.isPlayingNow {
                isConfirmingPlaylist = true
              } else {
                playSelectedPlaylist()
              }
            }
            .accessibilityIdentifier("library-play-playlist")
          }
          Button("Select", systemImage: "checkmark.circle") { selectedIds = [] }
            .accessibilityIdentifier("library-select")
          Menu("Sort by", systemImage: "arrow.up.arrow.down") {
            Picker("Sort by", selection: $model.librarySort) {
              ForEach(LibrarySort.allCases) { sort in
                Text(sort.rawValue).tag(sort)
              }
            }
          }
          .accessibilityIdentifier("library-sort")
        } label: {
          Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("library-more")
      }
    } else {
      ToolbarItem {
        Button("Done") { selectedIds = nil }
          .fontWeight(.semibold)
          .accessibilityIdentifier("library-select-done")
      }
    }
  }

  private func playSelectedPlaylist() {
    guard let playlistId = model.selectedPlaylistId else { return }
    Task { await model.playPlaylist(playlistId) }
  }

  @ToolbarContentBuilder
  private var settingsButton: some ToolbarContent {
    ToolbarItem {
      Button("Settings", systemImage: "gearshape") { model.isShowingSettings = true }
        .accessibilityIdentifier("settings-open")
    }
  }
}

/// Home: the Set to go back to, then the rails a music app's home gives its sections. The page
/// takes its light from the lead Set's artwork, so the glass on it has colour to bend.
struct HomeRails: View {
  @Bindable var model: AppModel
  @Environment(\.openURL) private var openURL
  @Environment(\.setZoom) private var zoom

  /// The page's own padding, matched so a rail's first card lines up with the list under it.
  private static let edgeInset: CGFloat = 16

  var body: some View {
    VStack(alignment: .leading, spacing: 36) {
      ClipboardBanner(model: model)
      if let lead = home.lead {
        HomeHero(model: model, set: lead, isResume: home.isResume)
      }
      if !model.availableTags.isEmpty {
        tagRow
      }
      if !home.continueRail.isEmpty {
        rail("Continue listening", subtitle: "Pick up where you left off.") { continueCards }
      }
      if !home.heavyRotation.isEmpty {
        rail(
          HeavyRotationView.title, subtitle: ListeningRange.month.summary,
          seeAll: { model.openHeavyRotation(in: .home) }
        ) { rotationCards }
      }
      if !home.recentlyFiled.isEmpty {
        rail("Recently filed", subtitle: "The newest links in your library.") { recentCards }
      }
      if !model.playlistItems.isEmpty {
        playlistGrid
      }
    }
    // Full width even with nothing in it. A new Person's Home is empty, and an empty column
    // narrowed the page to its padding, which drew the glow as a strip down the middle.
    .frame(maxWidth: .infinity, alignment: .leading)
    // A Set's page opens with its Tracklist in place, rather than pushing its facts down once
    // the Tracklist arrives mid-zoom.
    .task(id: shown.map(\.id)) { await model.loadTracklists(shown) }
  }

  /// The Sets Home shows, whose pages are a tap away.
  private var shown: [SavedSet] {
    let home = home
    return home.continueListening.prefix(HomeSelection.recentLimit) + home.heavyRotation
      + home.recentlyFiled
  }

  /// The Set Home leads with: the one most recently left part-way, or else the newest filed.
  var lead: SavedSet? { home.lead }

  private var librarySets: [SavedSet] {
    if case .loaded(let sets) = model.library { sets } else { [] }
  }

  private var home: HomeSelection {
    guard case .loaded(let visible) = model.visibleSets else {
      return HomeSelection(library: librarySets, visible: [], heavyRotation: model.heavyRotation)
    }
    return HomeSelection(library: librarySets, visible: visible, heavyRotation: model.heavyRotation)
  }

  private func card(_ set: SavedSet, detail: String?) -> SetCard {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    return SetCard(
      title: set.title,
      detail: detail,
      artwork: SetPresentation.row(set).artwork,
      progress: SetPresentation.progress(of: set),
      isCurrent: isCurrent,
      isPlaying: isCurrent && model.audioPlayer.state == .playing
    )
  }

  /// What a long press on a card offers: the same play, queue, and source actions as a Library
  /// row, so a Set reads the same wherever it is held.
  @ViewBuilder private func cardMenu(_ set: SavedSet, place: String) -> some View {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    if let playback = SetPresentation.playback(
      of: set, currentSetId: model.audioPlayer.currentSetId,
      isPlaying: isCurrent && model.audioPlayer.state == .playing)
    {
      Button(playback.label, systemImage: playback.symbol) { model.togglePlayback(set.id) }
      if !isCurrent {
        Button("Play Next", systemImage: "text.line.first.and.arrowtriangle.forward") {
          Task { await model.playNext(set.id) }
        }
        Button("Add to Queue", systemImage: "text.line.last.and.arrowtriangle.forward") {
          Task { await model.addToQueue(set.id) }
        }
      }
    }
    Button("Details", systemImage: "info.circle") {
      zoom?.open(from: place)
      model.openSet(set.id)
    }
    if let link = SetPresentation.sourceURL(set) {
      Button("Open Source", systemImage: "safari") { openURL(link) }
    }
  }

  /// The card lifted out under the finger, at a size where the artwork can be read.
  private func cardPreview(_ set: SavedSet) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
      VStack(alignment: .leading, spacing: 2) {
        Text(set.title).font(.headline).lineLimit(2)
        if let creator = set.creator {
          Text(creator).font(.subheadline).foregroundStyle(.secondary)
        }
      }
    }
    .padding(14)
    .frame(width: 300)
    .background(Color.orbis.paperRaised)
  }

  private var continueCards: some View {
    ForEach(home.continueRail) { set in
      Button {
        zoom?.open(from: "continue")
        model.openSet(set.id)
      } label: {
        card(set, detail: SetPresentation.timeLeft(set))
          .zoomsSetPage(set.id, place: "continue")
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("continue-card-\(set.id)")
      .contextMenu {
        cardMenu(set, place: "continue")
      } preview: {
        cardPreview(set)
      }
    }
  }

  private var rotationCards: some View {
    ForEach(home.heavyRotation) { set in
      Button {
        zoom?.open(from: "rotation")
        model.openSet(set.id)
      } label: {
        card(set, detail: set.creator)
          .zoomsSetPage(set.id, place: "rotation")
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("rotation-card-\(set.id)")
      .contextMenu {
        cardMenu(set, place: "rotation")
      } preview: {
        cardPreview(set)
      }
    }
  }

  private var recentCards: some View {
    ForEach(home.recentlyFiled) { set in
      Button {
        zoom?.open(from: "recent")
        model.openSet(set.id)
      } label: {
        card(
          set,
          detail: set.creator ?? set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil }
        )
        .zoomsSetPage(set.id, place: "recent")
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("recent-card-\(set.id)")
      .contextMenu {
        cardMenu(set, place: "recent")
      } preview: {
        cardPreview(set)
      }
    }
  }

  /// Tags as a strip of glass chips under the lead Set, one tap from a filtered Library. A Mac
  /// window has the width to show them all, so they wrap there instead of scrolling.
  @ViewBuilder private var tagRow: some View {
    #if os(macOS)
      GlassEffectContainer(spacing: 8) {
        ChipFlow(spacing: 8) { tagChips }
      }
    #else
      ScrollView(.horizontal, showsIndicators: false) {
        GlassEffectContainer(spacing: 8) {
          HStack(spacing: 8) { tagChips }
            .padding(.horizontal, Self.edgeInset)
        }
      }
      .padding(.horizontal, -Self.edgeInset)
      .scrollClipDisabled()
    #endif
  }

  private var tagChips: some View {
    ForEach(model.availableTags, id: \.self) { tag in
      Button {
        model.showTag(tag)
      } label: {
        GlassTagChip(
          tag, count: model.tagCounts[tag] ?? 0,
          category: SetPresentation.category(for: tag))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("home-tag-\(tag)")
    }
  }

  private var playlistGrid: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading("Playlists", subtitle: "Your sets, sorted for the moment.")
      // Two folders across a phone, as on the Playlists page; a Mac or iPad window fits more
      // rather than stretching two.
      CardGrid(spacing: 18) {
        ForEach(model.playlistItems) { playlist in
          Button {
            #if os(iOS)
              // A phone pushes the Playlist on Home's own stack, so Back returns to Home.
              model.openPlaylist(playlist.id, in: .home)
            #else
              model.showPlaylist(playlist.id)
            #endif
          } label: {
            PlaylistSleeve(
              name: playlist.name,
              count: playlist.setCount,
              artwork: model.artwork(ofPlaylist: playlist.id),
              category: SetPresentation.category(for: playlist.name)
            )
            .playlistZoomSource(playlist.id, in: zoom)
          }
          .buttonStyle(.orbisPressable)
          .accessibilityIdentifier("playlist-card-\(playlist.id)")
        }
      }
    }
    .task(id: model.playlistItems.map(\.id)) { await model.prefetchPlaylistMembers() }
  }

  private func rail<Cards: View>(
    _ name: String, subtitle: String, seeAll: (() -> Void)? = nil,
    @ViewBuilder cards: () -> Cards
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        SectionHeading(name, subtitle: subtitle)
        if let seeAll {
          Button("See All", action: seeAll)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.orbis.tint)
            .buttonStyle(.plain)
            .accessibilityLabel("See all of \(name)")
            .accessibilityIdentifier("rotation-see-all")
        }
      }
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) { cards() }
          .padding(.horizontal, Self.edgeInset)
          .scrollTargetLayout()
      }
      // The rail escapes the page's padding and runs to the screen's edges, the way a music
      // app's rows bleed; the inner padding keeps the first card on the page's own margin.
      .padding(.horizontal, -Self.edgeInset)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
    .accessibilityElement(children: .contain)
  }
}

/// The Set Home leads with, large: its artwork, its name, and one button that plays it.
private struct HomeHero: View {
  @Bindable var model: AppModel
  let set: SavedSet
  /// The Set was left part-way, so the button resumes and says how long is left.
  let isResume: Bool
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.setZoom) private var zoom

  private var hero: HeroLayout { HeroLayout(sizeClass) }
  /// The artwork spans a phone's width; beside the words in a wide window it is a cover's size.
  private var maxArtworkWidth: CGFloat { hero.isBeside ? 440 : 560 }

  private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }
  private var isPlaying: Bool { isCurrent && model.audioPlayer.state == .playing }
  private var canPlay: Bool { self.set.downloadState == "ready" }

  private var playLabel: String {
    if isPlaying { return "Pause" }
    if isResume, let left = SetPresentation.timeLeft(set) { return left }
    return set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil } ?? "Play"
  }

  var body: some View {
    let layout = hero.stack(spacing: 16)
    layout {
      Button {
        zoom?.open(from: nil)
        model.openSet(set.id)
      } label: {
        Artwork(
          url: SetPresentation.pageArtwork(set), seed: set.title, size: .header,
          progress: SetPresentation.progress(of: set)
        )
        .zoomsSetPage(set.id)
        .shadow(color: .black.opacity(0.45), radius: 28, y: 16)
        .frame(maxWidth: maxArtworkWidth)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityLabel("Open \(set.title)")
      .accessibilityIdentifier("home-hero-\(set.id)")
      VStack(alignment: hero.alignment, spacing: 16) {
        VStack(alignment: hero.alignment, spacing: 6) {
          Eyebrow(isResume ? "Continue listening" : "Fresh in your library")
          Text(set.title)
            .font(hero.isBeside ? Font.orbis.largeTitle : Font.orbis.title)
            .multilineTextAlignment(hero.textAlignment)
            .lineLimit(3)
          if let creator = set.creator, !creator.isEmpty {
            Text(creator)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: hero.frameAlignment)
        actions
      }
    }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      if canPlay {
        Button {
          model.togglePlayback(set.id)
        } label: {
          Label(playLabel, systemImage: isPlaying ? "pause.fill" : "play.fill")
            .font(.headline)
            .monospacedDigit()
            .orbisSymbolReplace()
            .padding(.horizontal, 6)
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.large)
        .sensoryFeedback(.impact(weight: .medium), trigger: isPlaying)
        .accessibilityIdentifier("home-hero-play")
        if model.canPlayFromBeginning(set) {
          Button {
            Task { await model.playFromBeginning(set.id) }
          } label: {
            Label("Play from Beginning", systemImage: "backward.end.fill")
              .font(.headline)
              .labelStyle(.iconOnly)
          }
          .buttonStyle(.glass)
          .controlSize(.large)
          .accessibilityIdentifier("home-hero-play-from-beginning")
        }
      }
      Button {
        zoom?.open(from: nil)
        model.openSet(set.id)
      } label: {
        Label(canPlay ? "Details" : "Open set", systemImage: canPlay ? "ellipsis" : "arrow.right")
          .font(.headline)
          .labelStyle(.titleAndIcon)
      }
      .buttonStyle(.glass)
      .controlSize(.large)
    }
  }
}

/// A link on the clipboard, offered for filing in one tap. The clipboard is only asked whether
/// it holds something shaped like a web address, which needs no permission; the system Paste
/// button reads it, so filing never raises the paste prompt either.
private struct ClipboardBanner: View {
  @Bindable var model: AppModel
  @Environment(\.scenePhase) private var scenePhase
  @State private var offeredChange: Int?

  var body: some View {
    Group {
      if offeredChange != nil {
        HStack(spacing: 12) {
          Image(systemName: "doc.on.clipboard")
            .font(.title3)
            .foregroundStyle(Color.orbis.tint)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            Text("A link is on your clipboard")
              .font(.subheadline.weight(.semibold))
            Text("File it to your library")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          PasteButton(payloadType: String.self) { pasted in
            guard let text = pasted.first else { return }
            offeredChange = nil
            Task { await model.pasteAndFile(text) }
          }
          .labelStyle(.titleOnly)
          .buttonBorderShape(.capsule)
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("home-paste-and-file")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.orbis.paperRaised, in: .rect(cornerRadius: Radius.field))
      }
    }
    .task(id: scenePhase) { await look() }
  }

  private func look() async {
    offeredChange = await ClipboardLink.offerableChange()
  }
}

struct SearchDestination: View {
  @Bindable var model: AppModel
  /// The last queries that found something, newest first, one per line. Kept on the device: they
  /// are a convenience for this person here, not part of the library.
  @AppStorage(AppModel.recentSearchesKey) private var recentSearches = ""
  private static let recentLimit = 6
  /// The field is resigned before the query is cleared. SwiftUI does not push a programmatic
  /// change to a search field that is still first responder, so a clear that only set the
  /// binding left the old query on screen while the screen said nothing had been asked.
  @FocusState private var isFieldFocused: Bool
  /// How wide the results are, which decides where the Tracklist matches go.
  @State private var searchWidth: CGFloat = 0

  var body: some View {
    searchPage
      // On the screen, not the results: the results view is not there until a search has run.
      .onSubmit(of: .search) {
        remember(model.searchQuery)
        Task { await model.runSearch() }
      }
      .searchesAsTyped(model)
      // Again once the library arrives: Search opened before it would otherwise never find a
      // track by name.
      .task(id: model.totalCount) { await model.loadTracklistsForSearch() }
  }

  private var recentQueries: [String] {
    recentSearches.split(separator: "\n").map(String.init)
  }

  private func remember(_ query: String) {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return }
    let kept = recentQueries.filter { $0.caseInsensitiveCompare(query) != .orderedSame }
    recentSearches = ([query] + kept).prefix(Self.recentLimit).joined(separator: "\n")
  }

  private func search(for query: String) {
    remember(query)
    model.searchQuery = query
    Task { await model.runSearch() }
  }

  private var searchPage: some View {
    #if os(macOS)
      searchBody.sidebarPageTitle("Search")
        .searchable(
          text: $model.searchQuery, placement: .toolbar,
          prompt: "Search Sets and Playlists"
        )
        .searchFocused($isFieldFocused)
        .macSearchToolbarBackground(isSearching: !model.searchQuery.isEmpty)
        // Choosing Search in the sidebar puts the cursor in its field, so typing starts the
        // search; choosing it again while it is open asks for the field the same way.
        .onAppear { isFieldFocused = true }
        .onChange(of: model.searchFocusRequests) { isFieldFocused = true }
    #else
      searchBody
        .sidebarPageTitle("Search")
        // At the top and always shown, the way Apple Music shows it, rather than folded into
        // the tab bar where it reads as a tab and not a field.
        .searchable(
          text: $model.searchQuery, placement: .navigationBarDrawer(displayMode: .always),
          prompt: "Title, tag, or source link"
        )
        .searchFocused($isFieldFocused)
        .onChange(of: model.searchFocusRequests) { isFieldFocused = true }
    #endif
  }

  private var searchBody: some View {
    Group {
      if isUntouched {
        // Nothing has been asked yet, so nothing has failed. One line says what the field
        // searches; the field itself is the action.
        SearchStart(
          model: model, prompt: Self.prompt(total: model.totalCount), recent: recentQueries,
          search: search(for:), clearRecent: { recentSearches = "" }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search-untouched")
      } else {
        results
      }
    }
  }

  /// Empties the field and the results, from the button. The field is resigned first: while it
  /// holds focus it ignores the binding, so the order is what makes the query leave the screen.
  private func clear() {
    isFieldFocused = false
    model.clearSearch()
  }

  /// "Search your 8 sets."
  static func prompt(total: Int) -> String {
    total == 1 ? "Search your 1 set." : "Search your \(total) sets."
  }

  /// Nothing has been submitted yet. Typing alone changes nothing on screen; Return does.
  private var isUntouched: Bool {
    if case .idle = model.search { return true }
    return false
  }

  /// On a Mac the tracks found inside Tracklists take a column of their own beside the Sets,
  /// where a phone puts them under the Sets.
  @ViewBuilder private var results: some View {
    let cues = isTagQuery ? [] : model.cueMatches
    #if os(macOS)
      HStack(alignment: .top, spacing: 0) {
        resultList(cuesBelow: [], foundCues: !cues.isEmpty, backdrop: .none)
        if !cues.isEmpty {
          ScrollView {
            TracklistMatches(model: model, matches: cues)
              .padding()
          }
          .frame(width: 400)
          .accessibilityIdentifier("search-cues-column")
        }
      }
      .background { ArtworkGlow(url: topResult.flatMap(SetPresentation.pageArtwork), reach: 0.55) }
    #else
      // A wide window, such as an unfolded iPhone Duo, has the room to put them beside the Sets
      // as a Mac does. The list stays the stack's first view either way, so a resize keeps it.
      let isBeside = !cues.isEmpty && searchWidth >= Self.cuesBesideWidth
      let artwork = topResult.flatMap(SetPresentation.pageArtwork)
      HStack(alignment: .top, spacing: 0) {
        resultList(
          cuesBelow: isBeside ? [] : cues, foundCues: !cues.isEmpty,
          backdrop: isBeside ? .none : .artwork(artwork))
        if isBeside {
          ScrollView {
            TracklistMatches(model: model, matches: cues)
              .padding()
          }
          .frame(width: 280)
          .accessibilityIdentifier("search-cues-column")
        }
      }
      .background {
        if isBeside { ArtworkGlow(url: artwork, reach: 0.55) }
      }
      .onGeometryChange(for: CGFloat.self) {
        $0.size.width
      } action: {
        searchWidth = $0
      }
    #endif
  }

  /// The narrowest results that take the Tracklist matches in a column beside them.
  private static let cuesBesideWidth: CGFloat = 760

  private var isTagQuery: Bool { SetPresentation.isTagQuery(model.searchResultsFor ?? "") }

  /// The Tags the query names, shown above the Sets so a Tag is one tap from its filter.
  private var matchingTags: [String] {
    SetPresentation.tagsMatching(model.searchResultsFor ?? "", in: model.availableTags)
  }

  /// `foundCues` keeps the heading and the top result up when the only matches are in a
  /// Tracklist shown beside the list rather than in it.
  private func resultList(
    cuesBelow cues: [CueMatch], foundCues: Bool, backdrop: SetList.Backdrop
  ) -> some View {
    let top = topResult
    let tags = matchingTags
    return SetList(
      state: remainingResults,
      heading: nil,
      empty: isTagQuery
        ? AnyView(
          ContentUnavailableView {
            Label("No Tags", systemImage: "tag")
          } description: {
            Text("No Tag matches \"\(model.searchResultsFor ?? "")\".")
          } actions: {
            Button("Clear search", action: clear)
          }
          .accessibilityIdentifier("search-no-tags")
        )
        : AnyView(
          NoResultsState(recoverLabel: "Clear search", recover: clear)
            .accessibilityIdentifier("search-no-results")
        ),
      failureContext: "searching the library",
      filters: nil,
      // A search that found nothing already shows the no-results state, so there is no
      // second one to reach.
      noMatches: nil,
      hero: nil,
      aboveRows: top == nil && !foundCues && tags.isEmpty
        ? nil : AnyView(aboveResults(top, tags: tags)),
      belowRows: cues.isEmpty ? nil : AnyView(TracklistMatches(model: model, matches: cues)),
      footer: searchFooter,
      retry: { await model.runSearch() },
      listIdentifier: "search-list",
      // A result is something to open, which is the whole reason to search.
      select: { set in model.openSet(set.id) },
      currentSetId: model.audioPlayer.currentSetId,
      isPlaying: model.audioPlayer.state == .playing,
      togglePlayback: { set in model.togglePlayback(set.id) },
      backdrop: backdrop
    )
  }

  /// The best match leads, large, with its two quickest actions; the rest are rows under it.
  private var topResult: SavedSet? {
    if case .loaded(let sets) = model.search { sets.first } else { nil }
  }

  private var remainingResults: Loadable<[SavedSet]> {
    if case .loaded(let sets) = model.search { .loaded(Array(sets.dropFirst())) } else { model.search }
  }

  private func aboveResults(_ top: SavedSet?, tags: [String]) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      MacPageTitle.slot("Search")
      heading
        .font(.orbis.sectionTitle)
        .accessibilityAddTraits(.isHeader)
      if !tags.isEmpty {
        tagRow(tags)
      }
      if let top {
        TopResult(model: model, set: top)
      }
      matchingPlaylistRows
    }
  }

  private func tagRow(_ tags: [String]) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          ForEach(tags, id: \.self) { tag in
            Button {
              model.showTag(tag)
            } label: {
              GlassTagChip(
                tag, count: model.tagCounts[tag] ?? 0, category: SetPresentation.category(for: tag))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-result-tag-\(tag)")
          }
        }
        .padding(.horizontal, 16)
      }
    }
    .padding(.horizontal, -16)
    .scrollClipDisabled()
  }

  private var matchingPlaylistRows: AnyView? {
    #if os(macOS)
      guard let query = model.searchResultsFor else { return nil }
      let playlists = model.playlistItems.filter {
        $0.name.localizedCaseInsensitiveContains(query)
      }
      guard !playlists.isEmpty else { return nil }
      return AnyView(
        VStack(alignment: .leading, spacing: 8) {
          Text("Playlists").font(.headline)
          ForEach(playlists) { playlist in
            Button {
              model.showPlaylist(playlist.id)
            } label: {
              PlaylistRow(playlist.name, count: playlist.setCount)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-playlist-\(playlist.name)")
          }
        })
    #else
      nil
    #endif
  }

  /// The heading names the query the results answer, not whatever sits in the field: typing
  /// a second query before submitting must not relabel the results still on screen.
  private var heading: Text {
    let query = model.searchResultsFor ?? ""
    return Text(query.isEmpty ? "Search" : "Results for \"\(query)\"")
  }

  private var searchFooter: String {
    if isTagQuery {
      let count = matchingTags.count
      return count == 1 ? "1 tag" : "\(count) tags"
    }
    guard case .loaded(let sets) = model.search else { return "" }
    return sets.count == 1 ? "1 set" : "\(sets.count) sets"
  }
}

/// Search before anything is asked: the last Tag filters, the Tags and creators to browse by,
/// and the last queries, each one tap from a result.
private struct SearchStart: View {
  @Bindable var model: AppModel
  let prompt: String
  let recent: [String]
  let search: (String) -> Void
  let clearRecent: () -> Void

  /// One Set per creator, the newest, whose artwork stands for them.
  private var creators: [SavedSet] {
    guard case .loaded(let sets) = model.library else { return [] }
    var seen = Set<String>()
    return sets.filter { set in
      guard let name = set.creator, !name.isEmpty else { return false }
      return seen.insert(name).inserted
    }
    .prefix(12)
    .map { $0 }
  }

  /// The recent combinations of Tags the library still holds. A single Tag already leads the
  /// Tags row, which is ordered by recent use.
  private var recentFilters: [[String]] {
    model.recentTagFilters.filter { $0.count > 1 && $0.allSatisfy { model.tagCounts[$0] != nil } }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        MacPageTitle.slot("Search")
        ListingLabel(prompt)
        if !recentFilters.isEmpty {
          section("Recent filters") {
            ChipFlow {
              ForEach(Array(recentFilters.enumerated()), id: \.element) { index, tags in
                Button {
                  model.showTags(tags)
                } label: {
                  GlassTagChip(
                    tags.joined(separator: " + "),
                    category: SetPresentation.category(for: tags[0]))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search-recent-filter-\(index)")
              }
            }
          }
        }
        if !model.availableTags.isEmpty {
          section("Tags") {
            ChipFlow {
              ForEach(model.availableTags, id: \.self) { tag in
                Button {
                  model.showTag(tag)
                } label: {
                  GlassTagChip(
                    tag, count: model.tagCounts[tag] ?? 0,
                    category: SetPresentation.category(for: tag))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search-tag-\(tag)")
              }
            }
          }
        }
        if !creators.isEmpty {
          section("Creators") {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(alignment: .top, spacing: 16) {
                ForEach(creators) { set in
                  Button {
                    model.showCreator(of: set)
                  } label: {
                    VStack(spacing: 6) {
                      Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .header)
                        .frame(width: 136)
                        .frame(width: 76, height: 76)
                        .clipShape(.circle)
                        .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
                      Text(set.creator ?? "")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .frame(width: 80)
                    }
                  }
                  .buttonStyle(.orbisPressable)
                  .accessibilityLabel("Sets by \(set.creator ?? "")")
                }
              }
              .padding(.horizontal, 16)
            }
            .padding(.horizontal, -16)
            .scrollClipDisabled()
          }
        }
        if !recent.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
              SectionHeading("Recent")
              Button("Clear", action: clearRecent)
                .tint(Color.orbis.tint)
            }
            ForEach(recent, id: \.self) { query in
              Button {
                search(query)
              } label: {
                Label(query, systemImage: "clock")
                  .font(.body)
                  .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                  .contentShape(.rect)
              }
              .buttonStyle(.plain)
              Divider()
            }
          }
        }
      }
      .padding()
    }
    .background { TintGlow() }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title)
      content()
    }
  }
}

/// The best match for a search, large, with Play and Play Next beside it.
private struct TopResult: View {
  @Bindable var model: AppModel
  let set: SavedSet

  var body: some View {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    let isPlaying = isCurrent && model.audioPlayer.state == .playing
    VStack(alignment: .leading, spacing: 12) {
      Button {
        model.openSet(set.id)
      } label: {
        HStack(spacing: 14) {
          Artwork(
            url: SetPresentation.row(set).artwork, seed: set.title, size: .rail,
            progress: SetPresentation.progress(of: set)
          )
          .zoomsSetPage(set.id)
          VStack(alignment: .leading, spacing: 2) {
            Text(set.title)
              .font(.headline)
              .lineLimit(3)
              .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
            Text(["Set", set.creator].compactMap { $0 }.joined(separator: " · "))
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(set.title)
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("search-top-result")
      if set.downloadState == "ready" {
        HStack(spacing: 10) {
          Button {
            model.togglePlayback(set.id)
          } label: {
            Label(
              isPlaying ? "Pause" : SetPresentation.timeLeft(set) ?? "Play",
              systemImage: isPlaying ? "pause.fill" : "play.fill"
            )
            .font(.headline)
            .monospacedDigit()
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          Button {
            Task { await model.playNext(set.id) }
          } label: {
            Label("Play Next", systemImage: "text.line.first.and.arrowtriangle.forward")
              .font(.headline)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
          .tint(Color.orbis.tint)
        }
        .controlSize(.large)
      }
    }
    .padding(14)
    .orbisRaised(radius: Radius.hero)
  }
}

/// Tracks inside the library's Tracklists that match the search. Tapping one plays its Set from
/// where that track starts.
private struct TracklistMatches: View {
  @Bindable var model: AppModel
  let matches: [CueMatch]
  private static let limit = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      SectionHeading("In tracklists")
      ForEach(matches.prefix(Self.limit)) { match in
        Button {
          Task { await model.playCue(match.cue, in: match.set.id) }
        } label: {
          HStack(spacing: 12) {
            Image(systemName: "music.note")
              .font(.body.weight(.semibold))
              .foregroundStyle(Color.orbis.tint)
              .frame(width: 40, height: 40)
              .background(Color.orbis.tint.opacity(0.12), in: .circle)
            VStack(alignment: .leading, spacing: 1) {
              Text(match.cue.title)
                .font(.body.weight(.semibold))
                .lineLimit(1)
              Text("\(match.cue.artist) · in \(match.set.title)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let start = match.cue.startSeconds {
              Text(SetPresentation.timestamp(start))
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
          }
          .frame(minHeight: 56)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(match.cue.startSeconds == nil || match.set.downloadState != "ready")
        .accessibilityHint("Plays the set from this track")
        .accessibilityIdentifier("search-cue-\(match.id)")
        Divider()
      }
    }
  }
}
