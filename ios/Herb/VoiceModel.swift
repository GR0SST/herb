import CryptoKit
import Foundation
import Observation

/// A Supertonic voice style. Lily is the default.
struct SpeechVoice: Identifiable, Hashable {
    let id: String
    let name: String
    let detail: String

    static let all: [SpeechVoice] = [
        SpeechVoice(id: "F2", name: "Lily", detail: "Bright"),
        SpeechVoice(id: "F1", name: "Sarah", detail: "Calm, low"),
        SpeechVoice(id: "F3", name: "Jessica", detail: "Clear"),
        SpeechVoice(id: "F4", name: "Olivia", detail: "Crisp"),
        SpeechVoice(id: "F5", name: "Emily", detail: "Kind"),
        SpeechVoice(id: "M1", name: "Alex", detail: "Lively"),
        SpeechVoice(id: "M2", name: "James", detail: "Deep"),
        SpeechVoice(id: "M3", name: "Robert", detail: "Polished"),
        SpeechVoice(id: "M4", name: "Sam", detail: "Soft"),
        SpeechVoice(id: "M5", name: "Daniel", detail: "Warm"),
    ]

    static let storageKey = "voice"

    /// The chosen voice, read on every message.
    static var selected: SpeechVoice {
        let id = UserDefaults.standard.string(forKey: storageKey)
        return all.first { $0.id == id } ?? all[0]
    }
}

/// The on-device Supertonic voice, downloaded on request so the app stays small.
/// Without it, calls speak with the iOS voice.
@MainActor
@Observable
final class VoiceModel {
    enum State: Equatable {
        case missing
        case downloading(Double)
        case ready
        case failed(String)
    }

    static let shared = VoiceModel()

    private struct File {
        let path: String
        let name: String
        let size: Int64
        /// SHA-256 for the large files. Small files are checked by size.
        let sha256: String?
    }

    private static let repo = "https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46"
    private static let files: [File] = [
        File(path: "onnx/duration_predictor.onnx", name: "duration_predictor.onnx", size: 3_700_147,
             sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db"),
        File(path: "onnx/text_encoder.onnx", name: "text_encoder.onnx", size: 36_416_150,
             sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff"),
        File(path: "onnx/vector_estimator.onnx", name: "vector_estimator.onnx", size: 256_534_781,
             sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c"),
        File(path: "onnx/vocoder.onnx", name: "vocoder.onnx", size: 101_424_195,
             sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba"),
        File(path: "onnx/tts.json", name: "tts.json", size: 8_253, sha256: nil),
        File(path: "onnx/unicode_indexer.json", name: "unicode_indexer.json", size: 277_676, sha256: nil),
        File(path: "voice_styles/F1.json", name: "F1.json", size: 292_046, sha256: nil),
        File(path: "voice_styles/F2.json", name: "F2.json", size: 292_423, sha256: nil),
        File(path: "voice_styles/F3.json", name: "F3.json", size: 290_794, sha256: nil),
        File(path: "voice_styles/F4.json", name: "F4.json", size: 291_808, sha256: nil),
        File(path: "voice_styles/F5.json", name: "F5.json", size: 291_479, sha256: nil),
        File(path: "voice_styles/M1.json", name: "M1.json", size: 291_748, sha256: nil),
        File(path: "voice_styles/M2.json", name: "M2.json", size: 292_055, sha256: nil),
        File(path: "voice_styles/M3.json", name: "M3.json", size: 290_198, sha256: nil),
        File(path: "voice_styles/M4.json", name: "M4.json", size: 291_522, sha256: nil),
        File(path: "voice_styles/M5.json", name: "M5.json", size: 291_469, sha256: nil),
        File(path: "LICENSE", name: "Supertonic-Model-LICENSE.txt", size: 15_007, sha256: nil),
    ]

    static let totalBytes = files.reduce(0) { $0 + $1.size }

    nonisolated static var directory: URL {
        URL.applicationSupportDirectory.appending(path: "VoiceModel", directoryHint: .isDirectory)
    }

    /// Checked by size: the hash was verified when the file was downloaded.
    nonisolated static var isInstalled: Bool {
        files.allSatisfy { file in
            let attributes = try? FileManager.default.attributesOfItem(atPath: directory.appending(path: file.name).path)
            return (attributes?[.size] as? NSNumber)?.int64Value == file.size
        }
    }

    private(set) var state: State
    private var task: Task<Void, Never>?

    private init() {
        state = Self.isInstalled ? .ready : .missing
    }

    func download() {
        guard task == nil else { return }
        state = .downloading(0)
        task = Task {
            defer { task = nil }
            do {
                try await install()
                state = .ready
            } catch is CancellationError {
                state = .missing
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func cancel() {
        task?.cancel()
    }

    func delete() {
        task?.cancel()
        SupertonicEngine.shared.unload()
        try? FileManager.default.removeItem(at: Self.directory)
        state = .missing
    }

    private func install() async throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: Self.directory, withIntermediateDirectories: true)
        var done: Int64 = 0
        for file in Self.files {
            let target = Self.directory.appending(path: file.name)
            if let size = (try? fileManager.attributesOfItem(atPath: target.path))?[.size] as? NSNumber, size.int64Value == file.size {
                done += file.size
                continue
            }
            let start = done
            let downloaded = try await fetch(URL(string: "\(Self.repo)/\(file.path)")!) { [weak self] received in
                self?.state = .downloading(Double(start + received) / Double(Self.totalBytes))
            }
            try await Self.verify(downloaded, file)
            try? fileManager.removeItem(at: target)
            try fileManager.moveItem(at: downloaded, to: target)
            done += file.size
            state = .downloading(Double(done) / Double(Self.totalBytes))
        }
        // Not needed on other devices and easy to download again.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var directory = Self.directory
        try? directory.setResourceValues(values)
    }

    /// Downloads to a temporary file, reporting bytes as they arrive.
    private func fetch(_ url: URL, progress: @escaping (Int64) -> Void) async throws -> URL {
        var continuation: CheckedContinuation<URL, Error>?
        let download = URLSession.shared.downloadTask(with: url) { location, response, error in
            if let error { return continuation?.resume(throwing: error) ?? () }
            guard let location, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return continuation?.resume(throwing: APIError.message("Could not download the voice")) ?? ()
            }
            // The system deletes the file when this handler returns, so keep it elsewhere.
            let kept = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            do {
                try FileManager.default.moveItem(at: location, to: kept)
                continuation?.resume(returning: kept)
            } catch {
                continuation?.resume(throwing: error)
            }
        }
        let watcher = Task {
            while !Task.isCancelled {
                progress(download.countOfBytesReceived)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { watcher.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (resume: CheckedContinuation<URL, Error>) in
                continuation = resume
                download.resume()
            }
        } onCancel: {
            download.cancel()
        }
    }

    private nonisolated static func verify(_ url: URL, _ file: File) async throws {
        try await Task.detached(priority: .utility) {
            let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
            guard size == file.size else { throw APIError.message("The voice download is incomplete. Try again") }
            guard let expected = file.sha256 else { return }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
                hash.update(data: chunk)
            }
            let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard digest == expected else { throw APIError.message("The voice download is damaged. Try again") }
        }.value
    }
}
