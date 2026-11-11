#if os(macOS)
  import OrbisDesign
  import SwiftUI

  /// The Mac window that files many pasted links at once, with one set of Tags for all of them.
  struct BulkImportWindow: View {
    static let id = "bulk-import"

    @Bindable var model: AppModel
    @State private var importer: BulkImport

    init(model: AppModel, importer: BulkImport = BulkImport()) {
      self.model = model
      _importer = State(initialValue: importer)
    }

    var body: some View {
      let rows = importer.rows(filed: filedLinks)
      Form {
        Section {
          TextEditor(text: $importer.text)
            .font(.body.monospaced())
            .frame(minHeight: 110)
            .scrollContentBackground(.hidden)
            .disabled(importer.results != nil)
            .accessibilityLabel("Links")
            .accessibilityIdentifier("bulk-import-text")
        } header: {
          Text("Links")
        } footer: {
          Text(
            "Paste YouTube, SoundCloud, or Apple Music links, one per line or separated by spaces or commas. Orbis ignores any other text."
          )
        }
        TagListEditor(
          tags: $importer.tags,
          suggestions: model.availableTags,
          title: "Tags for every Set",
          category: SetPresentation.category(for:)
        )
        if !rows.isEmpty {
          Section {
            ForEach(rows) { BulkImportRow(row: $0) }
          } header: {
            Text(Self.summary(rows))
              .accessibilityIdentifier("bulk-import-summary")
          }
        }
      }
      .formStyle(.grouped)
      .safeAreaInset(edge: .bottom) { actions(rows) }
      .frame(minWidth: 520, minHeight: 520)
    }

    private var filedLinks: [String] {
      if case .loaded(let sets) = model.library { sets.map(\.url) } else { [] }
    }

    private func actions(_ rows: [BulkImport.Row]) -> some View {
      HStack {
        if model.client == nil {
          Text("Sign in to Orbis to import links.")
            .foregroundStyle(.secondary)
        }
        Spacer()
        if importer.results != nil {
          Button("Import More") { importer.startOver() }
            .disabled(importer.isImporting)
            .accessibilityIdentifier("bulk-import-again")
        } else {
          let count = rows.count(where: { $0.outcome == .waiting })
          Button(count == 1 ? "Import 1 Link" : "Import \(count) Links") {
            guard let client = model.client else { return }
            Task {
              await importer.run(client: client, filed: filedLinks)
              await model.refreshLibraryQuietly()
            }
          }
          .keyboardShortcut(.defaultAction)
          .tint(Color.orbis.tint)
          .disabled(count == 0 || model.client == nil)
          .accessibilityIdentifier("bulk-import-run")
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
      .background(.bar)
    }

    static func summary(_ rows: [BulkImport.Row]) -> String {
      var parts: [String] = []
      func add(_ count: Int, _ word: String) { if count > 0 { parts.append("\(count) \(word)") } }
      add(rows.count(where: { $0.outcome == .waiting }), "to import")
      add(rows.count(where: { $0.outcome == .filing }), "filing")
      add(rows.count(where: { if case .filed = $0.outcome { true } else { false } }), "filed")
      add(rows.count(where: { if case .skipped = $0.outcome { true } else { false } }), "skipped")
      add(rows.count(where: { if case .failed = $0.outcome { true } else { false } }), "failed")
      return parts.joined(separator: " · ")
    }
  }

  struct BulkImportRow: View {
    let row: BulkImport.Row

    var body: some View {
      HStack(spacing: 10) {
        mark
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .lineLimit(1)
            .truncationMode(.middle)
          Text(detail)
            .font(.orbis.detail)
            .foregroundStyle(isFailure ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .lineLimit(2)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("bulk-import-row-\(row.id)")
    }

    private var title: String {
      if case .filed(let title, _) = row.outcome { title } else { row.link }
    }

    private var isFailure: Bool {
      if case .failed = row.outcome { true } else { false }
    }

    private var detail: String {
      let source = row.source?.label
      let status: String =
        switch row.outcome {
        case .waiting: "Ready to import"
        case .filing: "Filing…"
        case .filed(_, let download): ["Filed", download].compactMap { $0 }.joined(separator: " · ")
        case .skipped(let reason): "Skipped: \(reason)"
        case .failed(let message): "Failed: \(message)"
        }
      return [source, status].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private var mark: some View {
      switch row.outcome {
      case .waiting:
        Image(systemName: "circle").foregroundStyle(.tertiary)
      case .filing:
        ProgressView().controlSize(.small)
      case .filed:
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.orbis.tint)
      case .skipped:
        Image(systemName: "minus.circle").foregroundStyle(.secondary)
      case .failed:
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
      }
    }
  }

  /// File > Import Links…, which opens the bulk import window.
  struct BulkImportCommand: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
      CommandGroup(after: .newItem) {
        Button("Import Links…") { openWindow(id: BulkImportWindow.id) }
          .keyboardShortcut("i", modifiers: [.command, .shift])
      }
    }
  }
#endif
