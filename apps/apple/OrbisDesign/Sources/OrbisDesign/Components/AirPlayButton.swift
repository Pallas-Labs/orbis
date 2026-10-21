import AVKit
import SwiftUI

public struct AirPlayButton: View {
  /// The icon's colour while the sound plays here.
  let color: Color

  public init(color: Color = .primary) {
    self.color = color
  }

  public var body: some View {
    RoutePicker(color: color)
      .frame(width: 44, height: 44)
      .accessibilityLabel("AirPlay")
      .accessibilityIdentifier("airplay")
  }
}

#if os(macOS)
  private struct RoutePicker: NSViewRepresentable {
    let color: Color

    func makeNSView(context: Context) -> AVRoutePickerView {
      let picker = AVRoutePickerView()
      picker.isRoutePickerButtonBordered = false
      picker.setRoutePickerButtonColor(NSColor(color), for: .normal)
      picker.setRoutePickerButtonColor(NSColor(Color.orbis.tint), for: .activeHighlighted)
      picker.setRoutePickerButtonColor(NSColor(Color.orbis.tint), for: .active)
      return picker
    }

    func updateNSView(_ picker: AVRoutePickerView, context: Context) {}
  }
#else
  private struct RoutePicker: UIViewRepresentable {
    let color: Color

    func makeUIView(context: Context) -> AVRoutePickerView {
      let picker = AVRoutePickerView()
      picker.prioritizesVideoDevices = false
      picker.activeTintColor = UIColor(Color.orbis.tint)
      picker.tintColor = UIColor(color)
      return picker
    }

    func updateUIView(_ picker: AVRoutePickerView, context: Context) {}
  }
#endif

#Preview("AirPlay") {
  AirPlayButton()
    .padding()
    .background(Color.orbis.paper)
}
