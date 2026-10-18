import OrbisDesign
import SwiftUI

/// The summary's storyboard, in order:
///
/// -   0 ms  the summary replaces the field and the success haptic plays
/// -  80 ms  the mosaic's tiles land one after another, 60 ms apart, growing from 92%
/// - 200 ms  the added count rolls up from zero
///
/// Under Reduce Motion everything is in place at once.
@MainActor
private enum ImportStoryboard {
  static let settle = OrbisCurve.smooth.animation
  static let firstTile = 0.08
  static let tileStagger = 0.06
  static let tileScale = 0.92
  static let countRoll = 0.2
}

/// The Import Playlist sheet on the Playlists screen. The Add Set sheet hosts the same status and
/// summary, so the two paths cannot drift apart.
struct PlaylistImportSheet: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var link = ""
  @State private var focusLink = false

  var body: some View {
    NavigationStack {
      Form {
        if case .imported(let imported) = model.playlistImport {
          PlaylistImportSummary(imported: imported)
        } else {
          Section {
            LinkField(
              link: $link, state: model.playlistImport.fieldState ?? .idle, action: "Import",
              focusRequest: $focusLink
            ) {
              Task { await model.importPlaylist(link: link) }
            }
            .disabled(model.playlistImport.isImporting)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
          } footer: {
            VStack(alignment: .leading, spacing: 10) {
              Text(
                "A YouTube or YouTube Music playlist link. Every track is saved to your Library and kept in order in a new playlist."
              )
              PasteButton(payloadType: String.self) { pasted in
                guard let text = pasted.first else { return }
                link = text.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await model.importPlaylist(link: text) }
              }
              .labelStyle(.titleAndIcon)
              .buttonBorderShape(.capsule)
              .disabled(model.playlistImport.isImporting)
            }
          }
          PlaylistImportStatus(model: model)
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
      .background(Color.orbis.paper.ignoresSafeArea())
      .task { focusLink = true }
      .navigationTitle(model.playlistImport.importedPlaylistId == nil ? "Import Playlist" : "Playlist Imported")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        if model.playlistImport.importedPlaylistId != nil {
          PlaylistImportSummaryToolbar(model: model, close: { dismiss() })
        } else {
          ToolbarItem(placement: .cancellationAction) {
            Button("Close", systemImage: "xmark", role: .close) { dismiss() }
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .playlistImportPresentation(model)
  }
}

/// The progress row while an import runs, and the retry after one fails. The failure's sentence is
/// the link field's, so this adds only what to do next.
struct PlaylistImportStatus: View {
  @Bindable var model: AppModel

  var body: some View {
    switch model.playlistImport {
    case .importing:
      Section {
        WorkingRow(
          title: model.playlistImport.progress ?? "Importing…",
          detail: "You can close this. The import keeps going."
        )
        .accessibilityIdentifier("import-working")
      }
    case .failed(_, let failure):
      Section {
        Button("Try Again", systemImage: "arrow.clockwise") {
          Task { await model.retryPlaylistImport() }
        }
        .foregroundStyle(Color.orbis.tint)
        .accessibilityIdentifier("import-retry")
        if case .request(let error) = failure {
          CopyFailureButton(
            report: FailureReport(failure: error.failure(at: model.serviceAddress), context: "importing a playlist"))
        }
      }
    case .idle, .imported:
      EmptyView()
    }
  }
}

/// What the import did: the new Playlist, how many Sets it holds, and only the notes that apply.
struct PlaylistImportSummary: View {
  let imported: ImportedPlaylist

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var shownCount = 0
  @State private var tilesIn = false

  private struct Note: Identifiable {
    let id: String
    let symbol: String
    let text: String
  }

  var body: some View {
    Section {
      let layout =
        typeSize.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 14))
      layout {
        mosaic
        VStack(alignment: .leading, spacing: 4) {
          Text(imported.playlist.name)
            .font(.orbis.rowTitle)
            .lineLimit(3)
          Text(Self.addedLine(shownCount))
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(shownCount)))
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(imported.playlist.name), \(Self.addedLine(imported.summary.added))")
      .accessibilityIdentifier("import-summary")
      .onAppear(perform: playIn)
    }
    if !notes.isEmpty {
      Section {
        ForEach(notes) { note in
          Label(note.text, systemImage: note.symbol)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("import-note-\(note.id)")
        }
      }
    }
  }

  private static func addedLine(_ count: Int) -> String {
    count == 1 ? "1 set added" : "\(count) sets added"
  }

  private var notes: [Note] {
    var notes: [Note] = []
    if imported.summary.downloading > 0 {
      notes.append(
        Note(
          id: "downloading", symbol: "arrow.down.circle",
          text: "\(imported.summary.downloading) downloading or already downloaded"))
    }
    if imported.summary.waiting > 0 {
      notes.append(
        Note(id: "waiting", symbol: "clock", text: "\(imported.summary.waiting) waiting for the download queue"))
    }
    if imported.summary.unavailable > 0 {
      let them = imported.summary.unavailable == 1 ? "it" : "them"
      notes.append(
        Note(
          id: "unavailable", symbol: "eye.slash",
          text: "\(imported.summary.unavailable) skipped because YouTube no longer serves \(them)"))
    }
    if imported.summary.overLimit > 0 {
      notes.append(
        Note(id: "over-limit", symbol: "number", text: "\(imported.summary.overLimit) left out past the 500-set limit"))
    }
    return notes
  }

  private var mosaic: some View {
    Grid(horizontalSpacing: 2, verticalSpacing: 2) {
      GridRow {
        tile(0)
        tile(1)
      }
      GridRow {
        tile(2)
        tile(3)
      }
    }
    .frame(width: 120)
    .clipShape(.rect(cornerRadius: Radius.button))
    .accessibilityHidden(true)
  }

  /// A playlist shorter than four still fills the square, with placeholders in its own tones.
  private func tile(_ index: Int) -> some View {
    let set = imported.firstSets.indices.contains(index) ? imported.firstSets[index] : nil
    return Artwork(
      url: set.flatMap { SetPresentation.row($0).artwork },
      seed: set?.title ?? "\(imported.playlist.name) \(index)",
      size: .header, cornerRadius: 0
    )
    .scaleEffect(tilesIn || reduceMotion ? 1 : ImportStoryboard.tileScale)
    .opacity(tilesIn ? 1 : 0)
    .animation(
      reduceMotion
        ? nil
        : ImportStoryboard.settle?.delay(ImportStoryboard.firstTile + Double(index) * ImportStoryboard.tileStagger),
      value: tilesIn)
  }

  private func playIn() {
    guard !tilesIn else { return }
    tilesIn = true
    guard !reduceMotion else {
      shownCount = imported.summary.added
      return
    }
    withAnimation(ImportStoryboard.settle?.delay(ImportStoryboard.countRoll)) {
      shownCount = imported.summary.added
    }
  }
}

/// Done closes the sheet; Open Playlist goes to the new Playlist and closes it.
struct PlaylistImportSummaryToolbar: ToolbarContent {
  let model: AppModel
  let close: () -> Void

  var body: some ToolbarContent {
    #if os(macOS)
      // A Mac sheet's bar draws one button per slot, so the two share one item.
      ToolbarItem(placement: .confirmationAction) {
        HStack {
          openButton
          doneButton.buttonStyle(.borderedProminent)
        }
      }
    #else
      ToolbarItem(placement: .primaryAction) { openButton }
      ToolbarItem(placement: .confirmationAction) { doneButton }
    #endif
  }

  private var openButton: some View {
    Button("Open Playlist") {
      model.openImportedPlaylist()
      close()
    }
    .accessibilityIdentifier("import-open")
  }

  private var doneButton: some View {
    Button("Done", systemImage: "checkmark", role: .confirm) {
      model.finishPlaylistImport()
      close()
    }
    .tint(Color.orbis.tint)
    .keyboardShortcut(.defaultAction)
    .accessibilityIdentifier("import-done")
  }
}

extension View {
  /// What every sheet that runs an import shares: a finished import is felt, and closing it leaves
  /// nothing for the next sheet to show. A running import goes on after the sheet closes.
  func playlistImportPresentation(_ model: AppModel) -> some View {
    sensoryFeedback(.success, trigger: model.playlistImport.importedPlaylistId) { _, new in new != nil }
      .onDisappear { model.finishPlaylistImport() }
  }
}
