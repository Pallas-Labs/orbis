import SwiftUI

/// A code a person types or reads aloud: which characters it uses and how its slots group.
/// The groups set the length, so a format cannot claim more slots than it draws.
public nonisolated struct CodeFormat: Equatable, Sendable {
  public let alphabet: String
  public let groups: [Int]

  public init(alphabet: String, groups: [Int]) {
    self.alphabet = alphabet
    self.groups = groups
  }

  public var length: Int { groups.reduce(0, +) }

  /// A digit code opens the number pad.
  public var isNumeric: Bool { alphabet.allSatisfy { $0.isASCII && $0.isNumber } }

  /// The code in `text`, as typed or pasted: in capitals, with every character outside the
  /// alphabet dropped, cut to the code's length. A pasted link gives its fragment, so a Join
  /// Link fills the slots with its passcode rather than with the letters of its address.
  public func code(from text: String) -> String {
    var source = Substring(text)
    if text.contains("://"), let hash = text.lastIndex(of: "#") {
      source = text[text.index(after: hash)...]
    }
    return String(source.uppercased().filter { alphabet.contains($0) }.prefix(length))
  }

  /// The code after `typed` replaced `previous` in the field. A paste into full slots lands
  /// beside the code they hold, so the length cap would keep the old code; a whole code in what
  /// was added replaces it instead.
  public func code(replacing previous: String, in typed: String) -> String {
    if previous.count == length, typed.count > length, let old = typed.range(of: previous) {
      var added = typed
      added.removeSubrange(old)
      let pasted = code(from: added)
      if pasted.count == length { return pasted }
    }
    return code(from: typed)
  }

  /// The slot positions of each group, counted across the whole code.
  var slotGroups: [Range<Int>] {
    var start = 0
    return groups.map { size in
      defer { start += size }
      return start..<start + size
    }
  }

  /// The code with a space at each group gap, which VoiceOver reads in groups.
  func spoken(_ code: String) -> String {
    let characters = Array(code)
    return
      slotGroups
      .map { String(characters[$0.clamped(to: 0..<characters.count)]) }
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }
}

/// A code in its slots: one box per character and a gap between groups, never a dash. A code
/// shown to be typed elsewhere and a code being typed look the same.
public struct CodeSlots: View {
  public let code: String
  public let format: CodeFormat
  /// The slot the next character goes into, drawn in the tint. A shown code has none.
  public let active: Int?
  /// False under a field, which VoiceOver reads itself, so the code is not read twice.
  let isSpoken: Bool

  public init(code: String, format: CodeFormat, active: Int? = nil) {
    self.init(code: code, format: format, active: active, isSpoken: true)
  }

  init(code: String, format: CodeFormat, active: Int?, isSpoken: Bool) {
    self.code = code
    self.format = format
    self.active = active
    self.isSpoken = isSpoken
  }

  #if os(tvOS)
    static let slotWidth: CGFloat = 68
    static let slotHeight: CGFloat = 92
  #else
    static let slotWidth: CGFloat = 34
    static let slotHeight: CGFloat = 46
  #endif
  static let slotGap: CGFloat = slotWidth / 6
  static let groupGap: CGFloat = slotWidth / 2

  /// The widest the slots grow. On a narrower row each slot gives up width evenly.
  static func width(of format: CodeFormat) -> CGFloat {
    let slotGaps = CGFloat(format.length - format.groups.count) * slotGap
    let groupGaps = CGFloat(format.groups.count - 1) * groupGap
    return CGFloat(format.length) * slotWidth + slotGaps + groupGaps
  }

