import SwiftUI

@main
struct HerbApp: App {
    // Created at launch: PushKit must be ready even when a push wakes the app.
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
