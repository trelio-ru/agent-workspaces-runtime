import Foundation
import Security

// The bridge passes one bounded JSON request through stdin. Results use the
// inherited anonymous descriptor 3 instead of stdout/stderr, so a retrieved
// device-session cannot be captured by ordinary process diagnostics.
private struct Request: Decodable {
    let operation: String
    let service: String
    let account: String
    let value: String?
    let keychainPath: String?
}

private struct Response: Encodable {
    let status: String
    let value: String?
}

private let maximumRequestBytes = 128 * 1024
private let resultHandle = FileHandle(fileDescriptor: 3, closeOnDealloc: false)

private func finish(_ response: Response) -> Never {
    guard let encoded = try? JSONEncoder().encode(response) else {
        exit(70)
    }
    do {
        try resultHandle.write(contentsOf: encoded)
        try resultHandle.close()
        exit(0)
    } catch {
        exit(74)
    }
}

private func fail(_ code: Int32) -> Never {
    // Never print Security.framework diagnostics: labels, account names and
    // implementation details are unnecessary to the model-facing caller.
    exit(code)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count > 0 && input.count <= maximumRequestBytes else {
    fail(64)
}
guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
    fail(65)
}
guard
    !request.service.isEmpty,
    request.service.utf8.count <= 512,
    !request.account.isEmpty,
    request.account.utf8.count <= 4096
else {
    fail(66)
}

// A background bridge must never summon SecurityAgent. If the user's login
// Keychain is locked or unavailable, return a fixed failure so the caller can
// preserve the legacy file and retry after the user unlocks macOS normally.
guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else {
    fail(73)
}

var selectedKeychain: SecKeychain?
if let keychainPath = request.keychainPath {
    guard
        keychainPath.hasPrefix("/"),
        keychainPath.utf8.count <= 4096,
        SecKeychainOpen(keychainPath, &selectedKeychain) == errSecSuccess
    else {
        fail(74)
    }
}

let baseAttributes: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: request.service,
    kSecAttrAccount as String: request.account,
]

private func lookupQuery() -> [String: Any] {
    var query = baseAttributes
    if let selectedKeychain {
        query[kSecMatchSearchList as String] = [selectedKeychain]
    }
    return query
}

switch request.operation {
case "get":
    var query = lookupQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        finish(Response(status: "not_found", value: nil))
    }
    guard
        status == errSecSuccess,
        let data = result as? Data,
        let value = String(data: data, encoding: .utf8),
        !value.isEmpty
    else {
        fail(67)
    }
    finish(Response(status: "ready", value: value))

case "set":
    guard
        let value = request.value,
        !value.isEmpty,
        value.utf8.count <= 64 * 1024
    else {
        fail(68)
    }
    let valueData = Data(value.utf8)
    let updateStatus = SecItemUpdate(
        lookupQuery() as CFDictionary,
        [kSecValueData as String: valueData] as CFDictionary
    )
    if updateStatus == errSecItemNotFound {
        var item = baseAttributes
        if let selectedKeychain {
            item[kSecUseKeychain as String] = selectedKeychain
        }
        item[kSecValueData as String] = valueData
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            fail(69)
        }
    } else if updateStatus != errSecSuccess {
        fail(69)
    }
    finish(Response(status: "stored", value: nil))

case "delete":
    let status = SecItemDelete(lookupQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail(71)
    }
    finish(Response(status: status == errSecSuccess ? "deleted" : "not_found", value: nil))

default:
    fail(72)
}
