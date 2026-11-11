import Foundation

/// The app's feature flags, declared in `flags.json` at the repo root. `Flags.gen.swift` holds
/// one `Flag` case per declared flag; read one as `Flags.client.getBooleanValue(.someFlag)`.
///
/// Every build reads each flag's declared state, so an internal TestFlight build shows only what
/// Parth has turned on. A Debug build launched with `-flags all-on` reads every flag as on, which
/// is how a change behind an off flag is checked before its flip PR merges.
enum Flags {
  static let client = FlagClient(provider: provider(for: ProcessInfo.processInfo.arguments))

  static func provider(for arguments: [String]) -> any FlagProvider {
    #if DEBUG
      if zip(arguments, arguments.dropFirst()).contains(where: { $0 == ("-flags", "all-on") }) {
        return AllOnFlagProvider()
      }
    #endif
    return DeclaredFlagProvider()
  }
}

/// Serves every flag as on.
struct AllOnFlagProvider: FlagProvider {
  func state(forKey _: String) -> FlagState? {
    .on
  }
}
