// KV cache: none; the interface never touches the bytes sent to the model.
// The glyph set and colour switch every screen draws with: Unicode or the ASCII fallback
// (unicodeSupported), and the basic named colours unless NO_COLOR is set.

import { createContext, useContext } from "react";
import { glyphs, unicodeSupported, type Glyphs, type Tone } from "./format.ts";

export interface Theme extends Glyphs {
  unicode: boolean;
  color: boolean;
  /** A horizontal rule and the code gutter: box-drawing, or ASCII. */
  rule: string;
  bar: string;
}

export function makeTheme(env: Record<string, string | undefined>, platform: string = process.platform): Theme {
  const unicode = unicodeSupported(env, platform);
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  return { ...glyphs(unicode), unicode, color: !noColor, rule: unicode ? "─" : "-", bar: unicode ? "│" : "|" };
}

export const ThemeContext = createContext<Theme>(makeTheme({}, "linux"));

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

const TONES: Record<Tone, string> = { ok: "green", warn: "yellow", high: "red" };

/** A named colour, or undefined when NO_COLOR is set. */
export function paint(theme: Theme, color: string | undefined): string | undefined {
  return theme.color ? color : undefined;
}

export function toneColor(theme: Theme, tone: Tone | undefined): string | undefined {
  return tone ? paint(theme, TONES[tone]) : undefined;
}

/** One styled run of text on a line; a Line is a list of them, already cut to the width. */
export interface Span {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
}
export type Line = Span[];

export function span(text: string, style: Omit<Span, "text"> = {}): Span {
  return { text, ...style };
}
