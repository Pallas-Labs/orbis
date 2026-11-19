import Foundation
import Observation

/// What the app knows about the one Listening Queue. A queue request that never finished is
/// `idle`, and a failure keeps its reason and the address that was asked, so the queue screen can
/// say what went wrong and offer the retry where the answer belongs.
public enum QueueLoad: Equatable, Sendable {
  case idle
  case loaded(ListeningQueue)
  case failed(OrbisError, address: URL?)
}

/// How a queue action ended.
public enum QueueOutcome: Equatable, Sendable {
  /// The service applied the action and answered with this queue. It is the one on show unless
  /// a newer action was asked meanwhile, whose own answer follows it.
  case applied(ListeningQueue)
  /// A sign-out, a cancelled caller, or a caller that no longer wants the answer owns the queue
  /// now, so nothing changed here. Never shown to anyone.
  case superseded
  /// The service refused, or could not be reached. Nothing changed.
  case failed(OrbisError)
}

/// The Listening Queue's state and the rules that keep it true: the service's queue is the only
/// queue, so each answer replaces the one on show, and an answer that arrives after a newer
/// request began is dropped instead of published over it.
///
/// Mutations run one at a time, in the order they were asked. A refresh may overlap them, because
/// it only reads, but a refresh begun before a mutation never publishes after it. Signing out
/// ends every request still in flight. Nothing here knows about audio: the app starts and stops
/// playback from what a call answers.
@MainActor
@Observable
public final class ListeningQueueStore {
  public private(set) var state: QueueLoad = .idle
  /// What the last queue action did, said where the action was taken.
  public var notice: String?

  /// Moves on at every refresh and every mutation, so a refresh that began first cannot publish.
  @ObservationIgnored private var readGeneration = 0
  /// Moves on at every mutation and at sign-out, so only the newest mutation's answer is published.
  @ObservationIgnored private var mutationRevision = 0
  @ObservationIgnored private var mutationChain: Task<Void, Never>?

  public init() {}

  /// A mutation that was queued: wait for `request`, then publish what it answered with
  /// `publish(_:revision:)`.
  public struct Submission<Value: Sendable>: Sendable {
    public let request: Task<Value, Error>
    public let revision: Int
  }

  /// Queues `operation` behind the mutations already asked for. It runs only while `currentToken`
  /// still answers the key it answered when the mutation was queued, so a device that signed out,
  /// or in as someone else, in between never sends the request.
  public func submit<Value: Sendable>(
    currentToken: @escaping @MainActor () -> String?,
    _ operation: @escaping @MainActor () async throws -> Value
  ) -> Submission<Value> {
    readGeneration += 1
    mutationRevision += 1
    let preceding = mutationChain
    let token = currentToken()
    let request = Task { [weak self] in
      await preceding?.value
      try Task.checkCancellation()
      guard let self, let token, currentToken() == token else { throw CancellationError() }
      defer { self.readGeneration += 1 }
      return try await operation()
    }
    mutationChain = Task { _ = await request.result }
    return Submission(request: request, revision: mutationRevision)
  }

  /// Shows `queue` when nothing newer has been asked since `revision`. Reports whether it did.
  @discardableResult
  public func publish(_ queue: ListeningQueue, revision: Int) -> Bool {
    guard revision == mutationRevision else { return false }
    state = .loaded(queue)
    return true
  }

  /// The revision the latest mutation holds, for a caller that publishes on its own.
  public var revision: Int { mutationRevision }

  /// Ends every request still in flight: none of them publishes after this.
  public func invalidate() {
    readGeneration += 1
    mutationRevision += 1
  }

  /// The queue belonged to a service or a Person this device has forgotten.
  public func reset() {
    invalidate()
    state = .idle
    notice = nil
  }

  /// Reads the one Listening Queue. A refresh that a newer request overtook publishes nothing,
  /// and one cancelled by leaving the app keeps the queue already on show.
  public func load(from client: OrbisClient) async {
    readGeneration += 1
    let generation = readGeneration
    do {
      let loaded = try await client.listeningQueue()
      guard generation == readGeneration, !Task.isCancelled else { return }
      state = .loaded(loaded)
    } catch OrbisError.cancelled {
      guard generation == readGeneration else { return }
      if case .loaded = state { return }
      state = .idle
    } catch let error as OrbisError {
      guard generation == readGeneration else { return }
      state = .failed(error, address: client.address)
    } catch {
      guard generation == readGeneration else { return }
      state = .failed(.unreachable, address: client.address)
    }
  }

  // MARK: - Actions

  /// Makes a Set the active entry, so every device agrees on what is playing.
  ///
  /// `isCurrent` says whether the caller still wants the answer: the store sends nothing, and
  /// answers `.superseded`, once it says no, so a play the person already replaced never reaches
  /// the service.
  public func play(
    _ id: String, client: OrbisClient, currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) async -> QueueOutcome {
    await run(client: client, currentToken: currentToken, isCurrent: isCurrent, notice: nil) {
      try await $0.playSet(id)
    }
  }

  /// Puts a Set in the queue to play after the one playing now.
  public func playNext(
    _ id: String, client: OrbisClient, currentToken: @escaping @MainActor () -> String?
  ) async -> QueueOutcome {
    await add(id, placement: .next, notice: "Plays next", client: client, currentToken: currentToken)
  }

