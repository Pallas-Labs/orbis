import Foundation
import OrbisKit

extension OrbisService {
  /// The address this launch talks to. A Debug journey points it at the lane's service with
  /// `-orbisServiceAddress <address>`, and a Debug Mac build at the service its development
  /// token belongs to; every other build uses the built-in one.
  static func address(for arguments: [String]) -> URL {
    #if DEBUG
      if let flag = arguments.firstIndex(of: "-orbisServiceAddress"),
        arguments.indices.contains(flag + 1),
        let url = URL(string: arguments[flag + 1]), OrbisClient.accepts(url)
      {
        return url
      }
      if let development = ClientSettings.developmentConfiguration,
        let url = URL(string: development.address), OrbisClient.accepts(url)
      {
        return url
      }
    #endif
    return address
  }
}
