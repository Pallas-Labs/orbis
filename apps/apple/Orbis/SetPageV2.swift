import OrbisDesign
import OrbisKit
import SwiftUI

/// The iPhone Set page behind the `set-page-v2` flag (PAL-2060). It reuses today's controls,
/// Tracklist, Tags sheet and More menu, and lays them out as `SetPage` does.
struct SetPageV2<Controls: View>: View {
  @Bindable var model: AppModel
  let set: SavedSet
  @Binding var isRenaming: Bool
  @ViewBuilder let controls: () -> Controls
  @State private var isShowingAbout = false

  /// The most cards the rail holds; See All shows the rest.
  private static var moreLimit: Int { 12 }

  var body: some View {
    let analysis = model.analyses[set.id]
    // About This Set opens only for a Set the node has measured and found a beat in.
    let bpm = analysis?.medianBpm.map { Int($0.rounded()) }
    SetPage(
      title: set.title,
      source: set.source.label,
      creator: set.creator,
      showCreator: { model.showCreator(of: set) },
      length: set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil },
      artwork: SetPresentation.pageArtwork(set),
      artworkStandIn: SetPresentation.row(set).artwork,
      failedToName: set.metadataState == "failed",
      dates: SetDetail.Dates(
        imported: SetPresentation.plainDate(set.createdAt),
        released: set.releasedAt.map(SetPresentation.plainDate),
        releaseYear: set.releasedAt.map(SetPresentation.year)
      ),
      statistics: SetDetail.Statistics(
        listenCount: set.listenCount,
        finishCount: set.finishCount,
        lastHeard: set.lastListenedAt.map(SetPresentation.day)
      ),
      retryName: { Task { await model.nameAgain(set.id) } },
      bpm: bpm,
      showAbout: bpm == nil ? nil : { isShowingAbout = true },
      controls: controls,
      tracklist: {
        TracklistSection(model: model, set: set, hidesNone: true)
          .orbisAnimation(.tracklistArrived, value: model.tracklists[set.id]?.cues.count)
      },
      moreFromCreator: { moreFromCreator },
      tags: { SetManagementSection(model: model, set: set, isRenaming: $isRenaming, style: .pageV2) }
    )
    // The artwork runs under the bar, so the bar does not blur what sits behind it.
    .scrollEdgeEffectHidden(true, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
    .toolbarTitleDisplayMode(.inline)
    .task(id: set.id) { await model.loadAnalysis(set.id) }
    #if os(iOS)
      .sheet(isPresented: $isShowingAbout) {
        if let analysis {
          AboutThisSetSheet(
            analysis: analysis, position: set.resumePosition,
            artwork: SetPresentation.pageArtwork(set))
        }
      }
    #endif
  }

  @ViewBuilder private var moreFromCreator: some View {
    let others = Self.others(of: set, in: model.library)
    if let creator = set.creator, !others.isEmpty {
      MoreFromCreator(
        creator: creator, seeAll: { model.showCreator(of: set) },
        cards: {
          ForEach(others.prefix(Self.moreLimit)) { other in
            Button {
              model.openSet(other.id)
            } label: {
              SetCard(
                title: SetPage.displayTitle(other.title, creator: other.creator),
                detail: other.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil },
                artwork: SetPresentation.row(other).artwork,
                progress: SetPresentation.progress(of: other)
              )
            }
            .buttonStyle(.orbisPressable)
            .accessibilityIdentifier("more-from-creator-card-\(other.id)")
          }
        })
    }
  }

  /// The other Sets in the Library by this Set's creator. The creator's id decides when both
  /// Sets have one; otherwise the name does.
  static func others(of set: SavedSet, in library: Loadable<[SavedSet]>) -> [SavedSet] {
    guard let name = set.creator, !name.isEmpty, case .loaded(let sets) = library else {
      return []
    }
    return sets.filter { other in
      guard other.id != set.id else { return false }
      if let id = set.creatorId, let otherId = other.creatorId { return id == otherId }
      return other.creator == name
    }
  }
}