  /// Adds a Set to the end of the queue.
  public func addToEnd(
    _ id: String, client: OrbisClient, currentToken: @escaping @MainActor () -> String?
  ) async -> QueueOutcome {
    await add(
      id, placement: .end, notice: "Added to the queue", client: client, currentToken: currentToken)
  }

  /// Puts a Set in the queue at `placement`, and says `notice` where the action was taken.
  public func add(
    _ id: String, placement: QueuePlacement, notice: String, client: OrbisClient,
    currentToken: @escaping @MainActor () -> String?
  ) async -> QueueOutcome {
    await run(client: client, currentToken: currentToken, notice: notice) {
      try await $0.queueSet(id, placement: placement)
    }
  }

  /// Replaces the queue with a Playlist's playable members, in Playlist order or shuffled.
  public func playPlaylist(
    _ id: String, shuffled: Bool = false, client: OrbisClient,
    currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) async -> QueueOutcome {
    await run(client: client, currentToken: currentToken, isCurrent: isCurrent, notice: nil) {
      try await $0.playPlaylist(id, shuffled: shuffled)
    }
  }

  /// Replaces the queue with a saved Collection's Sets, ranked or shuffled.
  public func playCollection(
    _ id: String, shuffled: Bool = false, client: OrbisClient,
    currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) async -> QueueOutcome {
    await run(client: client, currentToken: currentToken, isCurrent: isCurrent, notice: nil) {
      try await $0.playCollection(id, shuffled: shuffled)
    }
  }

  /// Replaces the queue with the Sets in Heavy Rotation over a range, ranked or shuffled.
  public func playHeavyRotation(
    _ range: ListeningRange, shuffled: Bool = false, client: OrbisClient,
    currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) async -> QueueOutcome {
    await run(client: client, currentToken: currentToken, isCurrent: isCurrent, notice: nil) {
      try await $0.playHeavyRotation(range, shuffled: shuffled)
    }
  }

  /// How long `finished` waits before each further try of a completion that got no answer, a 429
  /// or a 5xx, as the web player does. The service counts a completion once, by whether the Set
  /// is still the active one, so a repeat is safe. A test shortens the waits.
  @ObservationIgnored public var completionWaits: [Duration] = [
    .seconds(1), .seconds(2), .seconds(4),
  ]

  /// The active Set reached its natural end: the Listen finishes on the service, and the queue
  /// that comes back holds what plays next.
  ///
  /// A completion that got no answer, a 429 or a 5xx is sent again after each of
  /// `completionWaits`. Each try queues behind the mutations asked for since, so a Set the person
  /// plays meanwhile is not held up by the waits, and the tries stop once `isCurrent` says the
  /// person played something else.
  public func finished(
    _ id: String, client: OrbisClient, currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) async -> QueueOutcome {
    var waits = completionWaits[...]
    while true {
      let outcome = await run(
        client: client, currentToken: currentToken, isCurrent: isCurrent, notice: nil
      ) { try await $0.reportCompletion(id) }
      guard case .failed(let error) = outcome, Self.mayOutlast(error),
        let wait = waits.popFirst()
      else { return outcome }
      do {
        try await Task.sleep(for: wait)
      } catch {
        return .superseded
      }
      guard isCurrent(), currentToken() == client.token else { return .superseded }
    }
  }

  /// Whether a request that failed this way may succeed when sent again: no answer came, or the
  /// service was busy or broken rather than refusing the request.
  static func mayOutlast(_ error: OrbisError) -> Bool {
    switch error {
    case .unreachable: true
    case .server(let status, _): status == 429 || status >= 500
    default: false
    }
  }

  /// Sends `call` behind the mutations already asked for, while the key and `isCurrent` still
  /// hold. An answer the caller still wants is `.applied`, and is shown when no newer mutation
  /// was asked since; a newer one answers after it and shows its own.
  private func run(
    client: OrbisClient,
    currentToken: @escaping @MainActor () -> String?,
    isCurrent: @escaping @MainActor () -> Bool = { true },
    notice message: String?,
    _ call: @escaping @Sendable (OrbisClient) async throws -> ListeningQueue
  ) async -> QueueOutcome {
    notice = nil
    let submission = submit(currentToken: currentToken) {
      guard isCurrent() else { throw CancellationError() }
      return try await call(client)
    }
    do {
      let loaded = try await withTaskCancellationHandler {
        try await submission.request.value
      } onCancel: {
        submission.request.cancel()
      }
      guard !Task.isCancelled, isCurrent() else { return .superseded }
      if publish(loaded, revision: submission.revision) { notice = message }
      return .applied(loaded)
    } catch is CancellationError {
      return .superseded
    } catch OrbisError.cancelled {
      return .superseded
    } catch let error as OrbisError {
      guard currentToken() == client.token, isCurrent(), !Task.isCancelled else {
        return .superseded
      }
      return .failed(error)
    } catch {
      guard currentToken() == client.token, isCurrent(), !Task.isCancelled else {
        return .superseded
      }
      return .failed(.unreachable)
    }
  }
}

extension ListeningQueue {
  /// The queue as plain text, one entry to a line, with `>` before the Set playing now.
  public var text: String {
    guard !entries.isEmpty else { return "The queue is empty." }
    return entries.map { entry in
      let marker = isActive(entry.id) ? ">" : " "
      return "\(marker) \(entry.id)  \(entry.title)"
    }.joined(separator: "\n")
  }
}
