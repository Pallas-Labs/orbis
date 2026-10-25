import Foundation
import MusicKit

/// Whether this device can play Apple Music Sets (ADR 0021). Playing one needs the person's
/// leave to use Apple Music and an account that can play the catalog.
enum AppleMusicAccess: Equatable {
  /// Not asked yet. The Set page offers Play, and the first Play asks.
  case unknown
  case allowed
  /// The person refused access, or a restriction refuses it.
  case refused
  /// Access is allowed, but the account cannot play the catalog: it has no subscription.
  case noSubscription

  /// Whether the Set page offers Play. Once the answer is no, it offers Open in Apple Music.
  var offersPlay: Bool { self == .unknown || self == .allowed }
}

/// How the app learns its Apple Music access. The system's asks MusicKit; a test passes its own.
struct AppleMusicAuthorization: Sendable {
  /// The access as it stands, without asking the person.
  var current: @Sendable () async -> AppleMusicAccess
  /// Asks the person when they have not been asked, then checks the account.
  var request: @Sendable () async -> AppleMusicAccess

  static let system = AppleMusicAuthorization(
    current: {
      switch MusicAuthorization.currentStatus {
      case .notDetermined: .unknown
      case .authorized: await subscription()
      default: .refused
      }
    },
    request: {
      let status =
        MusicAuthorization.currentStatus == .notDetermined
        ? await MusicAuthorization.request() : MusicAuthorization.currentStatus
      return status == .authorized ? await subscription() : .refused
    })

  /// Whether the account can play the catalog. A check that fails reads as no subscription,
  /// because the Set could not play either way.
  private static func subscription() async -> AppleMusicAccess {
    guard let subscription = try? await MusicSubscription.current else { return .noSubscription }
    return subscription.canPlayCatalogContent ? .allowed : .noSubscription
  }
}
