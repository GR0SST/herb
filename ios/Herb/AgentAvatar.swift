import SwiftUI

/// An agent's picture: the logo of a known product found in its name, or its first letter.
struct AgentAvatar: View {
    let name: String
    var size: CGFloat = 40

    private struct Brand {
        let asset: String
        /// Single-colour logos are tinted white on a dark circle; colour logos sit on white.
        let tinted: Bool
        /// The picture already fills its square, so it covers the whole circle.
        var fills = false
    }

    // Longer names first, so "Claude Code" wins over "Claude".
    private static let brands: [(keys: [String], brand: Brand)] = [
        (["claude code", "claudecode"], Brand(asset: "claudecode", tinted: false)),
        (["claude", "anthropic"], Brand(asset: "claude", tinted: false)),
        (["codex"], Brand(asset: "codex", tinted: false, fills: true)),
        (["chatgpt", "openai", "gpt"], Brand(asset: "openai", tinted: true)),
        (["grok", "xai"], Brand(asset: "grok", tinted: true)),
        (["gemini"], Brand(asset: "gemini", tinted: false)),
        (["openbot"], Brand(asset: "openbot", tinted: false, fills: true)),
        (["openclaw"], Brand(asset: "openclaw", tinted: false)),
        (["hermes"], Brand(asset: "hermes", tinted: true)),
        (["perplexity"], Brand(asset: "perplexity", tinted: false)),
        (["deepseek"], Brand(asset: "deepseek", tinted: false)),
        (["mistral"], Brand(asset: "mistral", tinted: false)),
        (["cursor"], Brand(asset: "cursor", tinted: true)),
        (["manus"], Brand(asset: "manus", tinted: true)),
        (["kimi"], Brand(asset: "kimi", tinted: false)),
        (["qwen"], Brand(asset: "qwen", tinted: false)),
        (["ollama"], Brand(asset: "ollama", tinted: true)),
        (["copilot"], Brand(asset: "copilot", tinted: true)),
    ]

    private var brand: Brand? {
        let lower = name.lowercased()
        return Self.brands.first { entry in entry.keys.contains { lower.contains($0) } }?.brand
    }

    var body: some View {
        Group {
            if let brand {
                logo(brand)
            } else {
                Text(name.prefix(1).uppercased())
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Color(.systemBackground))
                    .frame(width: size, height: size)
                    .background(Color.accentColor, in: Circle())
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func logo(_ brand: Brand) -> some View {
        let image = Image("Agents/\(brand.asset)").resizable().scaledToFit()
        if brand.fills {
            image.frame(width: size, height: size).clipShape(Circle())
        } else if brand.tinted {
            image
                .foregroundStyle(.white)
                .frame(width: size * 0.56, height: size * 0.56)
                .frame(width: size, height: size)
                .background(Color.black, in: Circle())
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.12)))
        } else {
            image
                .frame(width: size * 0.6, height: size * 0.6)
                .frame(width: size, height: size)
                .background(Color.white, in: Circle())
                .overlay(Circle().strokeBorder(Color.black.opacity(0.08)))
        }
    }
}
