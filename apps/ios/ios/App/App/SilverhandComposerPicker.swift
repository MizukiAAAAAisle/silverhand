import UIKit

struct ComposerPickerRow: Equatable {
  enum Icon: Equatable {
    /// A picture drawn as it is.
    case image(String)
    /// A glyph native tints, on a round ground when `ground`.
    case glyph(String, ground: Bool)
  }

  let id, title: String
  let handle, detail, section: String?
  let icon: Icon
  let dimmed: Bool
}

struct ComposerPicker: Equatable {
  let rows: [ComposerPickerRow]
  let footer: String?
}

/// The `@` / `#` candidates above the composer, in its glass. The page ranks
/// them and applies a pick; this lists them and reports the row tapped.
@MainActor
final class ComposerPickerView: UIView {
  var onPick: ((String) -> Void)?

  private static let radius: CGFloat = 22
  private static let inset: CGFloat = 6
  private static let rowHeight: CGFloat = 48
  private static let visibleRows: CGFloat = 4.5
  private static let icon: CGFloat = 30

  private let backdrop: UIVisualEffectView
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private let footer = UILabel()
  private let footerRule = UIView()
  private(set) var picker: ComposerPicker?

  override init(frame: CGRect) {
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: .regular)
      backdrop = UIVisualEffectView(effect: glass)
      backdrop.cornerConfiguration = .uniformCorners(radius: .fixed(Self.radius))
    } else {
      backdrop = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
      backdrop.layer.cornerRadius = Self.radius
      backdrop.clipsToBounds = true
    }
    super.init(frame: frame)
    addSubview(backdrop)

    stack.axis = .vertical
    scroll.addSubview(stack)
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = false
    backdrop.contentView.addSubview(scroll)

    footer.font = .preferredFont(forTextStyle: .footnote)
    footer.adjustsFontForContentSizeCategory = true
    footer.textColor = .secondaryLabel
    footerRule.backgroundColor = .separator
    backdrop.contentView.addSubview(footerRule)
    backdrop.contentView.addSubview(footer)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Lists `next`; nil leaves nothing to show.
  func apply(_ next: ComposerPicker?) {
    guard next != picker else { return }
    let reordered = next?.rows.map(\.id) != picker?.rows.map(\.id)
    picker = next
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for row in next?.rows ?? [] {
      if let section = row.section { stack.addArrangedSubview(Self.header(section)) }
      let view = ComposerPickerRowView(row)
      view.addAction(UIAction { [weak self] _ in self?.onPick?(row.id) }, for: .touchUpInside)
      stack.addArrangedSubview(view)
    }
    footer.text = next?.footer
    footer.isHidden = next?.footer == nil
    footerRule.isHidden = footer.isHidden || next?.rows.isEmpty != false
    if reordered { scroll.contentOffset = .zero }
    setNeedsLayout()
  }

  /// The height the list wants, its rows capped to a few before it scrolls.
  var preferredHeight: CGFloat {
    guard let picker else { return 0 }
    let width = max(0, bounds.width - Self.inset * 2)
    let content = stack.systemLayoutSizeFitting(
      CGSize(width: width, height: 0), withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel
    ).height
    let rows = picker.rows.isEmpty ? 0 : min(content, Self.rowHeight * Self.visibleRows)
    let note = picker.footer == nil ? 0 : footerHeight
    return ceil(rows + note + Self.inset * 2)
  }

  private var footerHeight: CGFloat { ceil(footer.font.lineHeight) + 16 }

  override func layoutSubviews() {
    super.layoutSubviews()
    backdrop.frame = bounds
    let width = max(0, bounds.width - Self.inset * 2)
    let note = picker?.footer == nil ? 0 : footerHeight
    scroll.frame = CGRect(
      x: Self.inset, y: Self.inset, width: width,
      height: max(0, bounds.height - Self.inset * 2 - note))
    let content = stack.systemLayoutSizeFitting(
      CGSize(width: width, height: 0), withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel
    ).height
    stack.frame = CGRect(x: 0, y: 0, width: width, height: content)
    scroll.contentSize = stack.frame.size
    footerRule.frame = CGRect(
      x: 0, y: scroll.frame.maxY, width: bounds.width, height: 1 / traitCollection.displayScale)
    footer.frame = CGRect(x: 18, y: scroll.frame.maxY, width: bounds.width - 36, height: note)
  }

  private static func header(_ text: String) -> UIView {
    let label = UILabel()
    label.text = text.uppercased()
    label.font = UIFontMetrics(forTextStyle: .caption2).scaledFont(
      for: .systemFont(ofSize: 11, weight: .semibold))
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .secondaryLabel
    let host = UIView()
    host.addSubview(label)
    label.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -12),
      label.topAnchor.constraint(equalTo: host.topAnchor, constant: 8),
      label.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -4),
    ])
    return host
  }

  fileprivate static func iconImage(_ icon: ComposerPickerRow.Icon) -> UIImage? {
    let bounds = CGRect(x: 0, y: 0, width: Self.icon, height: Self.icon)
    switch icon {
    case .image(let png):
      guard let data = Data(base64Encoded: png), let picture = UIImage(data: data, scale: 3) else {
        return nil
      }
      return UIGraphicsImageRenderer(bounds: bounds).image { _ in
        UIBezierPath(ovalIn: bounds).addClip()
        picture.draw(in: bounds)
      }
    case .glyph(let png, let ground):
      return BarGlyphs.image(png, size: ground ? 18 : 20)
    }
  }
}

