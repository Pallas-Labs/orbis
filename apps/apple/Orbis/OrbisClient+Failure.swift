import Foundation
import OrbisDesign
import OrbisKit

extension OrbisError {
  /// `address` is where the app was looking. Anything other than Orbis answering is the first
  /// thing worth knowing, and the person reading the screen can check it in one look.
  func failure(at address: URL? = nil) -> OrbisFailure {
    var failure: OrbisFailure
    switch self {
    case .unreachable:
      failure = OrbisFailure(
        title: "Cannot reach your library",
        message: message,
        symbol: "wifi.exclamationmark",
        isRetryable: true
      )
    case .notSignedIn:
      failure = OrbisFailure(
        title: "This device is not signed in",
        message: message,
        symbol: "key.slash",
        isRetryable: false
      )
    case .malformed:
      failure = OrbisFailure(
        title: "Orbis sent an answer this app cannot read",
        message: message,
        symbol: "doc.questionmark",
        isRetryable: false
      )
    case .server(let status, _):
      failure = OrbisFailure(
        title: "Your library reported an error",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: status >= 500
      )
    case .notOrbis:
      failure = OrbisFailure(
        title: "A web page answered, not Orbis",
        message: message,
        symbol: "globe",
        isRetryable: false
      )
    case .storageRefused:
      failure = OrbisFailure(
        title: "This device could not save the key",
        message: message,
        symbol: "key.slash",
        isRetryable: true
      )
    case .duplicate, .cancelled:
      failure = OrbisFailure(
        title: "Something went wrong",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: true
      )
    }
    failure.address = address?.absoluteString
    return failure
  }
}

extension OrbisFailure {
  /// What a sign-in or Settings request failed with. The service explains a refusal, such as a
  /// wrong Group Passcode, a taken username, or an expired code, in a sentence meant for the
  /// person, so that sentence is shown as it came.
  static func explaining(_ error: any Error, at address: URL) -> OrbisFailure {
    let known = (error as? OrbisError) ?? .unreachable
    guard case .server(let status, let message) = known, (400..<500).contains(status),
      !message.isEmpty
    else { return known.failure(at: address) }
    return OrbisFailure(
      title: "Orbis could not do that", message: message, symbol: "hand.raised",
      isRetryable: status == 429, address: address.absoluteString)
  }
}

extension CodeFormat {
  /// The service's alphabet for codes a person types: no 0/O or 1/I/L look-alikes.
  private static let typable = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

  /// A Sign-in Code: two groups of four.
  static let signInCode = CodeFormat(alphabet: typable, groups: [4, 4])
  /// A Group Passcode: three groups of four.
  static let groupPasscode = CodeFormat(alphabet: typable, groups: [4, 4, 4])
}
