import Foundation
#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Answers every request from static configuration so the client can be tested without a
/// server. Static rather than injected because `URLProtocol` is instantiated by the loading
/// system, so tests run one at a time.
public final class StubProtocol: URLProtocol {
  /// Guards the stub and the request observations. `startLoading` runs on the loading system's own thread
  /// and the tests read from the main actor, so both sides take the lock rather than one of
  /// them relying on when the other happens to run.
  private static let observationLock = NSLock()
  nonisolated(unsafe) private static var observedRequest: URLRequest?
  nonisolated(unsafe) private static var observedBody: Data?

  public static var lastRequest: URLRequest? {
    get { observationLock.withLock { observedRequest } }
    set { observationLock.withLock { observedRequest = newValue } }
  }

  public static var lastBody: Data? {
    get { observationLock.withLock { observedBody } }
    set { observationLock.withLock { observedBody = newValue } }
  }

  /// Records a request and its body together, so a test that waits for the request is never
  /// woken between the two and reads a request whose body has not arrived yet.
  private static func observe(_ request: URLRequest) -> URLRequest {
    let body = Self.readBody(request)
    var buffered = request
    buffered.httpBody = body
    observationLock.withLock {
      observedRequest = buffered
      observedBody = body
    }
    return buffered
  }

  /// How the next requests are answered. Written by the tests and read by `startLoading`, so it
  /// sits behind the same lock as the observations.
  private struct Stub {
    var status = 200
    var body = ""
    var failure: URLError?
    /// Answers each request from its own path, so one model run can walk health, library, and
    /// playlists in a single test. Sendable so it always runs on the loading system's thread;
    /// a blocked responder here must never hold the main actor.
    var responder: (@Sendable (URLRequest) -> (Int, String))?
    /// Seconds to hold a matching response back before delivering it. For tests that must
    /// prove a newer request wins over an older one: the session drives its requests from one
    /// queue, so holding a response by blocking `startLoading` would stall every other request
    /// on the session instead of overlapping with one.
    var holdResponse: (@Sendable (URLRequest) -> TimeInterval)?
  }

  nonisolated(unsafe) private static var stub = Stub()

  /// Set through `session(responder:)`, or replaced on its own; the static shorthands clear it.
  public static var responder: (@Sendable (URLRequest) -> (Int, String))? {
    get { observationLock.withLock { stub.responder } }
    set { observationLock.withLock { stub.responder = newValue } }
  }

  public static func session(status: Int, body: String) -> URLSession {
    observationLock.withLock { stub = Stub(status: status, body: body) }
    Self.lastRequest = nil
    Self.lastBody = nil
    return makeSession()
  }

  public static func session(
    responder: @Sendable @escaping (URLRequest) -> (Int, String),
    holding: @Sendable @escaping (URLRequest) -> TimeInterval = { _ in 0 }
  ) -> URLSession {
    observationLock.withLock { stub = Stub(responder: responder, holdResponse: holding) }
    Self.lastRequest = nil
    Self.lastBody = nil
    return makeSession()
  }

  public static func session(failure: URLError) -> URLSession {
    observationLock.withLock { stub = Stub(failure: failure) }
    Self.lastRequest = nil
    Self.lastBody = nil
    return makeSession()
  }

  private static func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: configuration)
  }

  public override class func canInit(with request: URLRequest) -> Bool { true }

  public override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  public override func startLoading() {
    let buffered = StubProtocol.observe(request)
    let stub = StubProtocol.observationLock.withLock { StubProtocol.stub }
    if let failure = stub.failure {
      client?.urlProtocol(self, didFailWithError: failure)
      return
    }
    let status: Int
    let body: String
    if let responder = stub.responder {
      (status, body) = responder(buffered)
    } else {
      status = stub.status
      body = stub.body
    }
    guard let url = request.url,
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    let data = Data(body.utf8)
    let hold = stub.holdResponse?(buffered) ?? 0
    if hold > 0 {
      // The session drives its requests from one queue, so a response that is held must be
      // delivered later from its own thread rather than by blocking here.
      let delivery = HeldDelivery(sender: self, client: client, response: response, body: data)
      DispatchQueue.global().asyncAfter(deadline: .now() + hold) { delivery.send() }
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  public override func stopLoading() {}

  /// The pieces of one held response, carried out of the session's queue so the delivery can
  /// wait there without stalling any other request on the session. Every field is set once
  /// here and never written again, so sending from any thread is safe.
  private final class HeldDelivery: @unchecked Sendable {
    private let sender: URLProtocol
    private let client: (any URLProtocolClient)?
    private let response: HTTPURLResponse
    private let body: Data

    init(
      sender: URLProtocol, client: (any URLProtocolClient)?, response: HTTPURLResponse, body: Data
    ) {
      self.sender = sender
      self.client = client
      self.response = response
      self.body = body
    }

    func send() {
      client?.urlProtocol(sender, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(sender, didLoad: body)
      client?.urlProtocolDidFinishLoading(sender)
    }
  }

  /// URLSession hands URLProtocol a stream rather than `httpBody`, so a test asserting on a
  /// request body would otherwise always read nil.
  private static func readBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody {
      return body
    }
    guard let stream = request.httpBodyStream else {
      return nil
    }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 {
        break
      }
      data.append(buffer, count: read)
    }
    return data.isEmpty ? nil : data
  }
}
