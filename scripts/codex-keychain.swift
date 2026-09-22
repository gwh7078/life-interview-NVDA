import Darwin
import Foundation
import Security

private let service = "com.rensheng.codex-worktree"
private let keys = ["VOLCENGINE_API_KEY", "CLOSEOUT_API_KEY", "STEPFUN_API_KEY"]

private enum Failure: Error, CustomStringConvertible {
    case usage
    case missing(String)
    case noCredentials
    case keychain(OSStatus)
    case unsafeEnv

    var description: String {
        switch self {
        case .usage:
            return "用法：codex-keychain.swift import-env <私有.env路径> | sync-env .env"
        case .missing(let name):
            return "指定文件缺少非空的 \(name)，未导入。"
        case .noCredentials:
            return "指定文件没有包含任何受管的非空凭证，未导入。"
        case .keychain(let status):
            return "macOS 钥匙串操作失败（状态码 \(status)）。"
        case .unsafeEnv:
            return ".env 必须是普通文件，不能是符号链接。"
        }
    }
}

private func itemQuery(_ key: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key,
    ]
}

private func readSecret(_ key: String) throws -> String? {
    var query = itemQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        return nil
    }
    guard status == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8) else {
        throw Failure.keychain(status)
    }
    return value
}

private func saveSecret(_ value: String, for key: String) throws {
    var item = itemQuery(key)
    item[kSecValueData as String] = Data(value.utf8)
    var status = SecItemAdd(item as CFDictionary, nil)
    if status == errSecDuplicateItem {
        status = SecItemUpdate(
            itemQuery(key) as CFDictionary,
            [kSecValueData as String: Data(value.utf8)] as CFDictionary
        )
    }
    guard status == errSecSuccess else {
        throw Failure.keychain(status)
    }
}

private func envValue(_ key: String, in contents: String) -> String? {
    for line in contents.components(separatedBy: .newlines) {
        let line = line.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty, !line.hasPrefix("#"),
              let equals = line.firstIndex(of: "="),
              line[..<equals].trimmingCharacters(in: .whitespaces) == key else {
            continue
        }
        var value = String(line[line.index(after: equals)...])
            .trimmingCharacters(in: .whitespaces)
        if value.count >= 2,
           (value.first == "\"" && value.last == "\"")
            || (value.first == "'" && value.last == "'") {
            value.removeFirst()
            value.removeLast()
        }
        return value.isEmpty ? nil : value
    }
    return nil
}

private func importEnv(_ path: String) throws {
    let contents = try String(contentsOfFile: path, encoding: .utf8)
    var values: [(String, String)] = []
    for key in keys {
        if let value = envValue(key, in: contents) {
            values.append((key, value))
        }
    }
    guard !values.isEmpty else {
        throw Failure.noCredentials
    }
    for (key, value) in values {
        try saveSecret(value, for: key)
    }
    print("已将 \(values.count) 项开发凭证保存到本机 macOS 登录钥匙串；没有显示密钥内容。")
}

private func isManagedLine(_ line: String, key: String) -> Bool {
    var candidate = line.trimmingCharacters(in: .whitespaces)
    if candidate.hasPrefix("#") {
        candidate = candidate.dropFirst().trimmingCharacters(in: .whitespaces)
    }
    guard let equals = candidate.firstIndex(of: "=") else {
        return false
    }
    return candidate[..<equals].trimmingCharacters(in: .whitespaces) == key
}

private func syncEnv(_ path: String) throws {
    let file = URL(fileURLWithPath: path).standardizedFileURL
    guard file.lastPathComponent == ".env" else {
        throw Failure.unsafeEnv
    }
    var metadata = stat()
    if lstat(file.path, &metadata) == 0 {
        guard (metadata.st_mode & S_IFMT) == S_IFREG else {
            throw Failure.unsafeEnv
        }
    } else if errno != ENOENT {
        throw Failure.unsafeEnv
    }

    let defaults = """
    # 本工作树的本地设置；不会被提交到 Git。
    DATABASE_PATH=./data/codex-worktree.db
    HOST=127.0.0.1
    PORT=0
    # VOLCENGINE_API_KEY=实时语音模型凭证（本机钥匙串同步）
    # CLOSEOUT_API_KEY=会后文本总结模型凭证（本机钥匙串同步）
    # STEPFUN_API_KEY=StepFun 实时语音模型凭证（本机钥匙串同步）

    """
    let contents = FileManager.default.fileExists(atPath: file.path)
        ? try String(contentsOf: file, encoding: .utf8)
        : defaults
    var lines = contents.components(separatedBy: .newlines)
    if lines.last == "" {
        lines.removeLast()
    }

    var count = 0
    for key in keys {
        guard let value = try readSecret(key) else {
            continue
        }
        guard !value.contains("\n"), !value.contains("\r"), !value.contains("\0") else {
            throw Failure.unsafeEnv
        }
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let replacement = "\(key)=\"\(escaped)\""
        var replaced = false
        lines = lines.compactMap { line in
            guard isManagedLine(line, key: key) else {
                return line
            }
            if replaced {
                return nil
            }
            replaced = true
            return replacement
        }
        if !replaced {
            lines.append(replacement)
        }
        count += 1
    }

    umask(0o077)
    try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
    guard chmod(file.path, mode_t(S_IRUSR | S_IWUSR)) == 0 else {
        throw Failure.unsafeEnv
    }
    print(count == 0
        ? "钥匙串中暂未找到受管开发凭证；已保留私有 .env，不显示密钥。"
        : "已将本机钥匙串中的 \(count) 项凭证写入当前工作树的私有 .env。")
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 2 else {
        throw Failure.usage
    }
    switch args[0] {
    case "import-env":
        try importEnv(args[1])
    case "sync-env":
        try syncEnv(args[1])
    default:
        throw Failure.usage
    }
} catch {
    fputs("本地凭证辅助操作未完成：\(error)\n", stderr)
    exit(1)
}
