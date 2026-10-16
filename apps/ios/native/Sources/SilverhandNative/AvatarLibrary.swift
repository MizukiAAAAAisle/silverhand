import CoreGraphics
import Foundation

/// Indices into the library, the same shape the web stores: -1 leaves an optional category empty.
public struct AvatarConfig: Equatable {
  public var parts: [String: Int]
  public var bg: Int

  public init(parts: [String: Int], bg: Int) {
    self.parts = parts
    self.bg = bg
  }
}

/// The avatar part library shared with the web editor. `AvatarLibrary.json` is copied
/// from app-ui at build time; nodes are the small SVG subset the web renderer emits,
/// so a new tag or attribute there has to be taught here too.
public final class AvatarLibrary {
  public struct Category {
    public let id: String
    public let view: CGRect
    public let optional: Bool
    public let defaultIndex: Int
    public let randomSkip: Double
    public let parts: [Part]
  }

  public struct Part {
    let front: [Node]
    let back: [Node]
    let hides: [String]
  }

  struct Node {
    var path: CGPath?
    var children: [Node] = []
    var transform: CGAffineTransform = .identity
    var fill: CGColor?
    var stroke: CGColor?
    var strokeWidth: CGFloat = 1
    var lineCap: CGLineCap = .butt
    var lineJoin: CGLineJoin = .miter
    var evenOdd = false
  }

  public let version: Int
  public let size: CGFloat
  public let categories: [Category]
  public let backgrounds: [CGColor]
  let order: [String]
  let face: [Node]

  public static func bundled() throws -> AvatarLibrary {
    guard let url = Bundle.module.url(forResource: "AvatarLibrary", withExtension: "json") else {
      throw ClientError.invalidResponse
    }
    return try AvatarLibrary(json: Data(contentsOf: url))
  }