  public var body: some View {
    let characters = Array(code)
    HStack(spacing: Self.groupGap) {
      ForEach(format.slotGroups, id: \.lowerBound) { group in
        HStack(spacing: Self.slotGap) {
          ForEach(group, id: \.self) { index in
            slot(index < characters.count ? String(characters[index]) : "", isActive: index == active)
          }
        }
      }
    }
    .frame(maxWidth: Self.width(of: format), minHeight: Self.slotHeight, maxHeight: Self.slotHeight)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(format.spoken(code)).speechSpellsOutCharacters())
    .accessibilityAddTraits(.isStaticText)
    .accessibilityHidden(!isSpoken)
  }

  private func slot(_ character: String, isActive: Bool) -> some View {
    let shape = RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
    return Text(character)
      .accessibilityHidden(!isSpoken)
      .font(.system(.title2, design: .monospaced).weight(.semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.5)
      .frame(maxWidth: Self.slotWidth, maxHeight: .infinity)
      .background(Color.orbis.field, in: shape)
      // The outline keeps a slot visible on a row of the same color as the field.
      .overlay {
        shape.strokeBorder(
          isActive ? Color.orbis.tint : Color.secondary.opacity(0.35), lineWidth: isActive ? 2 : 1)
      }
  }
}

/// The one way to type a code: its slots over a text field that takes typing, paste, and
/// one-time-code autofill. Whatever arrives is read through the format, so a dash, a space, or
/// a look-alike changes nothing, and the field submits as the last slot fills.
public struct CodeField<Focus: Hashable>: View {
  private let label: LocalizedStringKey
  @Binding private var code: String
  private let format: CodeFormat
  private let focus: FocusState<Focus>.Binding
  private let focusValue: Focus
  private let submit: () -> Void

  public init(
    _ label: LocalizedStringKey, code: Binding<String>, format: CodeFormat,
    focus: FocusState<Focus>.Binding, equals focusValue: Focus, submit: @escaping () -> Void
  ) {
    self.label = label
    _code = code
    self.format = format
    self.focus = focus
    self.focusValue = focusValue
    self.submit = submit
  }

  private var activeSlot: Int? {
    focus.wrappedValue == focusValue && code.count < format.length ? code.count : nil
  }

  public var body: some View {
    ZStack {
      CodeSlots(code: code, format: format, active: activeSlot, isSpoken: false)
      // The field's own text, caret, and placeholder are clear or empty: the slots draw what it
      // holds. The label is for VoiceOver.
      TextField(label, text: $code, prompt: Text(verbatim: ""))
        .labelsHidden()
        .textFieldStyle(.plain)
        #if os(tvOS)
          // tvOS draws a focused field as a white pill over the slots, and its full-screen
          // keyboard takes the field's text color, so a clear color would hide what the Person
          // types. The field is nearly transparent instead; the tinted next slot shows focus.
          .opacity(0.02)
        #else
          .foregroundStyle(.clear)
          .tint(.clear)
        #endif
        .textContentType(.oneTimeCode)
        .autocorrectionDisabled()
        #if os(iOS) || os(tvOS)
          .keyboardType(format.isNumeric ? .numberPad : .asciiCapable)
          .textInputAutocapitalization(.characters)
        #endif
        #if os(macOS)
          .focusEffectDisabled()
        #endif
        .focused(focus, equals: focusValue)
        .onSubmit(submit)
    }
    .frame(
      maxWidth: CodeSlots.width(of: format), minHeight: CodeSlots.slotHeight,
      maxHeight: CodeSlots.slotHeight
    )
    .onChange(of: code) { previous, typed in
      let kept = format.code(replacing: previous, in: typed)
      if kept != typed {
        code = kept
      } else if kept.count == format.length {
        submit()
      }
    }
  }
}

private struct CodeFieldStates: View {
  private let format = CodeFormat(alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789", groups: [4, 4])
  @State private var typed = "K7QM2"
  @FocusState private var focused: Bool?

  var body: some View {
    VStack(spacing: 24) {
      CodeField("Sign-in Code", code: $typed, format: format, focus: $focused, equals: true) {}
      CodeSlots(code: "K7QM2XHR", format: format)
      CodeSlots(code: "482", format: CodeFormat(alphabet: "0123456789", groups: [3, 3]), active: 3)
    }
    .padding()
    .background(Color.orbis.paper)
    .onAppear { focused = true }
  }
}

#Preview("Code field") { CodeFieldStates() }

#Preview("Code field, dark") { CodeFieldStates().preferredColorScheme(.dark) }
