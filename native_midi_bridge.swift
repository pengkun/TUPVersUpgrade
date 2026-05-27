import CoreMIDI
import Darwin
import Foundation

let stx: UInt8 = 0xF0
let sign1: UInt8 = 0x53
let sign2: UInt8 = 0x57
let etx: UInt8 = 0xF7
let ack: UInt8 = 0x06
let crcError: UInt8 = 0x13
let cmdInit: UInt8 = 0x01
let cmdDataBase: UInt8 = 0x02
let cmdFinish: UInt8 = 0x10
let transferEnd: UInt8 = 0x04
let linesPerCmd = 128
let maxRetry = 3
let timeoutInitMs = 5000
let timeoutDataMs = 5000
let timeoutFinishMs = 10000

func dataAckTimeoutMs(commandLength: Int) -> Int {
    let extra = Int(ceil(Double(commandLength) / 256.0)) * 3000
    return min(30000, max(timeoutDataMs, timeoutDataMs + extra))
}

func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let text = String(data: data, encoding: .utf8) else {
        return
    }
    print(text)
    fflush(stdout)
}

func javaTrim(_ value: String) -> String {
    let scalars = value.unicodeScalars
    var start = scalars.startIndex
    var end = scalars.endIndex
    while start < end && scalars[start].value <= 0x20 {
        start = scalars.index(after: start)
    }
    while start < end {
        let prev = scalars.index(before: end)
        if scalars[prev].value > 0x20 { break }
        end = prev
    }
    return String(String.UnicodeScalarView(scalars[start..<end]))
}

func readFirmwareLines(_ path: String) throws -> [String] {
    let text = try String(contentsOfFile: path, encoding: .utf8)
    return text
        .components(separatedBy: CharacterSet.newlines)
        .map(javaTrim)
        .filter { !$0.isEmpty }
}

func asciiBytes(_ line: String) -> [UInt8] {
    line.unicodeScalars.map { scalar in
        scalar.value <= 0x7F ? UInt8(scalar.value) : UInt8(ascii: "?")
    }
}

func buildControlCommand(_ cmd: UInt8, _ params: [UInt8]) -> [UInt8] {
    [stx, sign1, sign2, cmd, UInt8(params.count & 0xFF)] + params + [etx]
}

func buildDataCommand(_ cmd: UInt8, _ pkt: UInt8, _ data: [UInt8]) -> [UInt8] {
    [stx, sign1, sign2, cmd, pkt] + data + [etx]
}

func isValidUpgradeResponse(_ data: [UInt8]) -> Bool {
    data.count >= 6 && data[0] == stx && data[1] == sign1 && data[2] == sign2 && data[data.count - 1] == etx
}

func isAck(_ data: [UInt8]?) -> Bool {
    guard let data else { return false }
    return data.count >= 6 && data[5] == ack
}

func isCrcError(_ data: [UInt8]?) -> Bool {
    guard let data else { return false }
    return data.count >= 6 && data[5] == crcError
}

func hexString(_ data: [UInt8]?) -> String {
    guard let data else { return "nil" }
    return data.map { String(format: "%02X", $0) }.joined(separator: " ")
}

func endpointName(_ endpoint: MIDIEndpointRef) -> String {
    var value: Unmanaged<CFString>?
    if MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &value) == noErr,
       let retained = value?.takeRetainedValue() {
        return retained as String
    }
    value = nil
    if MIDIObjectGetStringProperty(endpoint, kMIDIPropertyName, &value) == noErr,
       let retained = value?.takeRetainedValue() {
        return retained as String
    }
    return ""
}

func chooseEndpoint(count: Int, getter: (Int) -> MIDIEndpointRef) -> (endpoint: MIDIEndpointRef, name: String)? {
    var endpoints: [(MIDIEndpointRef, String)] = []
    for index in 0..<count {
        let endpoint = getter(index)
        let name = endpointName(endpoint)
        endpoints.append((endpoint, name))
    }
    if let match = endpoints.first(where: { $0.1.range(of: "SoundWalker", options: .caseInsensitive) != nil }) {
        return match
    }
    if let match = endpoints.first(where: { $0.1.range(of: "TupTup", options: .caseInsensitive) != nil }) {
        return match
    }
    return endpoints.first
}

final class MidiBridge {
    private var client = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var outputPort = MIDIPortRef()
    private let destination: MIDIEndpointRef
    private let source: MIDIEndpointRef
    let destinationName: String
    let sourceName: String

