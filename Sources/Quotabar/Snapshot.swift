import AppKit
import SwiftUI

/// 开发用：`Quotabar --snapshot <目录>` 会在屏幕外渲染各个页面（浅色 + 深色）存成 PNG，然后退出。
/// 用来检查界面效果，不用真的去点状态栏。
enum Snapshot {
    static var directory: String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    @MainActor
    static func run(store: Store, dir: String) async {
        try? await Task.sleep(for: .seconds(4))  // 等数据加载完
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let pages: [(String, ContentView.Tab?)] = [
            ("usage", .usage), ("sessions", .sessions), ("stats", .stats), ("settings", nil),
        ]
        for (mode, name) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            for (page, tab) in pages {
                if let tab { UserDefaults.standard.set(tab.rawValue, forKey: "tab") }
                // -stage YES：带展示背景和仿状态栏（README 截图用）
                let stage = UserDefaults.standard.bool(forKey: "stage")
                let view = Group {
                    if stage { Stage(open: true, startInSettings: tab == nil) }
                    else { ContentView(startInSettings: tab == nil) }
                }
                .environmentObject(store)
                let host = NSHostingView(rootView: view)
                host.appearance = NSAppearance(named: name)
                let size = host.fittingSize
                let win = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: size.width, height: size.height),
                                   styleMask: .borderless, backing: .buffered, defer: false)
                win.appearance = NSAppearance(named: name)
                win.contentView = host
                win.orderFrontRegardless()
                try? await Task.sleep(for: .milliseconds(600))
                // 内容高度是布局后才量出来的，再按最终尺寸调整一次窗口
                win.setContentSize(host.fittingSize)
                try? await Task.sleep(for: .milliseconds(400))

                if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                    host.cacheDisplay(in: host.bounds, to: rep)
                    let url = URL(fileURLWithPath: dir).appendingPathComponent("\(page)-\(mode).png")
                    try? rep.representation(using: .png, properties: [:])?.write(to: url)
                }
                win.orderOut(nil)
            }
        }
        UserDefaults.standard.set(ContentView.Tab.usage.rawValue, forKey: "tab")
        exit(0)
    }
}
