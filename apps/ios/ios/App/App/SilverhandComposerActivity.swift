import UIKit

struct ComposerActivity: Equatable {
  let id: String
  let faces: [ComposerPickerRow.Icon]
  let title, detail, label: String
  /// When the first agent started, in epoch milliseconds.
  let since: Double
}

/// The agents at work, on one glass line above the composer: their faces, the
/// first one's name and state, and how long it has run. The page decides what
/// it says; this counts the seconds and reports a tap.
@MainActor
final class ComposerActivityView: UIControl {
  static let height: CGFloat = 36

  private static let face: CGFloat = 22
  private static let overlap: CGFloat = 7

  private let backdrop: UIVisualEffectView
  private let faces = UIView()
  private let titleLabel = UILabel()
  private let detailLabel = UILabel()
  private let timeLabel = UILabel()
  private let highlight = UIView()
  private var clock: Timer?
  private(set) var activity: ComposerActivity?

  override init(frame: CGRect) {
    if #available(iOS 26.0, *) {
      backdrop = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
      backdrop.cornerConfiguration = .capsule()
    } else {
      backdrop = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
      backdrop.layer.cornerRadius = Self.height / 2
      backdrop.clipsToBounds = true
    }
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityTraits = .button
    backdrop.isUserInteractionEnabled = false
    addSubview(backdrop)

    highlight.backgroundColor = .tertiarySystemFill
    highlight.alpha = 0
    backdrop.contentView.addSubview(highlight)

    let size = UIFont.preferredFont(forTextStyle: .footnote).pointSize
    titleLabel.font = .systemFont(ofSize: size, weight: .semibold)
    titleLabel.textColor = .label
    detailLabel.font = .systemFont(ofSize: size)
    detailLabel.textColor = .secondaryLabel
    detailLabel.lineBreakMode = .byTruncatingTail
    timeLabel.font = .monospacedDigitSystemFont(ofSize: size, weight: .regular)
    timeLabel.textColor = .secondaryLabel
    titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let row = UIStackView(arrangedSubviews: [faces, titleLabel, detailLabel, timeLabel])
    row.spacing = 6
    row.setCustomSpacing(8, after: faces)
    row.alignment = .center
    row.isUserInteractionEnabled = false
    backdrop.contentView.addSubview(row)
    row.translatesAutoresizingMaskIntoConstraints = false
    backdrop.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      backdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
      backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
      backdrop.topAnchor.constraint(equalTo: topAnchor),
      backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
      heightAnchor.constraint(equalToConstant: Self.height),
      row.leadingAnchor.constraint(equalTo: backdrop.contentView.leadingAnchor, constant: 7),
      row.trailingAnchor.constraint(equalTo: backdrop.contentView.trailingAnchor, constant: -14),
      row.centerYAnchor.constraint(equalTo: backdrop.contentView.centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Shows `next`; nil leaves nothing to show.
  func apply(_ next: ComposerActivity?) {
    guard next != activity else { return }
    let refaced = next?.faces != activity?.faces
    activity = next
    clock?.invalidate()
    clock = nil
    guard let next else { return }
    if refaced { drawFaces(next.faces) }
    titleLabel.text = next.title
    detailLabel.text = next.detail
    accessibilityLabel = next.label
    tick()
    clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
  }

  /// The faces overlap, each ringed in the glass it sits on so the edge reads.
  private func drawFaces(_ icons: [ComposerPickerRow.Icon]) {
    faces.subviews.forEach { $0.removeFromSuperview() }
    for (index, icon) in icons.enumerated() {
      let view = UIImageView(image: Self.faceImage(icon))
      view.contentMode = .center
      view.tintColor = .secondaryLabel
      if case .glyph(_, true) = icon {
        view.backgroundColor = .tertiarySystemFill
        view.layer.cornerRadius = Self.face / 2
      }
      view.frame = CGRect(
        x: CGFloat(index) * (Self.face - Self.overlap), y: 0, width: Self.face, height: Self.face)
      faces.insertSubview(view, at: 0)
    }
    let count = CGFloat(icons.count)
    let width = count == 0 ? 0 : Self.face + (count - 1) * (Self.face - Self.overlap)
    faces.constraints.forEach { faces.removeConstraint($0) }
    faces.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      faces.widthAnchor.constraint(equalToConstant: width),
      faces.heightAnchor.constraint(equalToConstant: Self.face),
    ])
  }

  private func tick() {
    guard let activity else { return }
    let seconds = max(0, Int((Date().timeIntervalSince1970 * 1000 - activity.since) / 1000))
    let minutes = seconds / 60
    let rest = seconds % 60
    timeLabel.text =
      minutes == 0 ? "\(seconds)s" : rest == 0 ? "\(minutes)m" : "\(minutes)m \(rest)s"
  }

  /// Drawn round rather than clipped: the glass reshapes the corners of what
  /// it contains.
  private static func faceImage(_ icon: ComposerPickerRow.Icon) -> UIImage? {
    let bounds = CGRect(x: 0, y: 0, width: face, height: face)
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
      return BarGlyphs.image(png, size: ground ? 14 : 16)
    }
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0 : 0.2) {
        self.highlight.alpha = self.isHighlighted ? 1 : 0
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    highlight.frame = backdrop.contentView.bounds
  }
}
