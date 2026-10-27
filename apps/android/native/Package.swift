// swift-tools-version: 6.1
// This is a Skip (https://skip.dev) package.
import PackageDescription

let package = Package(
    name: "silverhand-android-core",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SilverhandCore", type: .dynamic, targets: ["SilverhandCore"]),
    ],
    dependencies: [
        .package(path: "../core"),
        .package(url: "https://github.com/skiptools/skip.git", from: "1.9.16"),
        .package(url: "https://github.com/skiptools/skip-fuse.git", from: "1.0.0")
    ],
    targets: [
        .target(name: "SilverhandCore", dependencies: [
            .product(name: "SkipFuse", package: "skip-fuse"),
            .product(name: "SilverhandNative", package: "core")
        ], plugins: [.plugin(name: "skipstone", package: "skip")]),
    ],
    swiftLanguageModes: [.v5]
)
