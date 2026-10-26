import Testing

@testable import OrbisDesign

/// How a code field could go wrong before it reaches a screen: lowercase kept, a dash or a space
/// kept, a look-alike kept, too many characters kept, a pasted link's address read as the code,
/// a `#` in plain text read as a link, a paste into full slots that keeps the old code, a typed
/// character into full slots that wipes them, the wrong length or groups, a digit code that opens
/// the letter keyboard, or letters kept in a digit code.
@Suite struct CodeFieldTests {
  private let signIn = CodeFormat(alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789", groups: [4, 4])
  private let passcode = CodeFormat(alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789", groups: [4, 4, 4])
  private let digits = CodeFormat(alphabet: "0123456789", groups: [3, 3])

  @Test(arguments: ["abcd-efgh", "ABCD EFGH", " abcdEFGH\n", "ab cd-ef gh", "abcd–efgh"])
  func `a code is read in capitals without dashes or spaces`(typed: String) {
    #expect(signIn.code(from: typed) == "ABCDEFGH")
  }

  @Test(arguments: ["-", " ", "O", "0", "I", "1", "L", "o", "i", "l"])
  func `a character outside the alphabet changes nothing`(typed: String) {
    #expect(signIn.code(from: "ABC" + typed) == "ABC")
  }

  @Test func `a code keeps no more characters than it has slots`() {
    #expect(signIn.code(from: "abcd-efgh-jk") == "ABCDEFGH")
  }

  @Test func `a pasted Join Link keeps only the passcode`() {
    #expect(passcode.code(from: "https://orbis.p11a.xyz/join#k7q2m9xh4rpa") == "K7Q2M9XH4RPA")
    #expect(passcode.code(from: "  https://orbis.p11a.xyz/join#K7Q2M9XH4RPA\n") == "K7Q2M9XH4RPA")
  }

  @Test func `a hash in text that is not a link is dropped like any other character`() {
    #expect(signIn.code(from: "ABCD#EFGH") == "ABCDEFGH")
  }

  @Test func `a whole code pasted into full slots replaces the code they hold`() {
    #expect(signIn.code(replacing: "ZZZZZZZZ", in: "ZZZZZZZZabcd-efgh") == "ABCDEFGH")
    #expect(signIn.code(replacing: "ZZZZZZZZ", in: "abcd-efghZZZZZZZZ") == "ABCDEFGH")
  }

  @Test func `a character typed into full slots changes nothing`() {
    #expect(signIn.code(replacing: "ZZZZZZZZ", in: "ZZZZZZZZA") == "ZZZZZZZZ")
    #expect(signIn.code(replacing: "ZZZZZZZ", in: "ZZZZZZZa") == "ZZZZZZZA")
  }

  @Test func `the groups set the length`() {
    #expect(signIn.length == 8)
    #expect(passcode.length == 12)
    #expect(digits.length == 6)
  }

  @Test func `only a digit code opens the number pad`() {
    #expect(digits.isNumeric)
    #expect(!signIn.isNumeric)
  }

  @Test func `a digit code keeps only digits`() {
    #expect(digits.code(from: "48a2-71 9x") == "482719")
  }

  @Test func `slots are numbered across the groups`() {
    #expect(passcode.slotGroups == [0..<4, 4..<8, 8..<12])
    #expect(digits.slotGroups == [0..<3, 3..<6])
  }
}
