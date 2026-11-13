import OrbisDesign
import OrbisKit
import SwiftUI

/// Settings with its navigation stack: a sheet from the gear on iOS, the Settings window on the
/// Mac. The data loads here, above the stack, so a pushed Person page coming back does not
/// reload it.
struct SettingsScreen: View {
  let model: AppModel
  var done: (() -> Void)?
  @State private var settings: SettingsModel

  init(model: AppModel, done: (() -> Void)? = nil) {
    self.model = model
    self.done = done
    _settings = State(initialValue: SettingsModel(app: model))
  }

  var body: some View {
    NavigationStack {
      SettingsView(model: model, settings: settings)
        .toolbar {
          if let done {
            ToolbarItem(placement: .confirmationAction) {
              Button("Done", action: done)
                .accessibilityIdentifier("settings-done")
            }
          }
        }
    }
    // Keyed on the key, so signing in as someone else reloads the Person this shows.
    .task(id: model.client?.token) { await settings.load() }
    // A code typed in Add a Device opens the sheet over Settings. On iOS Settings is itself a
    // sheet, so a link that arrives while it is open opens there too.
    .approvalSheet(model) { approval in
      #if os(iOS)
        return true
      #else
        return approval.origin == .typed
      #endif
    }
    // The sheet closed after an approval, typed or linked: the new device leads the list.
    .onChange(of: model.approval) { old, new in
      guard new == nil, case .approved = old?.step else { return }
      Task { await settings.loadDevices() }
    }
  }
}

