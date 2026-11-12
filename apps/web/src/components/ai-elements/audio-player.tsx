"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MediaControlBar,
  MediaController,
  MediaDurationDisplay,
  MediaMuteButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from "media-chrome/react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import type { Overrides } from "@/styles/overrides";
import { colors, fonts, radii, space } from "@/styles/tokens.stylex";

// media-chrome draws its controls in shadow DOM and reads its look from these properties.
const styles = stylex.create({
  player: {
    "--media-background-color": "transparent",
    "--media-button-icon-height": space[4],
    "--media-button-icon-width": space[4],
    "--media-control-background": "transparent",
    "--media-control-hover-background": colors.accent,
    "--media-control-padding": "0",
    "--media-font": fonts.sans,
    "--media-font-size": "10px",
    "--media-icon-color": "currentColor",
    "--media-preview-time-background": colors.background,
    "--media-preview-time-border-radius": radii.md,
    "--media-preview-time-text-shadow": "none",
    "--media-primary-color": colors.primary,
    "--media-range-bar-color": colors.primary,
    "--media-range-track-background": colors.secondary,
    "--media-secondary-color": colors.secondary,
    "--media-text-color": colors.foreground,
    "--media-tooltip-arrow-display": "none",
    "--media-tooltip-background": colors.background,
    "--media-tooltip-border-radius": radii.md,
  },
  time: { fontVariantNumeric: "tabular-nums" },
});

export type AudioPlayerProps = Omit<
  ComponentProps<typeof MediaController>,
  "audio" | "className" | "style"
> & {
  /** How wide the player grows. */
  readonly xstyle?: Overrides<"maxWidth" | "width">;
};

export const AudioPlayer = ({
  children,
  xstyle,
  ...props
}: AudioPlayerProps) => (
  <MediaController
    audio
    data-slot="audio-player"
    {...props}
    {...stylex.props(styles.player, xstyle)}
  >
    {children}
  </MediaController>
);

// Orbis plays remote audio only, so the AI SDK speech-result variant is removed
// here; re-adding this component from the registry would bring it back.
export type AudioPlayerElementProps = ComponentProps<"audio"> & {
  src: string;
};

export const AudioPlayerElement = (props: AudioPlayerElementProps) => (
  <audio data-slot="audio-player-element" slot="media" {...props} />
);

export type AudioPlayerControlBarProps = ComponentProps<typeof MediaControlBar>;

export const AudioPlayerControlBar = ({
  children,
  ...props
}: AudioPlayerControlBarProps) => (
  <MediaControlBar data-slot="audio-player-control-bar" {...props}>
    <ButtonGroup>{children}</ButtonGroup>
  </MediaControlBar>
);

export type AudioPlayerPlayButtonProps = ComponentProps<typeof MediaPlayButton>;

export const AudioPlayerPlayButton = (props: AudioPlayerPlayButtonProps) => (
  <Button
    grouped
    size="icon-sm"
    variant="outline"
    render={<MediaPlayButton data-slot="audio-player-play-button" {...props} />}
  ></Button>
);

export type AudioPlayerSeekBackwardButtonProps = ComponentProps<
  typeof MediaSeekBackwardButton
>;

export const AudioPlayerSeekBackwardButton = ({
  seekOffset = 10,
  ...props
}: AudioPlayerSeekBackwardButtonProps) => (
  <Button
    grouped
    size="icon-sm"
    variant="outline"
    render={
      <MediaSeekBackwardButton
        data-slot="audio-player-seek-backward-button"
        seekOffset={seekOffset}
        {...props}
      />
    }
  ></Button>
);

export type AudioPlayerSeekForwardButtonProps = ComponentProps<
  typeof MediaSeekForwardButton
>;

export const AudioPlayerSeekForwardButton = ({
  seekOffset = 10,
  ...props
}: AudioPlayerSeekForwardButtonProps) => (
  <Button
    grouped
    size="icon-sm"
    variant="outline"
    render={
      <MediaSeekForwardButton
        data-slot="audio-player-seek-forward-button"
        seekOffset={seekOffset}
        {...props}
      />
    }
  ></Button>
);

export type AudioPlayerTimeDisplayProps = ComponentProps<
  typeof MediaTimeDisplay
>;

export const AudioPlayerTimeDisplay = (props: AudioPlayerTimeDisplayProps) => (
  <ButtonGroupText
    render={
      <MediaTimeDisplay
        data-slot="audio-player-time-display"
        {...props}
        {...stylex.props(styles.time)}
      />
    }
  ></ButtonGroupText>
);

export type AudioPlayerTimeRangeProps = ComponentProps<typeof MediaTimeRange>;

export const AudioPlayerTimeRange = (props: AudioPlayerTimeRangeProps) => (
  <ButtonGroupText
    render={<MediaTimeRange data-slot="audio-player-time-range" {...props} />}
  ></ButtonGroupText>
);

export type AudioPlayerDurationDisplayProps = ComponentProps<
  typeof MediaDurationDisplay
>;

export const AudioPlayerDurationDisplay = (
  props: AudioPlayerDurationDisplayProps
) => (
  <ButtonGroupText
    render={
      <MediaDurationDisplay
        data-slot="audio-player-duration-display"
        {...props}
        {...stylex.props(styles.time)}
      />
    }
  ></ButtonGroupText>
);

export type AudioPlayerMuteButtonProps = ComponentProps<typeof MediaMuteButton>;

export const AudioPlayerMuteButton = (props: AudioPlayerMuteButtonProps) => (
  <ButtonGroupText
    render={<MediaMuteButton data-slot="audio-player-mute-button" {...props} />}
  ></ButtonGroupText>
);

export type AudioPlayerVolumeRangeProps = ComponentProps<
  typeof MediaVolumeRange
>;

export const AudioPlayerVolumeRange = (props: AudioPlayerVolumeRangeProps) => (
  <ButtonGroupText
    render={
      <MediaVolumeRange data-slot="audio-player-volume-range" {...props} />
    }
  ></ButtonGroupText>
);
