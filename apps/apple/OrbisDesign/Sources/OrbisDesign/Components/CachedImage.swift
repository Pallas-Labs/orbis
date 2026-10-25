import SwiftUI

#if canImport(UIKit)
  import UIKit
  typealias PlatformImage = UIImage
#else
  import AppKit
  typealias PlatformImage = NSImage
#endif

/// Artwork the app has drawn, kept in memory. A page that zooms out of a card draws the card's
/// picture on its first frame, rather than a placeholder that the picture replaces mid-zoom.
final class ArtworkImages {
  static let shared = ArtworkImages()
  private let cache = NSCache<NSURL, PlatformImage>()
  /// One download per image, shared by every view that asks while it runs. Not cancelled when one
  /// of them goes away, because another may still be waiting on it.
  private var loads: [URL: Task<Image?, Never>] = [:]

  /// Bounded by decoded bytes as well as count, because a full-size picture decodes to several
  /// megabytes.
  private init() {
    cache.countLimit = 300
    cache.totalCostLimit = 64 * 1024 * 1024
  }

  func image(_ url: URL) -> Image? {
    cache.object(forKey: url as NSURL).map(Image.init)
  }

  /// Fetches and decodes off the main thread, so the first frame that draws the image does not
  /// pay for decoding it.
  func load(_ url: URL) async -> Image? {
    if let image = image(url) { return image }
    let load =
      loads[url]
      ?? Task {
        defer { loads[url] = nil }
        guard let decoded = await Self.fetch(url) else { return nil }
        cache.setObject(decoded, forKey: url as NSURL, cost: Self.cost(decoded))
        return Image(decoded)
      }
    loads[url] = load
    return await load.value
  }

  /// The decoded size in bytes, at four bytes a pixel.
  private static func cost(_ image: PlatformImage) -> Int {
    #if canImport(UIKit)
      Int(image.size.width * image.scale) * Int(image.size.height * image.scale) * 4
    #else
      image.representations.first.map { $0.pixelsWide * $0.pixelsHigh * 4 } ?? 0
    #endif
  }

  @concurrent private static func fetch(_ url: URL) async -> sending PlatformImage? {
    guard let (data, _) = try? await URLSession.shared.data(from: url),
      let image = PlatformImage(data: data)
    else { return nil }
    #if canImport(UIKit)
      return await image.byPreparingForDisplay() ?? image
    #else
      return image
    #endif
  }
}

/// Loads artwork into memory before it is shown, so a page opened next draws it on its first
/// frame.
public enum ArtworkPrefetch {
  public static func load(_ urls: [URL]) async {
    for url in urls {
      _ = await ArtworkImages.shared.load(url)
    }
  }
}

extension Image {
  fileprivate init(_ image: PlatformImage) {
    #if canImport(UIKit)
      self.init(uiImage: image)
    #else
      self.init(nsImage: image)
    #endif
  }
}

/// An image from the network that draws at once when it was drawn before. Until `url` arrives
/// it shows `standIn` if that is in memory, such as the small artwork a card showed before its
/// page asked for the large one, and otherwise `placeholder`.
public struct CachedImage<Content: View, Placeholder: View>: View {
  let url: URL
  var standIn: URL?
  @ViewBuilder let content: (Image) -> Content
  @ViewBuilder let placeholder: () -> Placeholder
  /// The last URL that finished loading, so the view draws again when it lands in the cache.
  @State private var loaded: URL?

  public init(
    url: URL, standIn: URL? = nil, @ViewBuilder content: @escaping (Image) -> Content,
    @ViewBuilder placeholder: @escaping () -> Placeholder
  ) {
    self.url = url
    self.standIn = standIn
    self.content = content
    self.placeholder = placeholder
  }

  public var body: some View {
    let images = ArtworkImages.shared
    let _ = loaded
    Group {
      if let image = images.image(url) ?? standIn.flatMap(images.image) {
        content(image)
      } else {
        placeholder()
      }
    }
    .task(id: url) {
      // Another view may have loaded the same URL first; `load` then returns at once, and
      // setting `loaded` still draws this view again.
      if await images.load(url) != nil { loaded = url }
    }
  }
}
