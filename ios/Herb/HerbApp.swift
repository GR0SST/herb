import SwiftUI

@main
struct HerbApp: App {
    // Создаётся при запуске: PushKit должен быть готов, даже когда iOS будит приложение пушем.
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
