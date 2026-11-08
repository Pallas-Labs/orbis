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
        // Built while a Set is in the player, not on the tap, so the move starts on the next
        // frame instead of after the page is first laid out.
        if model.audioPlayer.currentSetId != nil {
          ExpandingPlayer(model: model, barFrame: barFrame, isPresented: $isPresented)
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
    /// Grows the player when it turns true. The player sets it false once it is back in the bar.
    @Binding var isPresented: Bool

    @State private var isExpanded = false
    /// True while the player grows or shrinks. The artwork then flies as one copy over both ends.
    @State private var isMoving = false
    /// How far a drag has pulled the open player down.
    @State private var pull: CGFloat = 0
    /// The window's bounds, which the player fills when open.
    @State private var screen = CGRect.zero
    /// Changes when the window changes size mid-move, which ends the move where it was going,
    /// without animation: the frames it set out between are gone.
    @State private var moveGeneration = 0
    @Namespace private var namespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A drag past this, or a flick that would carry past twice it, closes the player.
    private static let closingPull: CGFloat = 140
    private static let thumbID = "mini-player-thumb"

    private var animation: Animation? {
      OrbisMotion.playerExpanded.curve(reduceMotion: reduceMotion).animation
    }

    /// The mini player's artwork: 64 by 36, inset 8 from the bar's leading edge and centred on it.
    private var thumbFrame: CGRect {
      CGRect(x: barFrame.minX + 8, y: barFrame.midY - 18, width: 64, height: 36)
    }

    var body: some View {
      let set = model.playingSet
      ZStack {
        GeometryReader { proxy in
          ZStack(alignment: .topLeading) {
            Color.black
              .opacity(isExpanded ? 0.35 * (1 - min(pull / max(proxy.size.height, 1), 1)) : 0)
            Color.clear
              .frame(width: thumbFrame.width, height: thumbFrame.height)
              .matchedGeometryEffect(id: Self.thumbID, in: namespace)
              // `position`, not `offset`: the move reads the laid-out frame, which an offset
              // leaves at the corner.
              .position(x: thumbFrame.midX, y: thumbFrame.midY)
          }
          .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
          } action: {
            screen = $0
          }
        }
        .ignoresSafeArea()
        player(set)
        // Always present, so the copy is already at one end when a move starts.
        if let set {
          flyingArtwork(set)
            .opacity(isMoving ? 1 : 0)
        }
      }
      // A new identity drops the move's animations, so a resize mid-move lands at once.
      .id(moveGeneration)
      .offset(y: pull)
      .gesture(pullDown, isEnabled: isExpanded && !isMoving)
      .allowsHitTesting(isExpanded || isMoving)
      // Folded, its buttons stay out of a keyboard's reach and its Escape shortcut unclaimed.
      .disabled(!isExpanded && !isMoving)
      .accessibilityHidden(!isExpanded)
      .accessibilityAddTraits(isExpanded ? .isModal : [])
      .onChange(of: isPresented, initial: true) { _, isPresented in
        if isPresented, !isExpanded { expand() }
        if !isPresented, isExpanded { collapse() }
      }
      .onChange(of: screen.size) { landMove() }
    }

    /// Ends a move at its target without animation, when the window changes size under it, as
    /// opening or closing an iPhone Duo does.
    private func landMove() {
      guard isMoving else { return }
      isMoving = false
      pull = 0
      moveGeneration += 1
      if !isExpanded { isPresented = false }
    }

    /// Now Playing, laid out once at full size and only moved and clipped while it grows, so no
    /// frame of the move lays the page out again. Folded, it is a window the size of the bar onto
    /// the top of the page, lowered to the bar; open, the window is the screen. The page's content
    /// fades in quicker than the window grows, so it is in place before the move ends.
    private func player(_ set: SavedSet?) -> some View {
      ZStack {
        NowPlayingBackground(set: set)
        NowPlayingScreen(
          model: model, close: collapse, artworkAnchor: namespace, hidesArtwork: isMoving,
          drawsBackground: false
        )
        .opacity(isExpanded ? 1 : 0)
        .animation(isExpanded ? .easeOut(duration: 0.22).delay(0.06) : .easeIn(duration: 0.12), value: isExpanded)
      }
      // The bar's own glass shows until the dark page has covered it, on the way out as well.
      .opacity(isExpanded ? 1 : 0)
      .animation(
        isExpanded ? .easeOut(duration: 0.14) : .easeIn(duration: 0.12).delay(0.26), value: isExpanded
      )
      .offset(y: isExpanded ? 0 : barFrame.minY - screen.minY)
      .mask {
        GeometryReader { proxy in
          let origin = proxy.frame(in: .global).origin
          let window = isExpanded ? screen : barFrame
          // Concentric with the display's own corners, whatever the display: in the bar the
          // corners are the capsule's, and over the window they are the display's.
          // `position`, not `offset`, so the shape is laid out where it is drawn and measures
          // its corners from there.
          ConcentricRectangle(
            corners: .concentric(minimum: .fixed(barFrame.height / 2)), isUniform: true
          )
          .frame(width: window.width, height: window.height)
          .position(x: window.midX - origin.x, y: window.midY - origin.y)
        }
      }
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
      move(expanded: false) { isPresented = false }
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
