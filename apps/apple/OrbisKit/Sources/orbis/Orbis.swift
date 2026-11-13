import Foundation
import OrbisKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// `orbis` drives the same client and queue state the app uses, from a terminal. It is for checking
/// the Listening Queue without a simulator: `ORBIS_ADDRESS` names the service (default: the Orbis
/// service) and `ORBIS_TOKEN` is a device key. The key never goes on the command line, where a
/// process list would show it.
@main
@MainActor
struct OrbisCommand {
  static let usage = """
    usage: orbis <command> [arguments]

    commands:
      queue                         show the Listening Queue
      play <set-id>                 make a Set the active entry
      next <set-id>                 play a Set after the active one
      add <set-id>                  add a Set to the end of the queue
      playlist <id> [--shuffle]     replace the queue with a Playlist
      collection <id> [--shuffle]   replace the queue with a Collection
      finish <set-id>               report that a Set played to its end

    environment:
      ORBIS_TOKEN    a device key (required)
      ORBIS_ADDRESS  the service address, default \(OrbisService.address.absoluteString)
    """

  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let environment = ProcessInfo.processInfo.environment
    let code = await run(arguments: arguments, environment: environment) { print($0) }
    exit(code)
  }

  /// Runs one command and returns its exit code: 0 for success, 1 for a refusal or an unreachable
  /// service, 2 for a command it does not understand.
  static func run(
    arguments: [String], environment: [String: String], output: (String) -> Void
  ) async -> Int32 {
    guard let command = arguments.first, command != "help", command != "--help" else {
      output(usage)
      return arguments.isEmpty ? 2 : 0
    }
    guard let token = environment["ORBIS_TOKEN"], !token.isEmpty else {
      output("ORBIS_TOKEN is not set.")
      return 2
    }
    let address = environment["ORBIS_ADDRESS"].flatMap(URL.init(string:)) ?? OrbisService.address
    guard OrbisClient.accepts(address) else {
      output("ORBIS_ADDRESS must be https, or http on this machine.")
      return 2
    }
    let client = OrbisClient(address: address, token: token)
    let store = ListeningQueueStore()
    let currentToken: @MainActor () -> String? = { token }
    let operands = arguments.dropFirst().filter { !$0.hasPrefix("--") }
    let shuffled = arguments.contains("--shuffle")

    let outcome: QueueOutcome
    switch (command, operands.first) {
    case ("queue", _):
      await store.load(from: client)
      switch store.state {
      case .loaded(let queue):
        output(queue.text)
        return 0
      case .failed(let error, _):
        output(error.message)
        return 1
      case .idle:
        output(OrbisError.cancelled.message)
        return 1
      }
    case ("play", let id?):
      outcome = await store.play(id, client: client, currentToken: currentToken)
    case ("next", let id?):
      outcome = await store.playNext(id, client: client, currentToken: currentToken)
    case ("add", let id?):
      outcome = await store.addToEnd(id, client: client, currentToken: currentToken)
    case ("playlist", let id?):
      outcome = await store.playPlaylist(
        id, shuffled: shuffled, client: client, currentToken: currentToken)
    case ("collection", let id?):
      outcome = await store.playCollection(
        id, shuffled: shuffled, client: client, currentToken: currentToken)
    case ("finish", let id?):
      outcome = await store.finished(id, client: client, currentToken: currentToken)
    default:
      output(usage)
      return 2
    }

    switch outcome {
    case .applied(let queue):
      if let notice = store.notice { output(notice) }
      output(queue.text)
      return 0
    case .failed(let error):
      output(error.message)
      return 1
    case .superseded:
      output(OrbisError.cancelled.message)
      return 1
    }
  }
}
