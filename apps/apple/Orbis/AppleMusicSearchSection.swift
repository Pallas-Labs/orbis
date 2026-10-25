import OrbisDesign
import SwiftUI

/// Find on Apple Music, in Add Set. The service searches the US catalog and puts DJ mixes first.
/// Choosing an album saves its link through the ordinary save, so it is the same Set a shared
/// link makes (ADR 0021).
struct AppleMusicSearchSection: View {
  @Bindable var model: AppModel
  @FocusState private var isTyping: Bool

  var body: some View {
    Section {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        TextField("DJ, mix series, or label", text: $model.appleMusicWords)
          .autocorrectionDisabled()
          .submitLabel(.search)
          .focused($isTyping)
          .onSubmit {
            // The keyboard would cover the results it was asked for.
            isTyping = false
            Task { await model.searchAppleMusic() }
          }
          .accessibilityLabel("Find on Apple Music")
          .accessibilityIdentifier("apple-music-field")
      }
      results
    } header: {
      Text("Find on Apple Music")
    } footer: {
      if model.appleMusicSearch == .idle {
        Text("Searches Apple Music in the US. DJ mixes come first. Choose one to add it as a Set.")
      }
    }
  }

  @ViewBuilder private var results: some View {
    switch model.appleMusicSearch {
    case .idle:
      EmptyView()
    case .searching:
      WorkingRow(title: "Searching Apple Music…")
    case .failed(let message):
      Label(message, systemImage: "exclamationmark.triangle")
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("apple-music-failure")
    case .found(let albums):
      let shown = model.showsAllAlbums ? albums : albums.filter(\.djMix)
      if !albums.isEmpty {
        Toggle("All Albums", isOn: $model.showsAllAlbums)
          .accessibilityIdentifier("apple-music-all-albums")
      }
      if shown.isEmpty {
        Text(
          albums.isEmpty
            ? "Apple Music has no albums for these words."
            : "No DJ mixes. Turn on All Albums to see the other \(albums.count)."
        )
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("apple-music-none")
      }
      if let failure = model.appleMusicSaveFailure {
        Label(failure, systemImage: "exclamationmark.triangle")
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("apple-music-save-failure")
      }
      ForEach(shown) { album in
        AppleMusicResultRow(album: album, isSaving: model.isFiling) {
          Task { await model.saveAppleMusicAlbum(album) }
        }
      }
    }
  }
}

private struct AppleMusicResultRow: View {
  let album: AppleMusicAlbum
  let isSaving: Bool
  let save: () -> Void

  var body: some View {
    Button(action: save) {
      HStack(spacing: 12) {
        Artwork(url: album.artworkUrl.flatMap(URL.init(string:)), seed: album.title)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(album.title)
            .font(.orbis.rowTitle)
            .lineLimit(2)
          Text(detail)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        if album.inLibrary {
          Label("In Library", systemImage: "checkmark.circle.fill")
            .labelStyle(.iconOnly)
            .foregroundStyle(Color.orbis.tint)
        } else {
          Image(systemName: "plus.circle")
            .foregroundStyle(Color.orbis.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(album.inLibrary || isSaving)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(album.title)
    .accessibilityValue(album.inLibrary ? "In Library" : detail)
    .accessibilityHint(album.inLibrary ? "" : "Adds this album to your Library as a Set.")
    .accessibilityIdentifier("apple-music-result")
  }

  /// "Seth Troxler · 2015 · 18 songs · 1h 19m", with only the parts Apple gave.
  private var detail: String {
    var parts: [String] = []
    if let creator = album.creator, !creator.isEmpty { parts.append(creator) }
    if let released = album.releasedAt { parts.append(String(released.prefix(4))) }
    parts.append(album.songCount == 1 ? "1 song" : "\(album.songCount) songs")
    if let seconds = album.durationSeconds, seconds > 0 { parts.append(SetPresentation.length(seconds)) }
    return parts.joined(separator: " · ")
  }
}

extension AppModel {
  /// Searches for the words in the field. An answer for words since replaced is dropped.
  func searchAppleMusic() async {
    guard let client else { return }
    let words = appleMusicWords.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else { return }
    let asked = AppleMusicSearch.searching(words: words)
    appleMusicSearch = asked
    appleMusicSaveFailure = nil
    let answer: AppleMusicSearch
    do {
      answer = .found(try await client.searchAppleMusic(words))
    } catch OrbisError.cancelled {
      answer = .idle
    } catch OrbisError.server(_, let message) where !message.isEmpty {
      // The service's own sentence, such as "Apple Music search is not set up on this server."
      answer = .failed(message: message)
    } catch let error as OrbisError {
      answer = .failed(message: error.message)
    } catch {
      answer = .failed(message: OrbisError.unreachable.message)
    }
    guard appleMusicSearch == asked, self.client?.token == client.token else { return }
    appleMusicSearch = answer
  }

  /// Saves a found album as a Set through the ordinary save, which reads it again on the
  /// service, then opens the naming step and marks the album saved in the results. The link
  /// field keeps whatever was typed there.
  func saveAppleMusicAlbum(_ album: AppleMusicAlbum) async {
    guard let client, !isFiling, !album.inLibrary else { return }
    isFiling = true
    appleMusicSaveFailure = nil
    defer { isFiling = false }
    do {
      let saved = try await client.save(url: album.url)
      guard self.client?.token == client.token else { return }
      markSaved(album)
      await reveal(filed: saved)
    } catch OrbisError.duplicate {
      markSaved(album)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      guard self.client?.token == client.token else { return }
      appleMusicSaveFailure = error.message
    } catch {
      appleMusicSaveFailure = OrbisError.unreachable.message
    }
  }

  private func markSaved(_ album: AppleMusicAlbum) {
    guard case .found(var albums) = appleMusicSearch,
      let index = albums.firstIndex(where: { $0.id == album.id })
    else { return }
    albums[index].inLibrary = true
    appleMusicSearch = .found(albums)
  }
}