/// One candidate: its face, its name, and its handle or place under it.
@MainActor
private final class ComposerPickerRowView: UIControl {
  private let highlight = UIView()

  init(_ row: ComposerPickerRow) {
    super.init(frame: .zero)
    accessibilityTraits = .button
    isAccessibilityElement = true
    accessibilityLabel = [row.title, row.handle, row.detail].compactMap { $0 }.joined(
      separator: ", ")

    highlight.backgroundColor = .tertiarySystemFill
    highlight.layer.cornerRadius = 14
    highlight.layer.cornerCurve = .continuous
    highlight.alpha = 0
    highlight.isUserInteractionEnabled = false
    addSubview(highlight)

    // A glyph is a template the view tints, so it follows the theme as text does.
    let face = UIImageView(image: ComposerPickerView.iconImage(row.icon))
    face.contentMode = .center
    face.tintColor = .secondaryLabel
    if case .glyph(_, true) = row.icon {
      face.backgroundColor = .tertiarySystemFill
      face.layer.cornerRadius = 15
    }

    let title = UILabel()
    title.text = row.title
    title.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
      for: .systemFont(ofSize: 15, weight: .medium))
    title.adjustsFontForContentSizeCategory = true
    title.textColor = .label

    let lines = UIStackView(arrangedSubviews: [title])
    lines.axis = .vertical
    lines.spacing = 1
    if row.handle != nil || row.detail != nil {
      lines.addArrangedSubview(Self.subtitle(handle: row.handle, detail: row.detail))
    }

    let content = UIStackView(arrangedSubviews: [face, lines])
    content.spacing = 12
    content.alignment = .center
    content.isUserInteractionEnabled = false
    content.alpha = row.dimmed ? 0.55 : 1
    addSubview(content)

    content.translatesAutoresizingMaskIntoConstraints = false
    face.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      face.widthAnchor.constraint(equalToConstant: 30),
      face.heightAnchor.constraint(equalToConstant: 30),
      content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      content.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
      heightAnchor.constraint(greaterThanOrEqualToConstant: 46),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0 : 0.2) {
        self.highlight.alpha = self.isHighlighted ? 1 : 0
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    highlight.frame = bounds
  }

  private static func subtitle(handle: String?, detail: String?) -> UILabel {
    let label = UILabel()
    let size = UIFont.preferredFont(forTextStyle: .caption1).pointSize
    let text = NSMutableAttributedString()
    if let handle {
      text.append(
        NSAttributedString(
          string: handle,
          attributes: [.font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular)]))
    }
    if let detail {
      if text.length > 0 { text.append(NSAttributedString(string: "  ")) }
      text.append(
        NSAttributedString(string: detail, attributes: [.font: UIFont.systemFont(ofSize: size)]))
    }
    label.attributedText = text
    label.textColor = .secondaryLabel
    label.lineBreakMode = .byTruncatingTail
    return label
  }
}
