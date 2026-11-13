// swift-tools-version: 6.2
import PackageDescription

// The Orbis service client and the Listening Queue state, with no UI framework. The app, the
// share extension and the `orbis` command line tool all depend on it, and `swift test` runs its
// tests on Linux or macOS with no simulator.
let package = Package(
  name: "OrbisKit",
  platforms: [.iOS("26.1"), .macOS(.v26), .tvOS("26.1")],
  products: [
    .library(name: "OrbisKit", targets: ["OrbisKit"]),
    // A URLProtocol stub that answers requests from a test, shared with the app's unit tests.
    .library(name: "OrbisKitTesting", targets: ["OrbisKitTesting"]),
    .executable(name: "orbis", targets: ["orbis"]),
  ],
  targets: [
    .target(name: "OrbisKit"),
    .target(name: "OrbisKitTesting"),
    .executableTarget(name: "orbis", dependencies: ["OrbisKit"]),
    .testTarget(
      name: "OrbisKitTests",
      dependencies: ["OrbisKit", "OrbisKitTesting"]
    ),
  ]
)
