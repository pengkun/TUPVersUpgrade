import Foundation
import Network

let bridgeName = "TUP Upgrade Bridge"
let bridgeVersion = "0.1.0-mac"
let host = "127.0.0.1"
let port = UInt16(ProcessInfo.processInfo.environment["PORT"] ?? "18080") ?? 18080
let maxBodyBytes = 50 * 1024 * 1024
let defaultAllowedOrigins = [
    "http://127.0.0.1:8080",
    "http://127.0.0.1:18080",
    "http://localhost:8080",
    "http://localhost:18080",
    "https://upgrade.xhsmartpiano.com",
]
let allowedOrigins = Set(
    (ProcessInfo.processInfo.environment["BRIDGE_ALLOWED_ORIGINS"] ?? defaultAllowedOrigins.joined(separator: ","))
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
)

struct Request {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

func helperURL() -> URL {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0])
    let executableDir = executable.deletingLastPathComponent()
    let appResourceHelper = executableDir
        .deletingLastPathComponent()
        .appendingPathComponent("Resources/bridge/.build/native_usb_probe")
    if FileManager.default.isExecutableFile(atPath: appResourceHelper.path) {
        return appResourceHelper
    }

    let cwdHelper = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent(".build/native_usb_probe")
    if FileManager.default.isExecutableFile(atPath: cwdHelper.path) {
        return cwdHelper
    }

    return executableDir.appendingPathComponent("native_usb_probe")
}

func isAllowedOrigin(_ origin: String?) -> Bool {
    guard let origin, !origin.isEmpty else { return true }
    return allowedOrigins.contains(origin) || allowedOrigins.contains("*")
}

func corsHeaders(origin: String?) -> [(String, String)] {
    var headers: [(String, String)] = [
        ("Access-Control-Allow-Methods", "GET,POST,OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Access-Control-Max-Age", "600"),
        ("Access-Control-Allow-Private-Network", "true"),
        ("Cache-Control", "no-store"),
    ]
    if let origin, isAllowedOrigin(origin) {
        headers.append(("Access-Control-Allow-Origin", origin))
        headers.append(("Vary", "Origin"))
    }
    return headers
}

func jsonData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
}

func statusCodeText(_ code: Int) -> String {
    switch code {
    case 200: return "OK"
    case 204: return "No Content"
    case 400: return "Bad Request"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 500: return "Internal Server Error"
    default: return "OK"
    }
}

func responseHeader(status: Int, headers: [(String, String)], contentLength: Int? = nil, chunked: Bool = false) -> Data {
    var lines = ["HTTP/1.1 \(status) \(statusCodeText(status))"]
    for (key, value) in headers {
        lines.append("\(key): \(value)")
    }
    if let contentLength {
        lines.append("Content-Length: \(contentLength)")
    }
    if chunked {
        lines.append("Transfer-Encoding: chunked")
    }
    lines.append("Connection: close")
    lines.append("")
    lines.append("")
    return Data(lines.joined(separator: "\r\n").utf8)
}

func sendResponse(_ connection: NWConnection, status: Int, contentType: String, body: Data, origin: String?) {
    var headers = corsHeaders(origin: origin)
    headers.append(("Content-Type", contentType))
    let head = responseHeader(status: status, headers: headers, contentLength: body.count)
    var data = Data()
    data.append(head)
    data.append(body)
    connection.send(content: data, completion: .contentProcessed { _ in
        connection.cancel()
    })
}

func sendJson(_ connection: NWConnection, status: Int, _ object: Any, origin: String?) {
    sendResponse(connection, status: status, contentType: "application/json; charset=utf-8", body: jsonData(object), origin: origin)
}

func sendOptions(_ connection: NWConnection, request: Request) {
    let origin = request.headers["origin"]
    let status = isAllowedOrigin(origin) ? 204 : 403
    let head = responseHeader(status: status, headers: corsHeaders(origin: origin), contentLength: 0)
    connection.send(content: head, completion: .contentProcessed { _ in
        connection.cancel()
    })
}