    private let responseLock = NSLock()
    private var responseSemaphore: DispatchSemaphore?
    private var responseData: [UInt8]?
    private var rxBuffer: [UInt8] = []

    init() throws {
        guard let dest = chooseEndpoint(count: MIDIGetNumberOfDestinations(), getter: MIDIGetDestination),
              let src = chooseEndpoint(count: MIDIGetNumberOfSources(), getter: MIDIGetSource) else {
            throw NSError(domain: "NativeMidiBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "未找到可用 CoreMIDI 输入/输出端口"])
        }
        destination = dest.endpoint
        destinationName = dest.name
        source = src.endpoint
        sourceName = src.name

        var status = MIDIClientCreate("TUPVersUpgradeBridge" as CFString, nil, nil, &client)
        if status != noErr { throw MidiError.osStatus("MIDIClientCreate", status) }

        status = MIDIOutputPortCreate(client, "TUPVersUpgradeOutput" as CFString, &outputPort)
        if status != noErr { throw MidiError.osStatus("MIDIOutputPortCreate", status) }

        status = MIDIInputPortCreateWithBlock(client, "TUPVersUpgradeInput" as CFString, &inputPort) { [weak self] packetList, _ in
            self?.handlePacketList(packetList)
        }
        if status != noErr { throw MidiError.osStatus("MIDIInputPortCreateWithBlock", status) }

        status = MIDIPortConnectSource(inputPort, source, nil)
        if status != noErr { throw MidiError.osStatus("MIDIPortConnectSource", status) }
    }

    private func handlePacketList(_ packetList: UnsafePointer<MIDIPacketList>) {
        var packet = packetList.pointee.packet
        for _ in 0..<packetList.pointee.numPackets {
            let bytes = withUnsafeBytes(of: packet.data) { rawBuffer in
                Array(rawBuffer.prefix(Int(packet.length)))
            }
            handleBytes(bytes)
            packet = MIDIPacketNext(&packet).pointee
        }
    }

    private func handleBytes(_ bytes: [UInt8]) {
        responseLock.lock()
        defer { responseLock.unlock() }
        for byte in bytes {
            if byte == stx {
                rxBuffer = [stx]
                continue
            }
            if rxBuffer.isEmpty { continue }
            rxBuffer.append(byte)
            if byte == etx {
                let message = rxBuffer
                rxBuffer.removeAll()
                if isValidUpgradeResponse(message) {
                    responseData = message
                    responseSemaphore?.signal()
                }
            }
        }
    }

    func sendAndWait(_ command: [UInt8], timeoutMs: Int) throws -> [UInt8]? {
        let semaphore = DispatchSemaphore(value: 0)
        responseLock.lock()
        responseData = nil
        responseSemaphore = semaphore
        responseLock.unlock()

        try sendPacketList(command)

        let result = semaphore.wait(timeout: .now() + .milliseconds(timeoutMs))
        responseLock.lock()
        defer {
            responseSemaphore = nil
            responseLock.unlock()
        }
        if result == .success {
            return responseData
        }
        return nil
    }

    private func sendPacketList(_ bytes: [UInt8]) throws {
        let listSize = MemoryLayout<MIDIPacketList>.size + bytes.count + 1024
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: listSize,
            alignment: MemoryLayout<MIDIPacketList>.alignment
        )
        raw.initializeMemory(as: UInt8.self, repeating: 0, count: listSize)
        defer { raw.deallocate() }

        let packetList = raw.assumingMemoryBound(to: MIDIPacketList.self)
        var packet = MIDIPacketListInit(packetList)
        let status: OSStatus = bytes.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return OSStatus(paramErr) }
            packet = MIDIPacketListAdd(
                packetList,
                listSize,
                packet,
                MIDITimeStamp(mach_absolute_time()),
                bytes.count,
                base
            )
            return MIDISend(outputPort, destination, packetList)
        }
        if status != noErr {
            throw MidiError.osStatus("MIDISend", status)
        }
    }
}

enum MidiError: Error, LocalizedError {
    case osStatus(String, OSStatus)

    var errorDescription: String? {
        switch self {
        case .osStatus(let op, let status):
            return "\(op) failed: OSStatus \(status)"
        }
    }
}

