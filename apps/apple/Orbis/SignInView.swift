import OrbisDesign
import SwiftUI

/// A signed-out device signs in one of two ways (ADR 0020): a new Person joins with the Group
/// Passcode, and someone who already uses Orbis types a Sign-in Code from another device.
struct SignInView: View {
  @Bindable var model: AppModel
  @State private var choice: Choice?

  private enum Choice: Hashable {
    case join
    case code
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        Spacer()
        SignInMark(title: "Orbis")
        Spacer()
        VStack(spacing: 12) {
          if model.approval?.step == .awaitingSignIn {
            Text("Sign in to approve the other device.")
              .font(.orbis.body)
              .multilineTextAlignment(.center)
              .accessibilityIdentifier("signin-approval-notice")
          }
          Button {
            choice = .join
          } label: {
            Text("I Have a Group Passcode").frame(maxWidth: .infinity)
          }
          .buttonStyle(.orbisPrimary)
          .accessibilityIdentifier("signin-new")
          Button {
            choice = .code
          } label: {
            Text("I Have a Sign-in Code").font(.orbis.body.weight(.semibold)).frame(maxWidth: .infinity)
          }
          .buttonStyle(.orbisSecondary)
          .accessibilityIdentifier("signin-have-code")
          if model.openedLink?.state == .awaitingSignIn {
            Text("Sign in to open the shared set.")
              .font(.orbis.detail)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("signin-link-waiting")
          }
        }
        .controlSize(.extraLarge)
        .frame(maxWidth: 360)
        .padding(.bottom, 24)
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // Still while a form covers it: the page underneath is kept, and its timeline with it.
      .background { SignInField(moves: choice == nil) }
      #if os(macOS)
        // The field runs to the window's top edge, as it runs under a phone's status bar, and
        // the orb already names the app, so the title bar carries neither a band nor a title.
        .navigationTitle("")
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
      #endif
      .navigationDestination(item: $choice) { choice in
        switch choice {
        case .join: JoinForm(model: model)
        case .code: CodeForm(model: model)
        }
      }
    }
    // A Join Link opens Join Your Group with its passcode in place, and going back leaves the
    // link behind, so the form asks for the passcode again.
    .onChange(of: model.joinPasscode, initial: true) { _, passcode in
      if passcode != nil { choice = .join }
    }
    .onChange(of: choice) { _, choice in
      if choice != .join { model.joinPasscode = nil }
    }
    // The splash is dark, so the page it hands over to is dark too: a light page here flashed
    // white as the splash faded.
    .preferredColorScheme(.dark)
  }
}

/// The orb from the splash, small, over a title.
private struct SignInMark: View {
  let title: String

  var body: some View {
    VStack(spacing: 16) {
      Image("OrbMark")
        .resizable()
        .frame(width: 88, height: 88)
        .clipShape(.circle)
        .accessibilityHidden(true)
      Text(title)
        .font(.orbis.largeTitle)
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
    }
  }
}

/// The splash's colours as a mesh: the orb's blue and coral at the edges of a near-black field.
/// On the first page and the welcome the colours drift, slowly, so the page looks alive while
/// it waits; on a form, and under Reduce Motion, they hold still.
struct SignInField: View {
  var moves = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let night = Color("LaunchField")
  private static let indigo = Color(red: 0.11, green: 0.11, blue: 0.30)
  private static let periwinkle = Color(red: 0.33, green: 0.34, blue: 0.64)
  private static let coral = Color(red: 0.58, green: 0.25, blue: 0.22)
  private static let colors: [Color] = [
    night, indigo, night,
    periwinkle, night, coral,
    night, indigo, night,
  ]

