import OrbisDesign
import SwiftUI

#if os(iOS)
  /// Now Playing grows out of the mini player and shrinks back into it, the way Apple Music opens
  /// its player: the bar stretches to fill the screen and the artwork travels from the bar's thumb
  /// to its place on the page. A drag down pulls the player back into the bar.
  ///
  /// The system's zoom cannot do this from the tab view's bottom accessory, which sits outside
  /// the views the zoom searches: on iOS 26 it finds no source and slides a cover up, and on
  /// iOS 27 it stalls halfway. So the player is drawn over the tab view, where both ends of the
  /// move are views on screen together.
  struct NowPlayingExpansion: ViewModifier {
    @Bindable var model: AppModel
    @Binding var isPresented: Bool
    /// The mini player's frame in the window, where the player starts and ends.
    let barFrame: CGRect

    func body(content: Content) -> some View {
      content.overlay {
        if isPresented {
          ExpandingPlayer(model: model, barFrame: barFrame) { isPresented = false }
        }
      }
    }
  }

  extension View {
    func nowPlayingExpansion(
      model: AppModel, isPresented: Binding<Bool>, from barFrame: CGRect
    ) -> some View {
      modifier(NowPlayingExpansion(model: model, isPresented: isPresented, barFrame: barFrame))
    }
  }

  private struct ExpandingPlayer: View {
    @Bindable var model: AppModel
    let barFrame: CGRect
    /// Takes the player off screen once it is back in the bar.
    let dismiss: () -> Void

    @State private var isExpanded = false
    /// True while the player grows or shrinks. The artwork then flies as one copy over both ends.
    @State private var isMoving = false
    /// How far a drag has pulled the open player down.
    @State private var pull: CGFloat = 0
    @Namespace private var namespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A drag past this, or a flick that would carry past twice it, closes the player.
    private static let closingPull: CGFloat = 140
    /// The corners the player takes while a drag pulls it away from the screen's edges.
    private static let pulledRadius: CGFloat = 44
    private static let thumbID = "mini-player-thumb"

    private var animation: Animation? {
      OrbisMotion.playerExpanded.curve(reduceMotion: reduceMotion).animation
    }

    /// The mini player's artwork: 64 by 36, inset 8 from the bar's leading edge and centred on it.
    private var thumbFrame: CGRect {
      CGRect(x: barFrame.minX + 8, y: barFrame.midY - 18, width: 64, height: 36)
    }

    var body: some View {
      let set = model.audioPlayer.currentSetId.flatMap { model.savedSet($0) }
      ZStack {
        GeometryReader { proxy in
          let screen = CGRect(origin: .zero, size: proxy.size)
          ZStack(alignment: .topLeading) {
            Color.black
              .opacity(isExpanded ? 0.35 * (1 - min(pull / screen.height, 1)) : 0)
            surface(set, in: isExpanded ? screen : barFrame)
            Color.clear
              .frame(width: thumbFrame.width, height: thumbFrame.height)
              .matchedGeometryEffect(id: Self.thumbID, in: namespace)
              // `position`, not `offset`: the move reads the laid-out frame, which an offset
              // leaves at the corner.
              .position(x: thumbFrame.midX, y: thumbFrame.midY)
          }
        }
        .ignoresSafeArea()
        if isExpanded {
          NowPlayingScreen(
            model: model, close: collapse, artworkAnchor: namespace, hidesArtwork: isMoving,
            drawsBackground: false
          )
          .transition(.opacity)
        }
        // Always present, so the copy is already at one end when a move starts.
        if let set {
          flyingArtwork(set)
            .opacity(isMoving ? 1 : 0)
        }
      }
      .offset(y: pull)
      .gesture(pullDown, isEnabled: isExpanded && !isMoving)
      .accessibilityAddTraits(.isModal)
      .task { expand() }
    }

    /// The bar's glass, stretched to `frame`, darkening into Now Playing's backdrop as it grows.
    /// Folded back into the bar it is clear, so the real bar shows through.
    private func surface(_ set: SavedSet?, in frame: CGRect) -> some View {
      let radius = isExpanded ? min(pull / 3, Self.pulledRadius) : barFrame.height / 2
      return ZStack {
        Rectangle().fill(.bar)
        NowPlayingBackground(set: set)
      }
      .opacity(isExpanded ? 1 : 0)
      .frame(width: frame.width, height: frame.height)
      .clipShape(.rect(cornerRadius: radius))
      .offset(x: frame.minX, y: frame.minY)
    }

    /// The artwork in flight, from the bar's thumb to Now Playing's artwork or back. It takes the
    /// frame of whichever end it is heading for, and the move animates between the two.
    private func flyingArtwork(_ set: SavedSet) -> some View {
      let player = model.audioPlayer
      let isPlaying = player.state == .playing || player.state == .loading
      return Artwork(
        url: SetPresentation.pageArtwork(set),
        standIn: SetPresentation.row(set).artwork,
        seed: set.title, size: .header,
        cornerRadius: isExpanded ? nil : 6
      )
      // Paused, Now Playing draws its artwork smaller; the copy lands at that size.
      .scaleEffect(isExpanded && !isPlaying ? 0.86 : 1)
      .matchedGeometryEffect(
        id: isExpanded ? MiniPlayer.transitionID : Self.thumbID,
        in: namespace, isSource: false
      )
      .allowsHitTesting(false)
    }

    private var pullDown: some Gesture {
      DragGesture(minimumDistance: 12)
        .onChanged { drag in
          guard drag.translation.height > abs(drag.translation.width) else { return }
          pull = max(drag.translation.height, 0)
        }
        .onEnded { drag in
          if pull > Self.closingPull || drag.predictedEndTranslation.height > Self.closingPull * 2 {
            collapse()
          } else {
            withAnimation(animation) { pull = 0 }
          }
        }
    }

    private func expand() {
      move(expanded: true) {}
    }

    private func collapse() {
      move(expanded: false, then: dismiss)
    }

    private func move(expanded: Bool, then finish: @escaping () -> Void) {
      guard let animation else {
        isExpanded = expanded
        pull = 0
        return finish()
      }
      isMoving = true
      withAnimation(animation) {
        isExpanded = expanded
        pull = 0
      } completion: {
        isMoving = false
        finish()
      }
    }
  }
#endif
