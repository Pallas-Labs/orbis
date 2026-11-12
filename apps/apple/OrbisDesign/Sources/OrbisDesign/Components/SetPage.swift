import SwiftUI

/// One Set's page on iPhone, as the `set-page-v2` flag lays it out (PAL-2060).
///
/// The first screen is the artwork, full-bleed behind the top bar and fading into the page, then
/// the words and the controls, which end at the bottom of the screen where a thumb reaches them.
/// The rest arrives on scroll: the Tracklist, more from the creator, the Tags and the facts.
public struct SetPage: View {
  public let title: String
  public let source: String
  public let creator: String?
  public let showCreator: (() -> Void)?
  public let length: String?
  public let artwork: URL?
  public let artworkStandIn: URL?
  public let failedToName: Bool
  public let dates: SetDetail.Dates?
  public let statistics: SetDetail.Statistics?
  public let retryName: () -> Void
  private let controls: AnyView
  private let tracklist: AnyView
  private let moreFromCreator: AnyView
  private let tags: AnyView

  public init(
    title: String, source: String, creator: String? = nil, showCreator: (() -> Void)? = nil,
    length: String? = nil, artwork: URL? = nil, artworkStandIn: URL? = nil,
    failedToName: Bool = false, dates: SetDetail.Dates? = nil,
    statistics: SetDetail.Statistics? = nil, retryName: @escaping () -> Void = {},
    @ViewBuilder controls: () -> some View,
    @ViewBuilder tracklist: () -> some View = { EmptyView() },
    @ViewBuilder moreFromCreator: () -> some View = { EmptyView() },
    @ViewBuilder tags: () -> some View = { EmptyView() }
  ) {
    self.title = title
    self.source = source
    self.creator = creator
    self.showCreator = showCreator
    self.length = length
    self.artwork = artwork
    self.artworkStandIn = artworkStandIn
    self.failedToName = failedToName
    self.dates = dates
    self.statistics = statistics
    self.retryName = retryName
    self.controls = AnyView(controls())
    self.tracklist = AnyView(tracklist())
    self.moreFromCreator = AnyView(moreFromCreator())
    self.tags = AnyView(tags())
  }

  /// The title as the page shows it. A title that opens with "<creator> - " says the creator
  /// twice, because the creator sits on the line under it, so the page drops that prefix.
  public static func displayTitle(_ title: String, creator: String?) -> String {
    guard let creator = creator?.trimmingCharacters(in: .whitespaces), !creator.isEmpty else {
      return title
    }
    for separator in [" - ", " – ", " — "] {
      let prefix = creator + separator
      if title.range(of: prefix, options: [.anchored, .caseInsensitive]) != nil {
        let rest = title.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? title : rest
      }
    }
    return title
  }

  @State private var width: CGFloat = 0
  @State private var topInset: CGFloat = 0
  @State private var visibleHeight: CGFloat = 0
  @State private var titleBottom = CGFloat.infinity
  @State private var showsBarTitle = false
  private static let content = "set-page-content"

  /// How far the words climb onto the artwork's fade.
  private static let overlap: CGFloat = 64

  private var shownTitle: String { Self.displayTitle(title, creator: creator) }

  public var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        firstScreen
        VStack(spacing: 28) {
          tracklist
          moreFromCreator
          tags
          footer
        }
        .padding(.horizontal)
        .padding(.top, 28)
        .padding(.bottom, 32)
      }
      .coordinateSpace(.named(Self.content))
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .onScrollGeometryChange(for: [CGFloat].self) { geometry in
      [geometry.contentInsets.top, geometry.containerSize.height - geometry.contentInsets.top
        - geometry.contentInsets.bottom]
    } action: { _, values in
      topInset = values[0]
      visibleHeight = values[1]
    }
    // The bar names the Set only once the title has scrolled under it, as an album does.
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > titleBottom
    } action: { _, scrolledPast in
      showsBarTitle = scrolledPast
    }
    .navigationTitle(showsBarTitle ? shownTitle : "")
    .background(Color.orbis.paper)
  }

  /// The artwork, the words and the controls, at least one screen tall, so the controls end at
  /// the bottom of the first screen. Text sizes that need more room push the controls below it
  /// rather than over the words.
  private var firstScreen: some View {
    VStack(spacing: 0) {
      Color.clear
        .frame(height: max(width - topInset - Self.overlap, 0))
      header
      Spacer(minLength: 24)
      controls
    }
    .padding(.horizontal)
    .padding(.bottom, 12)
    .frame(minHeight: visibleHeight, alignment: .bottom)
    .background(alignment: .top) {
      HeroArtwork(url: artwork, standIn: artworkStandIn, seed: title)
        .frame(width: width, height: width)
        .offset(y: -topInset)
    }
  }

  private var header: some View {
    VStack(spacing: 2) {
      Text(shownTitle)
        .font(.orbis.title)
        .multilineTextAlignment(.center)
        .accessibilityLabel(SetDetail.headerLabel(title: shownTitle, source: source))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("detail-title")
        .onGeometryChange(for: CGFloat.self) {
          $0.frame(in: .named(Self.content)).maxY
        } action: {
          titleBottom = $0
        }
      if let creator, !creator.isEmpty {
        let name = Text(creator)
          .font(.title3)
          .foregroundStyle(Color.orbis.tint)
          .multilineTextAlignment(.center)
        if let showCreator {
          Button(action: showCreator) { name }
            .buttonStyle(.plain)
            .accessibilityHint("Shows this creator's sets in the Library")
            .accessibilityIdentifier("detail-creator")
        } else {
          name
        }
      }
      Text(SetDetail.eyebrow(source: source, length: length, dates: dates))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.top, 4)
        .accessibilityIdentifier("detail-source-line")
      if failedToName {
        HStack(spacing: 6) {
          Text("Orbis could not name this set.")
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
          Button("Try again", action: retryName)
            .buttonStyle(.plain)
            .font(.orbis.detail.weight(.semibold))
            .foregroundStyle(Color.orbis.tint)
        }
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder private var footer: some View {
    let lines = SetDetail.footerLines(dates: dates, statistics: statistics)
    if !lines.isEmpty {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(lines, id: \.self) { Text($0) }
      }
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("detail-facts")
    }
  }
}