/// The signed-in Person's settings: their account, the Group (for the Host, joining and People),
/// Downloads, Devices, and signing out.
struct SettingsView: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
  @State private var isConfirmingSignOut = false
  @State private var copiedPlaybackReport = false

  var body: some View {
    Group {
      if model.isConfigured {
        form
      } else {
        ContentUnavailableView(
          "Not Signed In", systemImage: "person.crop.circle",
          description: Text("Sign in to Orbis in its window first."))
      }
    }
    .navigationTitle("Settings")
  }

  private var form: some View {
    Form {
      switch settings.me {
      case .idle, .loading:
        Section { ProgressView() }
      case .failed(let failure):
        Section {
          FailureRows(failure: failure, context: "loading settings", identifier: "settings-load-error")
          Button("Try Again") { Task { await settings.load() } }
        }
      case .loaded(let person):
        account(person)
        devices
        group(person)
        if person.host {
          HostSections(settings: settings, hostId: person.id)
        }
        downloads(person)
      }
      playbackSection
      Section {
        Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
          .accessibilityIdentifier("settings-sign-out")
      } footer: {
        Text("Orbis \(FailureReport.appVersion)")
          .frame(maxWidth: .infinity)
          .padding(.top, 12)
          .accessibilityIdentifier("settings-version")
      }
    }
    .settingsPage()
    .confirmationDialog(
      "Sign out of Orbis?", isPresented: $isConfirmingSignOut, titleVisibility: .visible
    ) {
      Button("Sign Out", role: .destructive) { model.signOut() }
        .accessibilityIdentifier("settings-sign-out-confirm")
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("To sign in again, you need a Sign-in Code from another device or from your Host.")
    }
  }

  private var playbackSection: some View {
    Section {
      Button(copiedPlaybackReport ? "Copied" : "Copy Playback Report") {
        copyToPasteboard(model.audioPlayer.playbackReport())
        copiedPlaybackReport = true
      }
      .accessibilityIdentifier("settings-copy-playback-report")
      .sensoryFeedback(.success, trigger: copiedPlaybackReport) { _, now in now }
    } header: {
      Text("Playback")
    } footer: {
      Text("Copies recent playback activity from this app run. The report is lost when Orbis closes.")
    }
  }

  /// Who is signed in, as a card that opens the page for changing the name.
  private func account(_ person: Me) -> some View {
    Section {
      NavigationLink {
        NameEditor(settings: settings, person: person)
      } label: {
        HStack(spacing: 14) {
          PersonAvatar(person.username, diameter: 56)
          VStack(alignment: .leading, spacing: 2) {
            Text(person.username)
              .font(.title3.weight(.semibold))
            Text(role(person))
              .font(.orbis.detail)
              .foregroundStyle(.secondary)
          }
        }
        .padding(.vertical, 4)
      }
      .accessibilityIdentifier("settings-account")
    }
  }

  private func role(_ person: Me) -> String {
    guard person.host else { return "Member of the Group" }
    guard case .loaded(let people) = settings.people else { return "Host" }
    return people.count == 1 ? "Host · 1 person" : "Host · \(people.count) people"
  }

  private func group(_ person: Me) -> some View {
    Section {
      Toggle(
        "Share with Group",
        isOn: setting(person.social, failure: \.groupFailure) { MeUpdate(social: $0) }
      )
      .disabled(settings.isSaving)
      .accessibilityIdentifier("settings-social")
      FailureRows(failure: settings.groupFailure, context: "changing settings", identifier: "settings-error")
    } header: {
      Text("Group")
    } footer: {
      Text("You and your Group see each other's Sets, Playlists, and listening.")
    }
  }

  private func downloads(_ person: Me) -> some View {
    Section {
      Toggle(
        "Auto Download",
        isOn: setting(person.autoDownload, failure: \.downloadsFailure) { MeUpdate(autoDownload: $0) }
      )
      .disabled(settings.isSaving)
      .accessibilityIdentifier("auto-download")
      LabeledContent("Audio kept", value: keptCount == 1 ? "1 set" : "\(keptCount) sets")
      FailureRows(
        failure: settings.downloadsFailure, context: "changing Auto Download",
        identifier: "auto-download-error")
    } header: {
      Text("Downloads")
    } footer: {
      Text("When you save a Set, Orbis keeps its audio so it is ready to play. This applies to all your devices.")
    }
  }

  private var keptCount: Int {
    guard case .loaded(let sets) = model.library else { return 0 }
    return sets.filter { $0.downloadState == "ready" }.count
  }

  /// Add a Device first, then every key the Person holds, newest first.
  private var devices: some View {
    Section {
      NavigationLink {
        AddDeviceView(model: model, settings: settings)
      } label: {
        Text("Add a Device").foregroundStyle(Color.orbis.tint)
      }
      .accessibilityIdentifier("settings-add-device")
      switch settings.devices {
      case .idle, .loading:
        ProgressView()
      case .failed(let failure):
        FailureRows(failure: failure, context: "loading devices", identifier: "settings-devices-error")
        Button("Try Again") { Task { await settings.loadDevices() } }
      case .loaded(let list):
        ForEach(list) { device in
          DeviceRow(device: device, settings: settings)
        }
      }
      FailureRows(
        failure: settings.devicesFailure, context: "signing out a device",
        identifier: "settings-device-error")
    } header: {
      Text("Devices")
    }
  }

  private func setting(
    _ value: Bool, failure: ReferenceWritableKeyPath<SettingsModel, OrbisFailure?>,
    _ update: @escaping (Bool) -> MeUpdate
  ) -> Binding<Bool> {
    Binding(
      get: { value },
      set: { enabled in Task { await settings.save(update(enabled), failure: failure) } })
  }
}

/// One of the Person's keys: its label, when it was last used or added, and whether it is this
/// device. Any other device signs out with a swipe, or from its menu on a Mac.
private struct DeviceRow: View {
  let device: Device
  let settings: SettingsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(device.label)
        if device.current {
          Text("This Device")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(.secondary.opacity(0.5)) }
        }
      }
      Text(usage)
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("device-\(device.id)")
    .swipeActions {
      if !device.current { signOut }
    }
    .contextMenu {
      if !device.current { signOut }
    }
  }

  private var signOut: some View {
    Button("Sign Out", role: .destructive) { Task { await settings.revoke(device) } }
      .accessibilityIdentifier("device-sign-out")
  }

  private var usage: String {
    guard let used = device.lastUsedAt else {
      return "Added \(SetPresentation.plainDate(device.addedAt))"
    }
    return "Used \(SetPresentation.date(from: used).formatted(.relative(presentation: .named)))"
  }
}