  var body: some View {
    let isMoving = moves && !reduceMotion
    TimelineView(.animation(minimumInterval: 1 / 30, paused: !isMoving)) { context in
      MeshGradient(
        width: 3, height: 3,
        points: Self.points(at: context.date.timeIntervalSinceReferenceDate),
        colors: Self.colors)
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }

  /// The corners stay put; the edge midpoints slide along their edges and the centre wanders,
  /// each on its own period, so the pattern never visibly repeats.
  private static func points(at time: TimeInterval) -> [SIMD2<Float>] {
    let t = Float(time.truncatingRemainder(dividingBy: 3600)) * 0.45
    return [
      [0, 0], [0.5 + 0.18 * sin(t * 0.9), 0], [1, 0],
      [0, 0.5 + 0.2 * sin(t * 0.7)],
      [0.5 + 0.22 * cos(t * 0.8), 0.5 + 0.18 * sin(t * 1.1)],
      [1, 0.5 + 0.2 * cos(t * 0.6)],
      [0, 1], [0.5 + 0.18 * cos(t * 0.75), 1], [1, 1],
    ]
  }
}

struct JoinForm: View {
  @Bindable var model: AppModel
  @State private var username = ""
  @State private var passcode = ""
  @FocusState private var focus: Field?

  private enum Field {
    case username
    case passcode
  }

  /// The passcode a Join Link carried, which the form holds out of sight, or the one typed.
  private var joining: String { model.joinPasscode ?? passcode }

  private var isPasscodeFull: Bool { joining.count == CodeFormat.groupPasscode.length }

  private var canJoin: Bool {
    !username.isEmpty && isPasscodeFull && !model.isSigningIn
  }

  var body: some View {
    Form {
      Section {
        LabeledContent("Username") {
          TextField("Username", text: $username, prompt: Text("Required"))
            .plainEntry()
            .textContentType(.username)
            .focused($focus, equals: .username)
            .submitLabel(isPasscodeFull ? .join : .next)
            .onSubmit {
              if isPasscodeFull {
                join()
              } else {
                focus = .passcode
              }
            }
            .multilineTextAlignment(.trailing)
            .accessibilityIdentifier("signin-username")
        }
      } footer: {
        if model.joinPasscode != nil {
          Text("Your invite link has the Group Passcode. Choose a username to join.")
        }
      }
      if model.joinPasscode != nil {
        // The link's passcode has no field to show a refusal under, so the line sits here.
        RefusedCodeLine(message: model.refusedCode)
      } else {
        passcodeSection
      }
      SignInFailureSection(failure: model.signInFailure)
    }
    .signInForm(
      title: "Join Your Group", model: model, focus: $focus, first: .username, code: .passcode
    )
    .safeAreaInset(edge: .bottom) {
      SignInSubmit(
        title: "Join", isWorking: model.isSigningIn, isEnabled: canJoin,
        identifier: "signin-join", action: join)
    }
  }

  private var passcodeSection: some View {
    Section("Group Passcode") {
      // A generated code the Host shares, so it is shown as typed or pasted, like a
      // Sign-in Code, rather than hidden like a password.
      CodeField(
        "Group Passcode", code: $passcode, format: .groupPasscode, focus: $focus,
        equals: .passcode, isRefused: model.isCodeRefused, submit: passcodeFilled
      )
      .accessibilityIdentifier("signin-passcode")
      .codeRow()
      RefusedCodeLine(message: model.refusedCode)
      CodePasteButton(code: $passcode, format: .groupPasscode, identifier: "signin-passcode-paste")
    }
  }

  /// A full passcode, typed or pasted, joins at once when the username is there, and otherwise
  /// sends the Person to the username.
  private func passcodeFilled() {
    if username.isEmpty {
      focus = .username
    } else {
      join()
    }
  }

  private func join() {
    guard canJoin else { return }
    Task { await model.signIn(.join(username: username, passcode: joining)) }
  }
}

struct CodeForm: View {
  @Bindable var model: AppModel
  @State private var code = ""
  @FocusState private var focus: Bool?

  private var canRedeem: Bool {
    code.count == CodeFormat.signInCode.length && !model.isSigningIn
  }

  var body: some View {
    Form {
      Section("Sign-in Code") {
        CodeField(
          "Sign-in Code", code: $code, format: .signInCode, focus: $focus, equals: true,
          isRefused: model.isCodeRefused, submit: redeem
        )
        .accessibilityIdentifier("signin-code")
        .codeRow()
        RefusedCodeLine(message: model.refusedCode)
        CodePasteButton(code: $code, format: .signInCode, identifier: "signin-code-paste")
      }
      SignInFailureSection(failure: model.signInFailure)
    }
    .signInForm(title: "Sign In", model: model, focus: $focus, first: true, code: true)
    .safeAreaInset(edge: .bottom) {
      SignInSubmit(
        title: "Sign In", isWorking: model.isSigningIn, isEnabled: canRedeem,
        identifier: "signin-redeem", action: redeem)
    }
  }

