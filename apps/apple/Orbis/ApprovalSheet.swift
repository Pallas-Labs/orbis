import OrbisDesign
import SwiftUI

/// "Sign in Apple TV?": the device waiting with a code, so the Person can match it to the one in
/// front of them, and a button that names the account it gets (ADR 0022). Cancel sends nothing.
struct ApprovalSheet: View {
  let model: AppModel

  var body: some View {
    Group {
      if let approval = model.approval {
        content(approval)
      }
    }
    .multilineTextAlignment(.center)
    .padding(24)
    .frame(maxWidth: 420)
    #if os(iOS)
      .presentationDetents([.medium])
    #endif
  }

  @ViewBuilder
  private func content(_ approval: Approval) -> some View {
    switch approval.step {
    case .awaitingSignIn, .finding:
      ProgressView("Finding the device…")
        .accessibilityIdentifier("approval-finding")
    case .found(let request), .approving(let request):
      asking(request, username: approval.username, isApproving: approval.step == .approving(request))
    case .approved(let request):
      VStack(spacing: 16) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 48))
          .foregroundStyle(Color.orbis.tint)
          .accessibilityHidden(true)
        Text("\(Self.name(request.platform)) is signed in")
          .font(.title2.weight(.semibold))
          .accessibilityIdentifier("approval-approved")
        Text("You can sign it out in Settings.")
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
        close("Done", identifier: "approval-done")
      }
    case .expired:
      VStack(spacing: 16) {
        Image(systemName: "clock.badge.xmark")
          .font(.system(size: 44))
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        Text("This code has expired. Check the TV for a new one.")
          .font(.orbis.body)
          .accessibilityIdentifier("approval-expired")
        close("OK", identifier: "approval-done")
      }
    case .failed(let failure):
      VStack(spacing: 16) {
        FailureRows(failure: failure, context: "approving a device", identifier: "approval-error")
        Button("Try Again") { Task { await model.retryApproval() } }
          .buttonStyle(.orbisPrimary)
          .accessibilityIdentifier("approval-retry")
        close("Cancel", identifier: "approval-cancel")
      }
    }
  }

  private func asking(_ request: ApprovalRequest, username: String?, isApproving: Bool) -> some View {
    // A device clock ahead of the service's would otherwise say "in 2 seconds".
    let asked = min(SetPresentation.date(from: request.requestedAt), .now)
    return VStack(spacing: 12) {
      Image(systemName: Self.symbol(request.platform))
        .font(.system(size: 44))
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
      Text("Sign in \(Self.name(request.platform))?")
        .font(.title2.weight(.semibold))
        .accessibilityIdentifier("approval-title")
      Text(request.label)
        .font(.orbis.body)
        .accessibilityIdentifier("approval-label")
      Text("Asked \(Text(asked, style: .relative)) ago")
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("approval-age")
      Text(ApprovalLink.formatted(request.code))
        .font(.system(.title, design: .monospaced).weight(.semibold))
        .accessibilityLabel("Code \(ApprovalLink.formatted(request.code))")
        .accessibilityIdentifier("approval-code")
      Text("Only sign in \(Self.noun(request.platform)) that is in front of you.")
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
      Button {
        Task { await model.approve() }
      } label: {
        Group {
          if isApproving {
            ProgressView()
          } else {
            Text(username.map { "Sign In as \($0)" } ?? "Sign In")
          }
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.orbisPrimary)
      .controlSize(.large)
      .disabled(isApproving)
      .accessibilityIdentifier("approval-approve")
      .padding(.top, 8)
      close("Cancel", identifier: "approval-cancel")
        .disabled(isApproving)
    }
  }

  private func close(_ title: String, identifier: String) -> some View {
    Button(title) { model.dismissApproval() }
      .accessibilityIdentifier(identifier)
  }

  private static func name(_ platform: String) -> String {
    switch platform {
    case "tvOS": "Apple TV"
    case "iOS": "iPhone"
    case "macOS": "Mac"
    default: "Browser"
    }
  }

  private static func noun(_ platform: String) -> String {
    switch platform {
    case "tvOS": "a TV"
    case "iOS": "an iPhone"
    case "macOS": "a Mac"
    default: "a browser"
    }
  }

  private static func symbol(_ platform: String) -> String {
    switch platform {
    case "tvOS": "appletv"
    case "iOS": "iphone"
    case "macOS": "laptopcomputer"
    default: "globe"
    }
  }
}

extension View {
  /// Presents the approval sheet here for the approvals `shows` admits, so a link and a typed
  /// code each open it over the screen the Person is on.
  func approvalSheet(_ model: AppModel, shows: @escaping (Approval) -> Bool) -> some View {
    sheet(
      isPresented: Binding(
        get: { model.approval.map { $0.isPresentable && shows($0) } ?? false },
        set: { if !$0 { model.dismissApproval() } })
    ) {
      ApprovalSheet(model: model)
    }
  }
}