func bridgeStatus() -> [String: Any] {
    [
        "type": "bridge-status",
        "name": bridgeName,
        "version": bridgeVersion,
        "platform": "darwin",
        "arch": ProcessInfo.processInfo.machineHardwareName,
        "host": host,
        "port": port,
        "nativeUsb": true,
    ]
}

func bridgeHomeHTML() -> Data {
    Data("""
    <!doctype html>
    <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>TUP升级助手</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 48px; color: #17202a; }
        code { background: #f1f3f5; padding: 2px 6px; border-radius: 4px; }
        .ok { color: #0f7b3f; font-weight: 700; }
      </style>
    </head>
    <body>
      <h1>TUP升级助手</h1>
      <p class="ok">本地升级服务已启动。</p>
      <p>请回到云端升级网页继续操作。这个本地服务只负责连接 Mac 上的 USB 设备并执行固件升级。</p>
      <p>状态接口：<code>/api/bridge/status</code></p>
      <p>设备检测：<code>/api/device/probe</code></p>
    </body>
    </html>
    """.utf8)
}

extension ProcessInfo {
    var machineHardwareName: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingUTF8: $0) ?? "unknown"
            }
        }
    }
}

func runHelper(_ arguments: [String]) throws -> Data {
    let process = Process()
    process.executableURL = helperURL()
    process.arguments = arguments
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    let out = stdout.fileHandleForReading.readDataToEndOfFile()
    if process.terminationStatus != 0 {
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        if !err.isEmpty { return err }
    }
    return out
}

func handleProbe(_ connection: NWConnection, request: Request) {
    do {
        let out = try runHelper(["probe"])
        sendResponse(connection, status: 200, contentType: "application/json; charset=utf-8", body: out, origin: request.headers["origin"])
    } catch {
        sendJson(connection, status: 500, ["code": 500, "message": error.localizedDescription], origin: request.headers["origin"])
    }
}

