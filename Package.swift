// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Quotabar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Quotabar", path: "Sources/Quotabar")
    ]
)