func statusCommand() {
    var destinations: [[String: Any]] = []
    for index in 0..<MIDIGetNumberOfDestinations() {
        let endpoint = MIDIGetDestination(index)
        destinations.append(["index": index, "name": endpointName(endpoint)])
    }
    var sources: [[String: Any]] = []
    for index in 0..<MIDIGetNumberOfSources() {
        let endpoint = MIDIGetSource(index)
        sources.append(["index": index, "name": endpointName(endpoint)])
    }
    emit(["type": "status", "destinations": destinations, "sources": sources])
}

func upgradeCommand(filePath: String) throws {
    let bridge = try MidiBridge()
    emit(["type": "connected", "destination": bridge.destinationName, "source": bridge.sourceName])

    let lines = try readFirmwareLines(filePath)
    if lines.isEmpty {
        throw NSError(domain: "NativeMidiBridge", code: 3, userInfo: [NSLocalizedDescriptionKey: "升级文件为空或格式错误"])
    }
    emit(["type": "log", "message": "固件读取完成，共 \(lines.count) 行"])

    emit(["type": "progress", "stage": "初始化", "percent": 0])
    let initResponse = try bridge.sendAndWait(buildControlCommand(cmdInit, []), timeoutMs: timeoutInitMs)
    guard isAck(initResponse) else {
        throw NSError(domain: "NativeMidiBridge", code: 4, userInfo: [NSLocalizedDescriptionKey: "初始化失败：未收到ACK"])
    }
    Thread.sleep(forTimeInterval: 0.2)

    emit(["type": "progress", "stage": "传输中", "percent": 1])
    for index in 0..<lines.count {
        let cmd = UInt8(Int(cmdDataBase) + (index / linesPerCmd))
        let pkt = UInt8(index % linesPerCmd)
        let lineBytes = asciiBytes(lines[index])
        let command = buildDataCommand(cmd, pkt, lineBytes)
        let timeoutMs = dataAckTimeoutMs(commandLength: command.count)
        if index < 5 {
            emit(["type": "log", "message": "发送行\(index + 1): dataLen=\(lineBytes.count), sysexLen=\(command.count), timeout=\(timeoutMs)ms, transport=CoreMIDI/MIDISend"])
        }

        var ok = false
        for retry in 1...maxRetry {
            let response = try bridge.sendAndWait(command, timeoutMs: timeoutMs)
            if isAck(response) {
                ok = true
                break
            }
            if isCrcError(response) {
                emit(["type": "log", "message": "第\(index + 1)行 CRC 错误，重试 \(retry)/\(maxRetry)"])
            } else if response != nil {
                emit(["type": "log", "message": "第\(index + 1)行 异常响应 \(hexString(response))，重试 \(retry)/\(maxRetry)"])
            } else {
                emit(["type": "log", "message": "第\(index + 1)行 等待ACK超时(\(timeoutMs)ms)，重试 \(retry)/\(maxRetry)"])
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if !ok {
            throw NSError(domain: "NativeMidiBridge", code: 5, userInfo: [NSLocalizedDescriptionKey: "数据传输失败，行号 \(index + 1)"])
        }

        if index % 10 == 0 || index == lines.count - 1 {
            let percent = ((index + 1) * 100) / lines.count
            emit(["type": "progress", "stage": "传输中", "percent": percent, "current": index + 1, "total": lines.count])
        }
    }

    emit(["type": "progress", "stage": "结束中", "percent": 99])
    let finishResponse = try bridge.sendAndWait(buildControlCommand(cmdFinish, [transferEnd]), timeoutMs: timeoutFinishMs)
    guard isAck(finishResponse) else {
        throw NSError(domain: "NativeMidiBridge", code: 6, userInfo: [NSLocalizedDescriptionKey: "结束升级失败：未收到ACK"])
    }
    emit(["type": "progress", "stage": "升级成功", "percent": 100])
    emit(["type": "success", "message": "升级完成"])
}

do {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        throw NSError(domain: "NativeMidiBridge", code: 64, userInfo: [NSLocalizedDescriptionKey: "missing command"])
    }

    switch args[1] {
    case "status":
        statusCommand()
    case "upgrade":
        guard args.count >= 3 else {
            throw NSError(domain: "NativeMidiBridge", code: 64, userInfo: [NSLocalizedDescriptionKey: "missing firmware file"])
        }
        try upgradeCommand(filePath: args[2])
    default:
        throw NSError(domain: "NativeMidiBridge", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown command: \(args[1])"])
    }
} catch {
    emit(["type": "error", "message": error.localizedDescription])
    exit(1)
}
