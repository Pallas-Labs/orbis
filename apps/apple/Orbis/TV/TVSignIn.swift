import OrbisKit
#if os(tvOS)
  import CoreImage.CIFilterBuiltins
  import OrbisDesign
  import SwiftUI

  /// The signed-out TV (ADR 0022): one screen with a QR code and, beside it, the same Approval
  /// Code in six slots. A signed-in Person scans the code or types it on their phone and approves,
  /// and the TV signs in with the key the approval delivers. The Group Passcode and Sign-in Code
  /// forms are under Other Ways to Sign In.
  struct TVSignIn: View {
    let model: AppModel
    @State private var requests = ApprovalRequests()
    @State private var path: [Route] = []

    enum Route: Hashable {
      case otherWays
      case join
      case code
    }

    var body: some View {
      NavigationStack(path: $path) {
        approval
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .otherWays: OtherWaysToSignIn(path: $path)
            case .join: JoinForm(model: model)
            case .code: CodeForm(model: model)
            }
          }
      }
      .preferredColorScheme(.dark)
      // On the stack rather than the first page, so the TV keeps asking while a form is open.
      // Keyed to the attempt, so Show a New Code starts the limit again.
      .task(id: requests.attempt) { await requests.ask(model) }
    }

    private var approval: some View {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 28) {
          Image("OrbMark")
            .resizable()
            .frame(width: 80, height: 80)
            .clipShape(.circle)
            .accessibilityHidden(true)
          Text("Sign in to Orbis")
            .font(.orbis.largeTitle)
            .accessibilityAddTraits(.isHeader)
        }
        Spacer()
        Group {
          if requests.phase == .stopped {
            stopped
          } else {
            choices
          }
        }
        .frame(maxWidth: .infinity)
        Spacer()
        Button("Other Ways to Sign In") { path.append(.otherWays) }
          .font(.orbis.label)
          .accessibilityIdentifier("signin-other-ways")
          .frame(maxWidth: .infinity)
      }
      .background { SignInField(moves: requests.phase != .stopped) }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-sign-in")
    }

    /// Scan or type: two ways to the same request, side by side, so neither reads as a step.
    private var choices: some View {
      VStack(spacing: 48) {
        HStack(spacing: 72) {
          VStack(spacing: 28) {
            PairQRCode(code: requests.code)
            Text("Scan with your iPhone")
          }
          Text("or")
            .foregroundStyle(.secondary)
          VStack(spacing: 28) {
            ApprovalCodeSlots(code: requests.code)
            Text("In Orbis on your phone,\ntap Settings › Add a Device")
              .multilineTextAlignment(.center)
          }
        }
        .font(.orbis.body)
        if let failure = requests.failure {
          Text(failure.message)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("approval-error")
        }
      }
    }

    private var stopped: some View {
      VStack(spacing: 40) {
        Text("The code expired.")
          .font(.orbis.sectionTitle)
        Button("Show a New Code") { requests.showNewCode() }
          .accessibilityIdentifier("approval-new-code")
        // A key the approval delivered that this TV would not keep.
        if let failure = model.signInFailure {
          Text(failure.message)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  /// Keeps one Approval Request live while the sign-in screen is up: a new request replaces each
  /// one that expires, until a Person approves one or the TV has asked for 15 minutes.
  @MainActor
  @Observable
  final class ApprovalRequests {
    enum Phase: Equatable {
      /// A request is on its way, so there is no code to show.
      case starting
      case showing(code: String)
      /// The TV asked for as long as it asks, and no one approved.
      case stopped
    }

    private(set) var phase: Phase = .starting
    /// Why the last request failed. The TV tries again by itself, so this is only said.
    private(set) var failure: OrbisFailure?
    /// Changes when the Person asks for a new code, which starts the asking again.
    private(set) var attempt = 0

    var code: String? {
      guard case .showing(let code) = phase else { return nil }
      return code
    }

    func showNewCode() {
      phase = .starting
      failure = nil
      attempt += 1
    }

    /// How long the TV keeps asking: 15 minutes. A Debug journey shortens it with
    /// `-orbisApprovalLimitSeconds <seconds>`.
    private static var limit: Duration {
      #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let flag = arguments.firstIndex(of: "-orbisApprovalLimitSeconds"),
          arguments.indices.contains(flag + 1), let seconds = Int(arguments[flag + 1])
        {
          return .seconds(seconds)
        }
      #endif
      return .seconds(15 * 60)
    }

    private struct Approval: Sendable {
      let key: String
      let username: String
    }

    /// Asks until a Person approves, then signs in, or until the limit, then stops.
    func ask(_ model: AppModel) async {
      let limit = Self.limit
      let approval = await withTaskGroup(of: Approval?.self) { group in
        group.addTask { await self.keepAsking(model) }
        group.addTask {
          try? await Task.sleep(for: limit)
          return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
      }
      guard let approval else {
        // A cancelled task means the screen went away, not that the limit passed.
        if !Task.isCancelled {
          phase = .stopped
          failure = nil
        }
        return
      }
      // In its own task: signing in replaces this screen, which cancels the task this runs in,
      // and the library's first load must not go with it.
      await Task {
        await model.signIn(.approved(key: approval.key, username: approval.username))
      }.value
      if !model.isConfigured {
        phase = .stopped
      }
    }

    private func keepAsking(_ model: AppModel) async -> Approval? {
      let client = model.signedOutClient
      let label = String(AppModel.deviceLabel.prefix(100))
      while !Task.isCancelled {
        do {
          let request = try await client.startApprovalRequest(label: label, platform: "tvOS")
          phase = .showing(code: request.code)
          failure = nil
          if let approval = try await waitForApproval(of: request, client) {
            return approval
          }
        } catch OrbisError.cancelled {
          return nil
        } catch {
          // The code on screen may be dead with the connection, so it goes until a new one comes.
          phase = .starting
          failure = OrbisFailure.explaining(error, at: model.serviceAddress)
          // A TV that has just woken may not have its network yet.
          try? await Task.sleep(for: .seconds(10))
        }
      }
      return nil
    }

    /// Waits on one request: the approval, or nil once it expires.
    private func waitForApproval(
      of request: StartedApprovalRequest, _ client: OrbisClient
    ) async throws -> Approval? {
      while true {
        switch try await client.waitForApproval(secret: request.secret) {
        case .pending:
          continue
        case .approved(let key, let username):
          return Approval(key: key, username: username)
        case .expired:
          return nil
        }
      }
    }
  }

  /// The QR code for the request's `/pair` link, which the iPhone Camera opens in Orbis.
  private struct PairQRCode: View {
    let code: String?

    private static let context = CIContext()

    var body: some View {
      let link = code.map(OrbisService.pairLink(code:))
      ZStack {
        RoundedRectangle(cornerRadius: 24).fill(.white)
        if let link, let image = Self.image(encoding: link.absoluteString) {
          Image(decorative: image, scale: 1)
            .interpolation(.none)
            .resizable()
            .scaledToFit()
            .padding(24)
        } else {
          ProgressView().tint(.black)
        }
      }
      .frame(width: 360, height: 360)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("QR code to sign in")
      .accessibilityValue(link?.absoluteString ?? "")
      .accessibilityIdentifier("approval-qr")
    }

    private static func image(encoding text: String) -> CGImage? {
      let filter = CIFilter.qrCodeGenerator()
      filter.message = Data(text.utf8)
      filter.correctionLevel = "M"
      guard let output = filter.outputImage else { return nil }
      // Scaled here by whole pixels, so every module stays a sharp square at any size.
      let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
      return context.createCGImage(scaled, from: scaled.extent)
    }
  }

  /// The Approval Code as six slots in two groups of three. The gap is space, not a character.
  private struct ApprovalCodeSlots: View {
    let code: String?

    var body: some View {
      let digits = Array(code ?? "")
      HStack(spacing: 14) {
        ForEach(0..<6, id: \.self) { index in
          Text(digits.indices.contains(index) ? String(digits[index]) : " ")
            .font(.orbis.timecode.monospaced())
            .contentTransition(.numericText())
            .frame(width: 88, height: 112)
            .background(.white.opacity(0.08), in: .rect(cornerRadius: 16))
            .overlay {
              RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.2), lineWidth: 2)
            }
            .padding(.trailing, index == 2 ? 24 : 0)
        }
      }
      .animation(.default, value: code)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Code")
      .accessibilityValue(digits.map(String.init).joined(separator: " "))
      .accessibilityIdentifier("approval-code")
    }
  }

  /// The two ways in that need typing on the TV (ADR 0020).
  private struct OtherWaysToSignIn: View {
    @Binding var path: [TVSignIn.Route]

    var body: some View {
      VStack(spacing: 24) {
        Button {
          path.append(.join)
        } label: {
          Text("I Have a Group Passcode").frame(maxWidth: .infinity)
        }
        .buttonStyle(.orbisPrimary)
        .accessibilityIdentifier("signin-new")
        Button {
          path.append(.code)
        } label: {
          Text("I Have a Sign-in Code").font(.orbis.body.weight(.semibold)).frame(maxWidth: .infinity)
        }
        .buttonStyle(.orbisSecondary)
        .accessibilityIdentifier("signin-have-code")
      }
      .frame(maxWidth: 720)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { SignInField() }
      .navigationTitle("Other Ways to Sign In")
    }
  }
#endif