/// Add a Device: the six digits another device shows, or, for a device that cannot show them, a
/// Sign-in Code to type there.
private struct AddDeviceView: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
  @State private var code = ""
  @FocusState private var isFocused: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        TextField("Code", text: $code, prompt: Text("000 000"))
          .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
          .multilineTextAlignment(.center)
          .plainEntry()
          #if os(iOS)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
          #endif
          .focused($isFocused)
          .accessibilityIdentifier("add-device-code")
      } header: {
        Text("Enter the code on the other device.")
          .textCase(nil)
      }
      Section {
        if let shown = settings.code {
          SignInCodeView(code: shown, identifier: "settings-sign-in-code")
          Button("New Code") { Task { await settings.makeCode() } }
            .accessibilityIdentifier("settings-sign-in-code-new")
        } else {
          Button("Show a Code Instead") { Task { await settings.makeCode() } }
            .accessibilityIdentifier("settings-sign-in-another")
        }
        FailureRows(
          failure: settings.codeFailure, context: "making a Sign-in Code",
          identifier: "settings-code-error")
      } footer: {
        if settings.code != nil {
          Text("On the new device, choose I Have a Sign-in Code and type this.")
        }
      }
    }
    .settingsPage()
    .navigationTitle("Add a Device")
    .onAppear { isFocused = settings.code == nil }
    .onChange(of: code) { _, typed in
      let digits = String(typed.filter { $0.isASCII && $0.isNumber }.prefix(6))
      guard digits == typed else {
        code = digits
        return
      }
      if digits.count == 6 { Task { await model.findApproval(typed: digits) } }
    }
    // The sheet closed. After an approval Settings shows again with the new device; otherwise
    // the field empties for the next try.
    .onChange(of: model.approval) { old, new in
      guard new == nil, let old, old.origin == .typed else { return }
      guard case .approved = old.step else {
        code = ""
        return
      }
      dismiss()
    }
  }
}

/// The page for changing the signed-in Person's name.
private struct NameEditor: View {
  @Bindable var settings: SettingsModel
  let person: Me
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        TextField("Name", text: $settings.username)
          .plainEntry()
          .onSubmit(save)
          .accessibilityIdentifier("settings-username")
        FailureRows(failure: settings.accountFailure, context: "changing settings", identifier: "settings-error")
      } footer: {
        Text("People in your Group see this name.")
      }
    }
    .settingsPage()
    .navigationTitle("Name")
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save", action: save)
          .disabled(trimmed.isEmpty || trimmed == person.username || settings.isSaving)
          .accessibilityIdentifier("settings-username-save")
      }
    }
    // Leaving without saving puts the stored name back.
    .onDisappear {
      if case .loaded(let current) = settings.me { settings.username = current.username }
    }
  }

  private var trimmed: String {
    settings.username.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func save() {
    guard !trimmed.isEmpty, trimmed != person.username else { return }
    let username = trimmed
    Task {
      // Return can arrive while another change is saving, which sends nothing; only a name the
      // service took closes the page.
      if await settings.save(MeUpdate(username: username), failure: \.accountFailure) { dismiss() }
    }
  }
}

/// The Host's rows: whether friends can join, with what passcode, and the People in the Group.
private struct HostSections: View {
  @Bindable var settings: SettingsModel
  let hostId: String
  @State private var isConfirmingNewPasscode = false

