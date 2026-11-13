@testable import OrbisKit

#if os(macOS)
  import AppKit
  import SwiftUI
  import XCTest

  @testable import Orbis

  /// Files a pasted batch against the lane's real service, and keeps a picture of the Mac window
  /// before and after the import. Run with `node scripts/native-lanes.mjs --unit --macos --only
  /// OrbisTests/BulkImportLaneTests`; the pictures are exported with the lane's attachments.
  @MainActor
  final class BulkImportLaneTests: XCTestCase {
    func testAPastedBatchIsFiledWithItsTagsAndTheRestAreSkipped() async throws {
      let environment = ProcessInfo.processInfo.environment
      guard let address = environment["ORBIS_UI_TEST_ADDRESS"].flatMap(URL.init(string:)),
        let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
      else { throw XCTSkip("Run through native-lanes, which supplies the lane service") }
      let client = OrbisClient(address: address, token: token)
      // One Set is in the Library before the paste, so its row is skipped rather than filed.
      _ = try? await client.save(url: "https://www.youtube.com/watch?v=laneMix0003")
      let model = AppModel(client: client, settings: MemoryClientSettings())
      model.library = .loaded(try await client.library())
      let filed = try await client.library().map(\.url)

      let importer = BulkImport()
      importer.text = """
        Friday's mixes:
        https://youtu.be/laneMix0001, https://www.youtube.com/watch?v=laneMix0002
        https://youtube.com/watch?v=laneMix0001&t=60 and https://example.com/a-mix
        https://www.youtube.com/watch?v=laneMix0003
        https://www.youtube.com/playlist?list=PLorbisLaneMix
        """
      importer.tags = ["bulk-lane"]
      let window = BulkImportWindow(model: model, importer: importer)
      try await attachPicture(of: window, named: "bulk-import-before")

      await importer.run(client: client, filed: filed)

      let outcomes = try XCTUnwrap(importer.results).map(\.outcome)
      XCTAssertEqual(outcomes.count, 6)
      guard case .filed(let first, _) = outcomes[0], case .filed(let second, _) = outcomes[1]
      else { return XCTFail("the first two links were not filed: \(outcomes)") }
      XCTAssertEqual(first, "Sunrise on the Pier")
      XCTAssertEqual(second, "Low Tide Dub")
      XCTAssertEqual(
        Array(outcomes[2...]),
        [
          .skipped("Already in this paste"),
          .skipped(BulkLinks.unsupportedHost),
          .skipped("Already in your Library"),
          .skipped(BulkLinks.notASet),
        ])

      // The service holds what the window says: two new Sets, each with the batch's Tag.
      let library = try await client.library()
      let tagged = library.filter { $0.tags.contains("bulk-lane") }.map(\.title).sorted()
      XCTAssertEqual(tagged, ["Low Tide Dub", "Sunrise on the Pier"])
      model.library = .loaded(library)
      try await attachPicture(of: window, named: "bulk-import-after")
    }

    /// Draws the window's content offscreen and attaches it as a PNG. Liquid Glass is drawn by
    /// the window server, so the Tag chips are missing from the picture.
    private func attachPicture(of view: some View, named name: String) async throws {
      // Taller than the window opens, so every row is in the picture.
      let size = CGSize(width: 640, height: 1000)
      let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
      host.frame = CGRect(origin: .zero, size: size)
      let window = NSWindow(
        contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.appearance = NSAppearance(named: .aqua)
      window.contentView = host
      host.layoutSubtreeIfNeeded()
      // SwiftUI draws on the next pass of the run loop.
      try await Task.sleep(for: .milliseconds(500))
      host.layoutSubtreeIfNeeded()
      let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: rep)
      let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
      let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
      attachment.name = "\(name).png"
      attachment.lifetime = .keepAlways
      add(attachment)
      window.close()
    }
  }
#endif
