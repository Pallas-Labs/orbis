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

  private init() {
    cache.countLimit = 300
  }

  func image(_ url: URL) -> Image? {
    cache.object(forKey: url as NSURL).map(Image.init)
  }

  /// Fetches and decodes off the main thread, so the first frame that draws the image does not
  /// pay for decoding it.
  func load(_ url: URL) async -> Image? {
    if let image = image(url) { return image }
    guard let decoded = await Self.fetch(url) else { return nil }
    cache.setObject(decoded, forKey: url as NSURL)
    return Image(decoded)
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
      guard images.image(url) == nil else { return }
      if await images.load(url) != nil { loaded = url }
    }
  }
}
