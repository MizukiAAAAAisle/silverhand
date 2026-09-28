// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SilverhandNative",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "SilverhandNative", targets: ["SilverhandNative"])],
    targets: [
        .target(name: "SilverhandNative", resources: [.process("Resources")]),
        .testTarget(name: "SilverhandNativeTests", dependencies: ["SilverhandNative"])
    ]
)