func firmwareLines(from body: Data) throws -> [String] {
    let json = try JSONSerialization.jsonObject(with: body, options: [])
    guard let dict = json as? [String: Any], let rawLines = dict["lines"] as? [Any] else {
        throw NSError(domain: "TUPBridge", code: 400, userInfo: [NSLocalizedDescriptionKey: "missing firmware lines"])
    }
    let lines = rawLines
        .map { String(describing: $0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    if lines.isEmpty {
        throw NSError(domain: "TUPBridge", code: 400, userInfo: [NSLocalizedDescriptionKey: "missing firmware lines"])
    }
    return lines
}

func sendChunk(_ connection: NWConnection, _ data: Data) {
    guard !data.isEmpty else { return }
    var chunk = Data(String(data.count, radix: 16).utf8)
    chunk.append(Data("\r\n".utf8))
    chunk.append(data)
    chunk.append(Data("\r\n".utf8))
    connection.send(content: chunk, completion: .contentProcessed { _ in })
}

func handleUpgrade(_ connection: NWConnection, request: Request) {
    let origin = request.headers["origin"]
    let tempURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("tup-firmware-\(UUID().uuidString).upg")
    do {
        let lines = try firmwareLines(from: request.body)
        try lines.joined(separator: "\n").write(to: tempURL, atomically: true, encoding: .utf8)
    } catch {
        sendJson(connection, status: 400, ["type": "error", "message": error.localizedDescription], origin: origin)
        return
    }

    var headers = corsHeaders(origin: origin)
    headers.append(("Content-Type", "application/x-ndjson; charset=utf-8"))
    connection.send(content: responseHeader(status: 200, headers: headers, chunked: true), completion: .contentProcessed { _ in })

    let process = Process()
    process.executableURL = helperURL()
    process.arguments = ["upgrade", tempURL.path]
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    stdout.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if !data.isEmpty { sendChunk(connection, data) }
    }
    stderr.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
        let payload = jsonData(["type": "log", "message": text.trimmingCharacters(in: .whitespacesAndNewlines)])
        var line = payload
        line.append(Data("\n".utf8))
        sendChunk(connection, line)
    }

    process.terminationHandler = { proc in
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        try? FileManager.default.removeItem(at: tempURL)
        if proc.terminationStatus != 0 {
            let payload = jsonData(["type": "error", "message": "native USB bridge exited \(proc.terminationStatus)"])
            var line = payload
            line.append(Data("\n".utf8))
            sendChunk(connection, line)
        }
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    do {
        try process.run()
    } catch {
        try? FileManager.default.removeItem(at: tempURL)
        let payload = jsonData(["type": "error", "message": error.localizedDescription])
        var line = payload
        line.append(Data("\n".utf8))
        sendChunk(connection, line)
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

func parseRequest(_ data: Data) -> Request? {
    guard let marker = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let headerData = data[..<marker.lowerBound]
    guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
    let lines = headerText.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return nil }
    let requestParts = requestLine.split(separator: " ")
    guard requestParts.count >= 2 else { return nil }

    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
        guard let colon = line.firstIndex(of: ":") else { continue }
        let key = line[..<colon].lowercased()
        let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        headers[key] = value
    }

    let bodyStart = marker.upperBound
    let body = data[bodyStart...]
    return Request(method: String(requestParts[0]), path: String(requestParts[1].split(separator: "?").first ?? ""), headers: headers, body: Data(body))
}

func expectedRequestLength(_ data: Data) -> Int? {
    let sep = Data("\r\n\r\n".utf8)
    guard let marker = data.range(of: sep) else { return nil }
    let headerData = data[..<marker.lowerBound]
    guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
    var contentLength = 0
    for line in headerText.components(separatedBy: "\r\n").dropFirst() {
        let lower = line.lowercased()
        if lower.hasPrefix("content-length:") {
            contentLength = Int(lower.replacingOccurrences(of: "content-length:", with: "").trimmingCharacters(in: .whitespaces)) ?? 0
        }
    }
    return marker.upperBound + contentLength
}

func handleRequest(_ connection: NWConnection, request: Request) {
    let origin = request.headers["origin"]
    if request.method == "OPTIONS" {
        sendOptions(connection, request: request)
        return
    }
    if !isAllowedOrigin(origin) {
        sendJson(connection, status: 403, ["code": 403, "message": "origin not allowed"], origin: origin)
        return
    }

    switch (request.method, request.path) {
    case ("GET", "/"):
        sendResponse(connection, status: 200, contentType: "text/html; charset=utf-8", body: bridgeHomeHTML(), origin: origin)
    case ("GET", "/api/bridge/status"), ("GET", "/api/bridge/version"):
        sendJson(connection, status: 200, bridgeStatus(), origin: origin)
    case ("GET", "/api/device/probe"), ("GET", "/api/native-usb/probe"):
        handleProbe(connection, request: request)
    case ("POST", "/api/firmware/upgrade"), ("POST", "/api/native-usb/upgrade"):
        handleUpgrade(connection, request: request)
    default:
        sendJson(connection, status: 404, ["code": 404, "message": "not found"], origin: origin)
    }
}

func receiveRequest(_ connection: NWConnection, buffer: Data = Data()) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
        if let error {
            fputs("receive error: \(error)\n", stderr)
            connection.cancel()
            return
        }

        var next = buffer
        if let data { next.append(data) }
        if next.count > maxBodyBytes {
            sendJson(connection, status: 400, ["code": 400, "message": "request body too large"], origin: nil)
            return
        }

        if let expected = expectedRequestLength(next), next.count >= expected, let request = parseRequest(Data(next.prefix(expected))) {
            handleRequest(connection, request: request)
            return
        }

        if isComplete {
            connection.cancel()
            return
        }

        receiveRequest(connection, buffer: next)
    }
}

let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
listener.newConnectionHandler = { connection in
    connection.stateUpdateHandler = { state in
        if case .ready = state {
            receiveRequest(connection)
        }
    }
    connection.start(queue: .global())
}
listener.start(queue: .main)
print("TUP Upgrade Bridge running at http://\(host):\(port)")
dispatchMain()