  private func redeem() {
    guard canRedeem else { return }
    Task { await model.signIn(.code(code)) }
  }
}

extension AppModel {
  /// Whether the code on screen is the one the service refused. Any change to the code clears
  /// it.
  fileprivate var isCodeRefused: Binding<Bool> {
    Binding(
      get: { self.refusedCode != nil },
      set: { if !$0 { self.refusedCode = nil } })
  }
}

/// The system Paste button under a code. It reads the clipboard without the paste alert, because
/// the Person tapped it, and the code arrives through the format, so a Join Link, a dash, or a
/// space reads as the code. People get codes as text, so this is the usual way in.
private struct CodePasteButton: View {
  @Binding var code: String
  let format: CodeFormat
  let identifier: String

  var body: some View {
    #if !os(tvOS)
      PasteButton(payloadType: String.self) { pasted in
        guard let text = pasted.first else { return }
        code = format.code(from: text)
      }
      .labelStyle(.titleAndIcon)
      .buttonBorderShape(.capsule)
      .tint(Color.orbis.tint)
      .accessibilityIdentifier(identifier)
      .codeRow()
    #endif
  }
}

/// A refused code's one line, directly under it: what went wrong and what to do. A refused code
/// is the Person's to fix, so it gets no card and no details to copy.
private struct RefusedCodeLine: View {
  let message: String?

  var body: some View {
    if let message {
      Text(message)
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.destructive)
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("signin-error")
        .codeRow()
    }
  }
}

/// The form's one action, held above the keyboard rather than in a card of its own inside the
/// form.
private struct SignInSubmit: View {
  let title: String
  let isWorking: Bool
  let isEnabled: Bool
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Group {
        if isWorking {
          ProgressView()
        } else {
          Text(title)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(.orbisPrimary)
    .controlSize(.extraLarge)
    .disabled(!isEnabled)
    .accessibilityIdentifier(identifier)
    .frame(maxWidth: 360)
    .padding(.horizontal, 24)
    .padding(.bottom, 12)
  }
}

private struct SignInFailureSection: View {
  let failure: OrbisFailure?

  var body: some View {
    if failure != nil {
      Section {
        FailureRows(failure: failure, context: "signing in", identifier: "signin-error")
      }
    }
  }
}

/// The moment after a device signs in by joining or by approval: a greeting under the orb, before
/// the library takes its place.
struct WelcomeView: View {
  let title: String

  var body: some View {
    SignInMark(title: title)
      .padding(.horizontal, 24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { SignInField(moves: true) }
      .environment(\.colorScheme, .dark)
      .allowsHitTesting(false)
      // The window is back in its own scheme by now, so a light one would draw dark status-bar
      // text on the black field.
      #if os(iOS)
        .statusBarHidden()
      #endif
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("signin-welcome")
  }
}

extension View {
  /// Usernames and codes are typed as they are: no capitals, corrections, or
  /// suggestions added.
  func plainEntry() -> some View {
    self
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
  }

  /// A row of a code's section: centred on the page, without a row's card or separator.
  fileprivate func codeRow() -> some View {
    self
      .frame(maxWidth: .infinity)
      .listRowBackground(Color.clear)
      #if os(iOS)
        .listRowSeparator(.hidden)
      #endif
  }

  /// A sign-in form: `first` takes focus as it opens, and the `code` field takes it back when
  /// the service refuses the code, so the next keystroke replaces it.
  fileprivate func signInForm<Field: Hashable>(
    title: String, model: AppModel, focus: FocusState<Field?>.Binding, first: Field, code: Field
  ) -> some View {
    self
      .formStyle(.grouped)
      .font(.orbis.body)
      #if !os(tvOS)
        .scrollContentBackground(.hidden)
      #endif
      .background { SignInField() }
      .navigationTitle(title)
      .onAppear {
        model.signInFailure = nil
        model.refusedCode = nil
        focus.wrappedValue = first
      }
      .onChange(of: model.signInFailure) { _, failure in
        if failure != nil { focus.wrappedValue = nil }
      }
      .onChange(of: model.refusedCode) { _, refused in
        if refused != nil { focus.wrappedValue = code }
      }
  }
}
