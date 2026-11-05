import Foundation
import Security

/// Токены по серверам: при смене сервера и возврате аккаунт сохраняется.
/// Доступны после первой разблокировки, чтобы VoIP-пуш мог ответить на звонок на заблокированном экране.
enum ConnectionStore {
    private struct Stored: Codable {
        var current: String?
        var tokens: [String: String]
    }

    private static let service = "cc.grosst.herb.connection"
    private static let legacyServer = "https://s.grosst.cc/herb"
    private static let baseQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "relay",
    ]

    private static func read() -> Stored {
        var query = baseQuery
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return Stored(current: nil, tokens: [:])
        }
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            return migrated(stored)
        }
        // Первая версия хранила один сервер.
        if let old = try? JSONDecoder().decode([String: String].self, from: data), let url = old["url"], let token = old["token"] {
            return migrated(Stored(current: url, tokens: [url: token]))
        }
        return Stored(current: nil, tokens: [:])
    }

    /// Сервер переехал на свой домен, аккаунт остался тем же.
    private static func migrated(_ stored: Stored) -> Stored {
        var result = stored
        let target = AppModel.defaultServer.absoluteString
        if let token = result.tokens.removeValue(forKey: legacyServer) {
            result.tokens[target] = token
        }
        if result.current == legacyServer { result.current = target }
        return result
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

    static func token(for url: URL) -> String? {
        read().tokens[url.absoluteString]
    }

    static func save(_ connection: Connection) throws {
        var stored = read()
        let key = connection.baseURL.absoluteString
        stored.current = key
        stored.tokens[key] = connection.token
        try write(stored)
    }

    static func removeToken(for url: URL) {
        var stored = read()
        let key = url.absoluteString
        stored.tokens[key] = nil
        if stored.current == key { stored.current = nil }
        try? write(stored)
    }
}
