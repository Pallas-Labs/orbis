import type { CSSProperties, StyleXStyles } from "@stylexjs/stylex";

/**
 * The styles a caller may pass a component as `xstyle`: only the properties named here, so a
 * component decides what about it can change. Any other property is a type error.
 */
export type Overrides<Property extends keyof CSSProperties> = StyleXStyles<
  Pick<CSSProperties, Property>
>;