/// The artwork at the head of the page: square, edge to edge, fading into the paper below it.
private struct HeroArtwork: View {
  let url: URL?
  let standIn: URL?
  let seed: String

  var body: some View {
    Group {
      if let url {
        CachedImage(url: url, standIn: standIn) { image in
          image.resizable().aspectRatio(contentMode: .fill)
        } placeholder: {
          placeholder
        }
      } else {
        placeholder
      }
    }
    .clipped()
    .mask {
      LinearGradient(
        stops: [.init(color: .black, location: 0.55), .init(color: .clear, location: 1)],
        startPoint: .top, endPoint: .bottom
      )
    }
    .accessibilityHidden(true)
  }

  private var placeholder: some View {
    let tone = OrbisColor.Category.forTag(seed).dot
    return LinearGradient(
      colors: [tone.opacity(0.55), tone.opacity(0.2)],
      startPoint: .topLeading, endPoint: .bottomTrailing
    )
  }
}

/// Other Sets by the same creator, in a rail, with See All leading to all of them.
public struct MoreFromCreator<Cards: View>: View {
  let creator: String
  let seeAll: () -> Void
  let cards: Cards

  public init(creator: String, seeAll: @escaping () -> Void, @ViewBuilder cards: () -> Cards) {
    self.creator = creator
    self.seeAll = seeAll
    self.cards = cards()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        SectionHeading("More from \(creator)")
        Button("See All", action: seeAll)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(Color.orbis.tint)
          .buttonStyle(.plain)
          .accessibilityLabel("See all sets by \(creator)")
          .accessibilityIdentifier("more-from-creator-see-all")
      }
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) { cards }
          .padding(.horizontal)
          .scrollTargetLayout()
      }
      // The rail runs to the screen's edges; its inner padding keeps the first card on the
      // page's margin.
      .padding(.horizontal, -16)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("more-from-creator")
  }
}

/// The Set's Tags under a heading, each one tap from the Library filtered by it.
public struct SetPageTags: View {
  let management: SetManagement

  public init(_ management: SetManagement) {
    self.management = management
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading("Tags")
      management
        .environment(\.setHeaderIsBeside, true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("detail-tags-section")
  }
}

private struct SetPageSample: View {
  var body: some View {
    NavigationStack {
      SetPage(
        title: "CHRIS STASSY - Live @ N:A:M:E: Birmingham 22.08.2026",
        source: "YouTube",
        creator: "CHRIS STASSY",
        length: "2h 33m",
        dates: .init(imported: "11 Sep 2026", released: "22 Aug 2026", releaseYear: "2026"),
        statistics: .init(listenCount: 3, finishCount: 1, lastHeard: "Thu 11 Sep"),
        controls: {
          HStack(spacing: 12) {
            Label("Play", systemImage: "play.fill")
              .frame(maxWidth: .infinity, minHeight: 48)
              .background(Color.orbis.paperRaised, in: .rect(cornerRadius: Radius.row))
          }
        },
        moreFromCreator: {
          MoreFromCreator(creator: "CHRIS STASSY", seeAll: {}) {
            SetCard(title: "Boiler Room Glasgow", artwork: nil)
            SetCard(title: "Hör Berlin", artwork: nil)
          }
        },
        tags: {
          SetPageTags(SetManagement(tags: ["techno", "festival"], editTags: {}))
        }
      )
      .toolbarTitleDisplayMode(.inline)
    }
  }
}

#Preview("Set page v2, iPhone") { SetPageSample() }

#Preview("Set page v2, iPhone, dark") { SetPageSample().preferredColorScheme(.dark) }

#Preview("Set page v2, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetPageSample() }
}
