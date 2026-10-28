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

  /// The code after `typed` replaced a refused `previous`, which the field holds as if
  /// selected: a typed character starts the code again, a delete clears it, and anything else
  /// set or pasted over it is read as it is.
  public func code(replacingRefused previous: String, in typed: String) -> String {
    if typed.count < previous.count, previous.hasPrefix(typed) || previous.hasSuffix(typed) {
      return ""
    }
    if typed.count > previous.count, let old = typed.range(of: previous) {
      var added = typed
      added.removeSubrange(old)
      return code(from: added)
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

/// A code in one box, as one line of fixed-width characters with a space between groups, never
/// a dash. A position still to fill shows a muted underscore, a blank to fill in, where a dot
/// would read as a hidden password. A code shown to be typed elsewhere and a code
/// being typed look the same.
///
/// One line rather than a box per character: a 12-character Group Passcode in single slots is a
/// row of PIN boxes that does not fit a phone at large text sizes, and a code arrives pasted far
/// more often than typed.
public struct CodeSlots: View {
  public let code: String
  public let format: CodeFormat
  /// The position the next character goes into, its underscore drawn in the tint. A shown code has
  /// none.
  public let active: Int?
  /// A code the service refused: outlined in red and highlighted as selected, because the next
  /// paste or keystroke replaces it.
  let isRefused: Bool
  /// False under a field, which VoiceOver reads itself, so the code is not read twice.
  let isSpoken: Bool

  public init(code: String, format: CodeFormat, active: Int? = nil) {
    self.init(code: code, format: format, active: active, isRefused: false, isSpoken: true)
  }

  init(code: String, format: CodeFormat, active: Int?, isRefused: Bool, isSpoken: Bool) {
    self.code = code
    self.format = format
    self.active = active
    self.isRefused = isRefused
    self.isSpoken = isSpoken
  }

  /// The code's characters and blanks, with a space at each group gap.
  private var line: AttributedString {
    let characters = Array(code)
    var line = AttributedString()
    for (index, group) in format.slotGroups.enumerated() {
      if index > 0 { line += AttributedString(" ") }
      for position in group {
        if position < characters.count {
          var character = AttributedString(String(characters[position]))
          if isRefused { character.backgroundColor = Color.orbis.tint.opacity(0.35) }
          line += character
        } else {
          var blank = AttributedString("_")
          blank.foregroundColor =
            position == active ? Color.orbis.tint : Color.secondary.opacity(0.6)
          line += blank
        }
      }
    }
    return line
  }

  public var body: some View {
    let shape = RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
    Text(line)
      .font(.system(.title2, design: .monospaced).weight(.semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.5)
      .padding(.horizontal, 18)
      .padding(.vertical, 10)
      .background(Color.orbis.field, in: shape)
      // The outline keeps the box visible on a row of the same color as the field.
      .overlay {
        shape.strokeBorder(outline, lineWidth: isRefused || active != nil ? 2 : 1)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(format.spoken(code)).speechSpellsOutCharacters())
      .accessibilityAddTraits(.isStaticText)
      .accessibilityHidden(!isSpoken)
  }

  private var outline: Color {
    if isRefused { return OrbisColor.destructive }
    return active != nil ? Color.orbis.tint : Color.secondary.opacity(0.35)
  }
}

/// The one way to type a code: its box over a text field that takes typing, paste, and
/// one-time-code autofill. Whatever arrives is read through the format, so a dash, a space, or
/// a look-alike changes nothing, and the field submits as the last position fills. A refused
/// code is held as if selected until the next change replaces it.
public struct CodeField<Focus: Hashable>: View {
  private let label: LocalizedStringKey
  @Binding private var code: String
  private let format: CodeFormat
  private let focus: FocusState<Focus>.Binding
  private let focusValue: Focus
  @Binding private var isRefused: Bool
  private let submit: () -> Void

  public init(
    _ label: LocalizedStringKey, code: Binding<String>, format: CodeFormat,
    focus: FocusState<Focus>.Binding, equals focusValue: Focus,
    isRefused: Binding<Bool> = .constant(false), submit: @escaping () -> Void
  ) {
    self.label = label
    _code = code
    self.format = format
    self.focus = focus
    self.focusValue = focusValue
    _isRefused = isRefused
    self.submit = submit
  }

  private var activeSlot: Int? {
    focus.wrappedValue == focusValue && code.count < format.length && !isRefused ? code.count : nil
  }

  public var body: some View {
    CodeSlots(code: code, format: format, active: activeSlot, isRefused: isRefused, isSpoken: false)
      .overlay {
        // The field's own text, caret, and placeholder are clear or empty: the box draws what
        // it holds. The label is for VoiceOver.
        TextField(label, text: $code, prompt: Text(verbatim: ""))
          .labelsHidden()
          .textFieldStyle(.plain)
          #if os(tvOS)
            // tvOS draws a focused field as a white pill over the box, and its full-screen
            // keyboard takes the field's text color, so a clear color would hide what the Person
            // types. The field is nearly transparent instead; the tinted outline shows focus.
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
          // Read in its groups, as the box shows it, rather than as one run of characters.
          .accessibilityValue(Text(format.spoken(code)).speechSpellsOutCharacters())
      }
      .onChange(of: code) { previous, typed in
        let kept: String
        if isRefused {
          isRefused = false
          kept = format.code(replacingRefused: previous, in: typed)
        } else {
          kept = format.code(replacing: previous, in: typed)
        }
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
  private let passcode = CodeFormat(alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789", groups: [4, 4, 4])
  @State private var typed = "K7QM2"
  @FocusState private var focused: Bool?

  var body: some View {
    VStack(spacing: 24) {
      CodeField("Sign-in Code", code: $typed, format: format, focus: $focused, equals: true) {}
      CodeSlots(code: "K7QM2XHR", format: format)
      CodeSlots(code: "482", format: CodeFormat(alphabet: "0123456789", groups: [3, 3]), active: 3)
      CodeSlots(code: "ZZZZZZZZ", format: format, active: nil, isRefused: true, isSpoken: true)
      CodeSlots(code: "K7QM2XHRABCD", format: passcode)
    }
    .padding()
    .background(Color.orbis.paper)
    .onAppear { focused = true }
  }
}

#Preview("Code field") { CodeFieldStates() }

#Preview("Code field, dark") { CodeFieldStates().preferredColorScheme(.dark) }
