import SwiftUI

@main
struct QuotabarApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            ContentView()
                .environmentObject(store)
        } label: {
            if store.menuBarShowsWarning {
                Image(systemName: "exclamationmark.triangle")
            } else {
                HStack(spacing: 3) {
                    Image(systemName: store.menuBarSymbol)
                    Text(store.menuBarText)
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}
