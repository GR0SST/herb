import Foundation
import Security

/// Phone token and account key for each server.
/// Available after first unlock, so a VoIP push can answer a call on the lock screen.
enum ConnectionStore {
    private struct Stored: Codable {
        var current: String?
        var tokens: [String: String] = [:]
        var keys: [String: String] = [:]
    }

    private static let baseQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "cc.grosst.herb.account",
        kSecAttrAccount as String: "relay",
    ]

    private static func read() -> Stored {
        var query = baseQuery
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else { return Stored() }
        return stored
    }

    private static func write(_ stored: Stored) throws {
        SecItemDelete(baseQuery as CFDictionary)
        var query = baseQuery
        query[kSecValueData as String] = try JSONEncoder().encode(stored)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw APIError.message("Could not save the account (code \(status))")
        }
    }

    static func load() -> Connection? {
        let stored = read()
        guard let current = stored.current, let url = URL(string: current), let token = stored.tokens[current] else { return nil }
        return Connection(baseURL: url, token: token)
    }

    static func accountKey(for url: URL) -> String? {
        read().keys[url.absoluteString]
    }

    static func save(_ connection: Connection, accountKey: String?) throws {
        var stored = read()
        let server = connection.baseURL.absoluteString
        stored.current = server
        stored.tokens[server] = connection.token
        if let accountKey { stored.keys[server] = accountKey }
        try write(stored)
    }

    static func remove(for url: URL) {
        var stored = read()
        let server = url.absoluteString
        stored.tokens[server] = nil
        stored.keys[server] = nil
        if stored.current == server { stored.current = nil }
        try? write(stored)
    }
}
