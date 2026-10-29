import Foundation
import OrbisDesign

/// The link a signed-out device's QR code holds, `https://orbis.p11a.xyz/pair#<Approval Code>`
/// (ADR 0022), and the `orbis://pair#<code>` form the lane opens, because a simulator cannot
/// verify the domain. The code rides in the fragment, so no browser sends it to a server.
nonisolated enum ApprovalLink {
  static let host = "orbis.p11a.xyz"

  /// The fragment of `https://orbis.p11a.xyz/<path>#…` or `orbis://<path>#…`, or nil for any
  /// other address.
  static func fragment(of url: URL, path: String) -> String? {
    switch url.scheme?.lowercased() {
    case "https":
      guard url.host()?.lowercased() == host,
        url.pathComponents.filter({ $0 != "/" }) == [path]
      else { return nil }
    case "orbis":
      guard url.host() == path, url.path().isEmpty else { return nil }
    default:
      return nil
    }
    return url.fragment(percentEncoded: false)
  }

  /// The Approval Code a link carries, or nil for any other address.
  static func code(in url: URL) -> String? {
    guard let fragment = fragment(of: url, path: "pair") else { return nil }
    let code = fragment.filter { $0 != " " }
    guard code.wholeMatch(of: /[0-9]{6}/) != nil else { return nil }
    return code
  }

  /// `482719` as `482 719`, the way the TV shows it.
  static func formatted(_ code: String) -> String {
    code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
  }
}

/// The link a Host shares to invite a friend, `https://orbis.p11a.xyz/join#<Group Passcode>`
/// (PAL-1005 §2.3), and the `orbis://join#<passcode>` form the lane opens. The passcode rides in
/// the fragment, so no browser sends it to a server.
nonisolated enum JoinLink {
  static let host = ApprovalLink.host

  /// The link to share for a passcode.
  static func url(forPasscode passcode: String) -> URL {
    URL(string: "https://\(host)/join#\(passcode)")!
  }

  /// The text "Invite a Friend" shares: the TestFlight step first, because the link only opens
  /// Orbis once it is installed, then the link.
  static func invitation(passcode: String) -> String {
    """
    Join me on Orbis.

    1. On your iPhone, open the TestFlight email from Apple and install Orbis.
    2. Then tap this link: \(url(forPasscode: passcode).absoluteString)
    """
  }

  /// The Group Passcode a link carries, in capitals, or nil for any other address.
  static func passcode(in url: URL) -> String? {
    guard let fragment = ApprovalLink.fragment(of: url, path: "join") else { return nil }
    let format = CodeFormat.groupPasscode
    // Every character must belong to the passcode: a dropped 0 or O would join with a passcode
    // the Host never shared.
    let kept = fragment.uppercased().filter { $0 != "-" && $0 != " " }
    guard kept.count == format.length, kept.allSatisfy(format.alphabet.contains) else { return nil }
    return kept
  }
}

/// A request to approve another device: its code, how the Person reached it, and how far it got.
struct Approval: Equatable {
  /// A link opens the sheet over the app; a code typed in Settings opens it over Settings.
  enum Origin: Equatable {
    case link
    case typed
  }

  enum Step: Equatable {
    /// The link arrived on a signed-out device. The sheet waits until the Person signs in.
    case awaitingSignIn
    case finding
    case found(ApprovalRequest)
    case approving(ApprovalRequest)
    case approved(ApprovalRequest)
    /// No live request holds the code: it expired, it was used, or it was never issued.
    case expired
    case failed(OrbisFailure)
  }

  let code: String
  let origin: Origin
  var step: Step
  /// Who the device signs in as, named on the button.
  var username: String?

  var isPresentable: Bool { step != .awaitingSignIn }
}

extension AppModel {
  /// Opens the approve sheet for the code an Approval link carries.
  func openApproval(_ code: String) async {
    approval = Approval(code: code, origin: .link, step: isConfigured ? .finding : .awaitingSignIn)
    await findApproval()
  }

  /// Looks up a code the Person typed in Add a Device.
  func findApproval(typed code: String) async {
    approval = Approval(code: code, origin: .typed, step: .finding)
    await findApproval()
  }

  /// Finds the request the current approval names, and who would approve it. Signing in calls
  /// this again for a link that arrived while signed out.
  func findApproval() async {
    guard let client, var current = approval,
      current.step == .finding || current.step == .awaitingSignIn
    else { return }
    current.step = .finding
    approval = current
    let code = current.code
    do {
      async let request = client.findSignInRequest(code: code)
      async let me = client.me()
      let (found, person) = try await (request, me)
      update(code) {
        $0.step = .found(found)
        $0.username = person.username
      }
    } catch {
      fail(code, with: error)
    }
  }

  /// Signs the other device in as this Person. The device collects its key on its open wait.
  func approve() async {
    guard let client, let current = approval, case .found(let request) = current.step else { return }
    update(current.code) { $0.step = .approving(request) }
    do {
      let approved = try await client.approveSignInRequest(code: current.code)
      update(current.code) { $0.step = .approved(approved) }
    } catch {
      fail(current.code, with: error)
    }
  }

  /// Looks the code up again after a failure, from the start.
  func retryApproval() async {
    guard let current = approval, case .failed = current.step else { return }
    update(current.code) { $0.step = .finding }
    await findApproval()
  }

  /// Closes the sheet. Nothing is sent: an unapproved request expires by itself.
  func dismissApproval() {
    approval = nil
  }

  /// Changes the approval only while it is still the one for `code`, so an answer to a request the
  /// Person already left never reaches a newer one.
  private func update(_ code: String, _ change: (inout Approval) -> Void) {
    guard var current = approval, current.code == code else { return }
    change(&current)
    approval = current
  }

  private func fail(_ code: String, with error: any Error) {
    if case .cancelled? = error as? OrbisError { return }
    update(code) {
      if case .server(404, _)? = error as? OrbisError {
        $0.step = .expired
      } else {
        $0.step = .failed(.explaining(error, at: serviceAddress))
      }
    }
  }
}
