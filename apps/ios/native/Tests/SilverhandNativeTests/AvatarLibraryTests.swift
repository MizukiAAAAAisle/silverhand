import CoreGraphics
import XCTest

@testable import SilverhandNative

final class AvatarLibraryTests: XCTestCase {
  func testBundledLibraryParsesEveryCategory() throws {
    let library = try AvatarLibrary.bundled()
    XCTAssertGreaterThan(library.version, 0)
    XCTAssertFalse(library.categories.isEmpty)
    XCTAssertFalse(library.backgrounds.isEmpty)
    for category in library.categories {
      XCTAssertFalse(category.parts.isEmpty, category.id)
    }
  }

  func testNormalizeFallsBackToCategoryDefaults() throws {
    let library = try AvatarLibrary.bundled()
    let eyes = try XCTUnwrap(library.categories.first { !$0.optional })
    let glasses = try XCTUnwrap(library.categories.first { $0.optional })

    let config = library.normalized(
      parts: [eyes.id: -1, glasses.id: -1, "unknown": 3], bg: library.backgrounds.count)

    XCTAssertEqual(config.parts[eyes.id], eyes.defaultIndex)
    XCTAssertEqual(config.parts[glasses.id], -1)
    XCTAssertNil(config.parts["unknown"])
    XCTAssertEqual(config.bg, 0)
  }

  func testRandomConfigStaysInRange() throws {
    let library = try AvatarLibrary.bundled()
    for _ in 0..<50 {
      let config = library.randomConfig()
      XCTAssertEqual(library.normalized(parts: config.parts, bg: config.bg), config)
    }
  }

  func testTransformAppliesRightToLeft() {
    let transform = AvatarLibrary.transform("translate(10 0) scale(2)")
    XCTAssertEqual(CGPoint(x: 1, y: 1).applying(transform), CGPoint(x: 12, y: 2))

    let rotated = AvatarLibrary.transform("rotate(90 10 10)")
    let point = CGPoint(x: 20, y: 10).applying(rotated)
    XCTAssertEqual(point.x, 10, accuracy: 0.0001)
    XCTAssertEqual(point.y, 20, accuracy: 0.0001)
  }

  func testRelativeArcEndsWhereSvgDoes() {
    let path = AvatarLibrary.path("M10 10 a5 5 0 1 1 10 0")
    XCTAssertEqual(path.currentPoint.x, 20, accuracy: 0.0001)
    XCTAssertEqual(path.currentPoint.y, 10, accuracy: 0.0001)
    XCTAssertEqual(path.boundingBoxOfPath.minY, 5, accuracy: 0.01)
  }
}
