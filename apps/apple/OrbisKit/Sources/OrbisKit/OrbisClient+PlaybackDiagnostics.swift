import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct DiagnosticsUploadResult: Sendable {
  public let status: Int
  public let retryAfter: TimeInterval?
}

public enum DiagnosticsUploadFailure: Error, Sendable {
  case invalidResponse
}

// The upload streams its answer with `URLSession.bytes(for:)`, which swift-corelibs-foundation
// does not have, so it exists on Apple platforms only.
#if !canImport(FoundationNetworking)
  extension OrbisClient {
    public func uploadPlaybackDiagnostics(_ body: Data) async throws -> DiagnosticsUploadResult {
      let url = address.appending(path: "diagnostics/playback")
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.httpBody = body
      request.timeoutInterval = 10
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      let uploadRequest = request
      let session = self.session
      return try await withThrowingTaskGroup(of: DiagnosticsUploadResult.self) { group in
        group.addTask {
          let (bytes, response) = try await session.bytes(for: uploadRequest)
          let transfer = bytes.task
          defer { transfer.cancel() }
          return try await withTaskCancellationHandler {
            guard let http = response as? HTTPURLResponse else { throw DiagnosticsUploadFailure.invalidResponse }
            let result = DiagnosticsUploadResult(status: http.statusCode, retryAfter: Self.diagnosticsRetryAfter(http))
            guard http.statusCode == 200 else { return result }
            var responseBody = Data()
            for try await byte in bytes {
              try Task.checkCancellation()
              guard responseBody.count < 4_096 else { throw DiagnosticsUploadFailure.invalidResponse }
              responseBody.append(byte)
            }
            let receipt = try JSONDecoder().decode(DiagnosticsReceipt.self, from: responseBody)
            guard receipt.accepted >= 0, receipt.rejected >= 0 else { throw DiagnosticsUploadFailure.invalidResponse }
            return result
          } onCancel: {
            transfer.cancel()
          }
        }
        group.addTask {
          try await Task.sleep(for: .seconds(10))
          throw URLError(.timedOut)
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw CancellationError() }
        return result
      }
    }

    private struct DiagnosticsReceipt: Decodable {
      let accepted: Int
      let rejected: Int
    }

    private static func diagnosticsRetryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
      guard let value = response.value(forHTTPHeaderField: "Retry-After"), value.utf8.count <= 128 else { return nil }
      if !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }) {
        let seconds = Double(value) ?? .infinity
        return seconds.isFinite ? seconds : 301
      }
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = TimeZone(secondsFromGMT: 0)
      formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
      return formatter.date(from: value).map { max(0, $0.timeIntervalSinceNow) }
    }
  }
#endif