  public init(json: Data) throws {
    guard let root = try JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      throw ClientError.invalidResponse
    }
    version = root["version"] as? Int ?? 0
    size = CGFloat(root["size"] as? Double ?? 200)
    order = root["order"] as? [String] ?? []
    face = Self.nodes(root["face"])
    backgrounds = (root["backgrounds"] as? [String] ?? []).compactMap(Self.color)
    categories = (root["categories"] as? [[String: Any]] ?? []).map { raw in
      let view = (raw["view"] as? [Double] ?? [0, 0, 200, 200]).map { CGFloat($0) }
      return Category(
        id: raw["id"] as? String ?? "",
        view: CGRect(x: view[0], y: view[1], width: view[2], height: view[3]),
        optional: raw["optional"] as? Bool ?? false,
        defaultIndex: raw["default"] as? Int ?? 0,
        randomSkip: raw["randomSkip"] as? Double ?? 0,
        parts: (raw["parts"] as? [[String: Any]] ?? []).map { part in
          Part(
            front: Self.nodes(part["front"]), back: Self.nodes(part["back"]),
            hides: part["hides"] as? [String] ?? [])
        })
    }
  }

  // MARK: Configs

  public func defaultConfig() -> AvatarConfig {
    AvatarConfig(
      parts: Dictionary(uniqueKeysWithValues: categories.map { ($0.id, $0.defaultIndex) }), bg: 0)
  }

  public func randomConfig() -> AvatarConfig {
    AvatarConfig(
      parts: Dictionary(
        uniqueKeysWithValues: categories.map { category in
          let skip = category.optional && Double.random(in: 0..<1) < category.randomSkip
          return (category.id, skip || category.parts.isEmpty ? -1 : Int.random(in: 0..<category.parts.count))
        }),
      bg: backgrounds.isEmpty ? 0 : Int.random(in: 0..<backgrounds.count))
  }

  /// Out-of-range or missing entries fall back to the category default, as on the web.
  public func normalized(parts: [String: Int], bg: Int) -> AvatarConfig {
    var result: [String: Int] = [:]
    for category in categories {
      let index = parts[category.id] ?? category.defaultIndex
      let valid = index < category.parts.count && (index >= 0 || (index == -1 && category.optional))
      result[category.id] = valid ? index : category.defaultIndex
    }
    return AvatarConfig(parts: result, bg: bg >= 0 && bg < backgrounds.count ? bg : 0)
  }

  // MARK: Drawing (y-down context)

  /// The whole avatar, full bleed, scaled to a `side` × `side` square.
  public func draw(_ config: AvatarConfig, in context: CGContext, side: CGFloat) {
    var selected: [String: Part] = [:]
    for category in categories {
      let index = config.parts[category.id] ?? -1
      if category.parts.indices.contains(index) { selected[category.id] = category.parts[index] }
    }
    let hidden = Set(selected.values.flatMap(\.hides))

    context.saveGState()
    context.scaleBy(x: side / size, y: side / size)
    for slot in order {
      switch slot {
      case "background":
        let color = backgrounds.indices.contains(config.bg) ? backgrounds[config.bg] : backgrounds.first
        if let color {
          context.setFillColor(color)
          context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        }
      case "face":
        Self.draw(face, in: context)
      default:
        let pieces = slot.split(separator: ".").map(String.init)
        let id = pieces[0]
        guard !hidden.contains(id), let part = selected[id] else { continue }
        Self.draw(pieces.count > 1 && pieces[1] == "back" ? part.back : part.front, in: context)
      }
    }
    context.restoreGState()
  }

  /// One part alone, cropped to its own drawing so small parts don't read as specks.
  public func drawPart(category categoryId: String, index: Int, in context: CGContext, side: CGFloat) {
    guard let category = categories.first(where: { $0.id == categoryId }),
      category.parts.indices.contains(index)
    else { return }
    let part = category.parts[index]
    let nodes = part.back + part.front
    let crop = Self.thumbnailCrop(Self.bounds(nodes, .identity))

    context.saveGState()
    context.scaleBy(x: side / crop.width, y: side / crop.height)
    context.translateBy(x: -crop.minX, y: -crop.minY)
    Self.draw(nodes, in: context)
    context.restoreGState()
  }

  static func thumbnailCrop(_ box: CGRect) -> CGRect {
    let padding: CGFloat = 0.14
    let minimumSide: CGFloat = 28
    let side = max(box.width, box.height, minimumSide) * (1 + padding * 2)
    return CGRect(x: box.midX - side / 2, y: box.midY - side / 2, width: side, height: side)
  }

  static func draw(_ nodes: [Node], in context: CGContext) {
    for node in nodes {
      context.saveGState()
      context.concatenate(node.transform)
      if let path = node.path {
        if let fill = node.fill {
          context.addPath(path)
          context.setFillColor(fill)
          context.fillPath(using: node.evenOdd ? .evenOdd : .winding)
        }
        if let stroke = node.stroke {
          context.addPath(path)
          context.setStrokeColor(stroke)
          context.setLineWidth(node.strokeWidth)
          context.setLineCap(node.lineCap)
          context.setLineJoin(node.lineJoin)
          context.strokePath()
        }
      } else {
        draw(node.children, in: context)
      }
      context.restoreGState()
    }
  }

  static func bounds(_ nodes: [Node], _ outer: CGAffineTransform) -> CGRect {
    nodes.reduce(CGRect.null) { box, node in
      let transform = node.transform.concatenating(outer)
      if let path = node.path {
        return box.union(path.boundingBoxOfPath.applying(transform))
      }
      return box.union(bounds(node.children, transform))
    }
  }

  // MARK: Parsing

  static func nodes(_ value: Any?) -> [Node] {
    (value as? [[String: Any]] ?? []).compactMap(node)
  }

  static func node(_ raw: [String: Any]) -> Node? {
    func number(_ key: String) -> CGFloat { CGFloat(raw[key] as? Double ?? 0) }

    var node = Node()
    switch raw["t"] as? String {
    case "g":
      node.children = nodes(raw["c"])
    case "path":
      node.path = path(raw["d"] as? String ?? "")
    case "circle":
      let r = number("r")
      node.path = CGPath(
        ellipseIn: CGRect(x: number("cx") - r, y: number("cy") - r, width: r * 2, height: r * 2),
        transform: nil)
    case "ellipse":
      let rx = number("rx")
      let ry = number("ry")
      node.path = CGPath(
        ellipseIn: CGRect(x: number("cx") - rx, y: number("cy") - ry, width: rx * 2, height: ry * 2),
        transform: nil)
    case "rect":
      let rect = CGRect(x: number("x"), y: number("y"), width: number("width"), height: number("height"))
      let corner = min(number("rx"), rect.width / 2, rect.height / 2)
      node.path = CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    default:
      return nil
    }

    node.transform = transform(raw["transform"] as? String ?? "")
    if node.path != nil {
      // SVG paints an unstyled shape black and leaves its stroke off.
      node.fill = (raw["fill"] as? String).map(color) ?? CGColor(gray: 0, alpha: 1)
      node.stroke = (raw["stroke"] as? String).flatMap(color)
      node.strokeWidth = raw["strokeWidth"] == nil ? 1 : number("strokeWidth")
      node.lineCap = ["round": .round, "square": .square][raw["strokeLinecap"] as? String ?? ""] ?? .butt
      node.lineJoin = ["round": .round, "bevel": .bevel][raw["strokeLinejoin"] as? String ?? ""] ?? .miter
      node.evenOdd = raw["fillRule"] as? String == "evenodd"
    }
    return node
  }

  static func color(_ value: String) -> CGColor? {
    guard value.hasPrefix("#") else { return nil }
    var hex = String(value.dropFirst())
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return nil }
    return CGColor(
      srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
  }

  /// `translate`, `rotate` (with an optional centre) and `scale`, applied right to left as in SVG.
  static func transform(_ value: String) -> CGAffineTransform {
    var result = CGAffineTransform.identity
    let pattern = try! NSRegularExpression(pattern: #"(\w+)\(([^)]*)\)"#)
    let range = NSRange(value.startIndex..., in: value)
    for match in pattern.matches(in: value, range: range) {
      guard let nameRange = Range(match.range(at: 1), in: value),
        let argsRange = Range(match.range(at: 2), in: value)
      else { continue }
      let args = numbers(String(value[argsRange]))
      let step: CGAffineTransform
      switch value[nameRange] {
      case "translate":
        step = CGAffineTransform(translationX: args.first ?? 0, y: args.count > 1 ? args[1] : 0)
      case "scale":
        let x = args.first ?? 1
        step = CGAffineTransform(scaleX: x, y: args.count > 1 ? args[1] : x)
      case "rotate":
        let angle = (args.first ?? 0) * .pi / 180
        let cx = args.count > 2 ? args[1] : 0
        let cy = args.count > 2 ? args[2] : 0
        step = CGAffineTransform(translationX: -cx, y: -cy)
          .concatenating(CGAffineTransform(rotationAngle: angle))
          .concatenating(CGAffineTransform(translationX: cx, y: cy))
      default:
        continue
      }
      result = step.concatenating(result)
    }
    return result
  }

  static func numbers(_ value: String) -> [CGFloat] {
    let pattern = try! NSRegularExpression(pattern: #"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"#)
    return pattern.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap {
      Range($0.range, in: value).flatMap { Double(value[$0]) }.map { CGFloat($0) }
    }
  }

  /// Path data with M L H V C Q A Z, absolute and relative.
  static func path(_ data: String) -> CGPath {
    let path = CGMutablePath()
    let pattern = try! NSRegularExpression(pattern: #"([MmLlHhVvCcQqAaZz])([^MmLlHhVvCcQqAaZz]*)"#)
    var current = CGPoint.zero
    var start = CGPoint.zero

    for match in pattern.matches(in: data, range: NSRange(data.startIndex..., in: data)) {
      guard let commandRange = Range(match.range(at: 1), in: data),
        let argsRange = Range(match.range(at: 2), in: data)
      else { continue }
      let command = Character(String(data[commandRange]))
      let relative = command.isLowercase
      let args = numbers(String(data[argsRange]))
      func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      }

      switch command.uppercased() {
      case "M":
        for (n, i) in stride(from: 0, to: args.count - 1, by: 2).enumerated() {
          current = point(args[i], args[i + 1])
          if n == 0 {
            path.move(to: current)
            start = current
          } else {
            path.addLine(to: current)
          }
        }
      case "L":
        for i in stride(from: 0, to: args.count - 1, by: 2) {
          current = point(args[i], args[i + 1])
          path.addLine(to: current)
        }
      case "H":
        for x in args {
          current = CGPoint(x: relative ? current.x + x : x, y: current.y)
          path.addLine(to: current)
        }
      case "V":
        for y in args {
          current = CGPoint(x: current.x, y: relative ? current.y + y : y)
          path.addLine(to: current)
        }
      case "C":
        for i in stride(from: 0, to: args.count - 5, by: 6) {
          let c1 = point(args[i], args[i + 1])
          let c2 = point(args[i + 2], args[i + 3])
          current = point(args[i + 4], args[i + 5])
          path.addCurve(to: current, control1: c1, control2: c2)
        }
      case "Q":
        for i in stride(from: 0, to: args.count - 3, by: 4) {
          let control = point(args[i], args[i + 1])
          current = point(args[i + 2], args[i + 3])
          path.addQuadCurve(to: current, control: control)
        }
      case "A":
        for i in stride(from: 0, to: args.count - 6, by: 7) {
          let end = point(args[i + 5], args[i + 6])
          addArc(
            to: path, from: current, to: end, radii: CGSize(width: args[i], height: args[i + 1]),
            rotation: args[i + 2], large: args[i + 3] != 0, sweep: args[i + 4] != 0)
          current = end
        }
      case "Z":
        path.closeSubpath()
        current = start
      default:
        break
      }
    }
    return path
  }

  /// SVG's endpoint arc, converted to its centre form (SVG 1.1 F.6.5).
  static func addArc(
    to path: CGMutablePath, from p1: CGPoint, to p2: CGPoint, radii: CGSize, rotation: CGFloat,
    large: Bool, sweep: Bool
  ) {
    var rx = abs(radii.width)
    var ry = abs(radii.height)
    guard rx > 0, ry > 0, p1 != p2 else {
      path.addLine(to: p2)
      return
    }
    let phi = rotation * .pi / 180
    let (sinPhi, cosPhi) = (sin(phi), cos(phi))
    let dx = (p1.x - p2.x) / 2
    let dy = (p1.y - p2.y) / 2
    let x1 = cosPhi * dx + sinPhi * dy
    let y1 = -sinPhi * dx + cosPhi * dy
    let lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lambda > 1 {
      rx *= lambda.squareRoot()
      ry *= lambda.squareRoot()
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    let coefficient = (large == sweep ? -1 : 1) * max(0, numerator / denominator).squareRoot()
    let cx1 = coefficient * rx * y1 / ry
    let cy1 = -coefficient * ry * x1 / rx
    let center = CGPoint(
      x: cosPhi * cx1 - sinPhi * cy1 + (p1.x + p2.x) / 2,
      y: sinPhi * cx1 + cosPhi * cy1 + (p1.y + p2.y) / 2)

    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    }
    let startAngle = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep && delta > 0 { delta -= 2 * .pi }
    if sweep && delta < 0 { delta += 2 * .pi }

    let unit = CGAffineTransform(scaleX: rx, y: ry)
      .concatenating(CGAffineTransform(rotationAngle: phi))
      .concatenating(CGAffineTransform(translationX: center.x, y: center.y))
    path.addArc(
      center: .zero, radius: 1, startAngle: startAngle, endAngle: startAngle + delta,
      clockwise: delta < 0, transform: unit)
  }
}
