import AVFoundation

/// Ringback tones while a live call connects, so it is clear the agent is not on the line yet.
/// European tone: 425 Hz, one second on, three off.
@MainActor
final class Ringback {
    private var player: AVAudioPlayer?

    func start() {
        guard player == nil, let player = try? AVAudioPlayer(data: Self.tone) else { return }
        player.numberOfLoops = -1
        player.volume = 0.5
        player.play()
        self.player = player
    }

    func stop() {
        player?.stop()
        player = nil
    }

    private static let tone: Data = {
        let rate = 24_000
        let on = rate, off = rate * 3
        var samples = [Int16](repeating: 0, count: on + off)
        let fade = rate / 50
        for i in 0..<on {
            // Short fades avoid clicks at the edges.
            let edge = min(Double(min(i, on - 1 - i)) / Double(fade), 1)
            samples[i] = Int16(sin(2 * .pi * 425 * Double(i) / Double(rate)) * edge * 0.6 * Double(Int16.max))
        }
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(rate)); append(UInt32(rate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(bytes))
        samples.forEach { append($0) }
        return data
    }()
}