  var body: some View {
    Section {
      Toggle("Allow Joining", isOn: joining)
        .disabled(settings.isSaving)
        .accessibilityIdentifier("settings-joining")
      if let passcode = settings.passcode {
        // Separate elements, not one LabeledContent, so VoiceOver and the journey reach the
        // passcode and its Copy button each on their own.
        HStack {
          Text("Group Passcode")
          Spacer()
          Text(passcode)
            .font(.orbis.body.monospaced())
            .textSelection(.enabled)
            .accessibilityIdentifier("settings-passcode-row")
          CopyButton(
            title: "Copy Group Passcode", text: passcode, identifier: "settings-passcode-copy")
        }
        .accessibilityElement(children: .contain)
        // The link is the item, so the share sheet builds its card from the /join page's
        // preview tags, and the text with both steps travels with it.
        ShareLink(
          item: JoinLink.url(forPasscode: passcode),
          message: Text(JoinLink.invitation(passcode: passcode))
        ) {
          Label("Invite a Friend", systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("settings-invite")
        Button("New Passcode") { isConfirmingNewPasscode = true }
          .disabled(settings.isSaving)
          .accessibilityIdentifier("settings-passcode-new")
      }
      FailureRows(
        failure: settings.hostFailure, context: "managing the Group", identifier: "settings-host-error")
    } footer: {
      Group {
        if settings.passcode == nil {
          Text("Joining is closed. Turn on Allow Joining and Orbis makes a Group Passcode to share with friends.")
        } else {
          Text("Orbis made this passcode. A new passcode stops the old one working; people who joined stay signed in.")
        }
      }
      .accessibilityIdentifier("settings-passcode-state")
    }
    .confirmationDialog(
      "Make a new Group Passcode?", isPresented: $isConfirmingNewPasscode, titleVisibility: .visible
    ) {
      Button("New Passcode", role: .destructive) {
        Task { await settings.changeJoining(open: true) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The passcode you shared stops working.")
    }

    Section("People") {
      switch settings.people {
      case .idle, .loading:
        ProgressView()
      case .failed(let failure):
        FailureRows(failure: failure, context: "loading People", identifier: "settings-people-error")
        Button("Try Again") { Task { await settings.loadPeople() } }
      case .loaded(let people):
        ForEach(people.filter { $0.id != hostId }) { person in
          NavigationLink {
            PersonView(settings: settings, person: person)
          } label: {
            HStack(spacing: 12) {
              PersonAvatar(person.username, diameter: 32)
              Text(person.username)
            }
          }
          .accessibilityIdentifier("person-\(person.username)")
        }
      }
    }
  }

  /// On makes a new passcode; off closes joining at once.
  private var joining: Binding<Bool> {
    Binding(
      get: { settings.isJoiningOpen },
      set: { open in Task { await settings.changeJoining(open: open) } })
  }
}

/// One other Person, as the Host sees them: a Sign-in Code for a new device, and removal.
private struct PersonView: View {
  let settings: SettingsModel
  let person: GroupPerson
  @State private var isConfirmingRemoval = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let code = settings.personCodes[person.id]
    Form {
      Section {
        if let code {
          SignInCodeView(code: code, identifier: "person-sign-in-code")
        }
        Button(code == nil ? "Show Sign-in Code" : "New Code") {
          Task { await settings.makeCode(for: person.id) }
        }
        .accessibilityIdentifier("person-show-code")
        FailureRows(
          failure: settings.personFailures[person.id], context: "managing a Person",
          identifier: "person-error")
      } footer: {
        Text("On their new device, choose I Have a Sign-in Code and type this.")
      }
      Section {
        Button("Remove \(person.username)", role: .destructive) { isConfirmingRemoval = true }
          .accessibilityIdentifier("person-remove")
      } footer: {
        Text("They leave the Group and are signed out on every device.")
      }
    }
    .settingsPage()
    .navigationTitle(person.username)
    .confirmationDialog(
      "Remove \(person.username)?", isPresented: $isConfirmingRemoval, titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        Task {
          guard await settings.remove(person.id) else { return }
          dismiss()
          await settings.loadPeople()
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("They leave the Group and are signed out on every device.")
    }
  }
}

extension View {
  /// Every Settings page draws the same way: a grouped form over the tint glow, so the glass bar
  /// above it has colour to bend on every pushed page too.
  fileprivate func settingsPage() -> some View {
    formStyle(.grouped)
      .font(.orbis.body)
      .scrollContentBackground(.hidden)
      .background { TintGlow() }
  }
}
