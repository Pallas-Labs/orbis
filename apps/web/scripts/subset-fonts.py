# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools[woff]==4.60.1"]
# ///
"""Cuts the web app's Inter files down to what the site uses.

Run by hand from the repository root, after `bun install`:

    uv run apps/web/scripts/subset-fonts.py

It reads the wght files of the pinned @fontsource-variable/inter package and
writes the cut files and their @font-face rules to apps/web/src/fonts. Commit
what it writes. Run it again after any of these changes:

- the @fontsource-variable/inter version;
- a new font weight (`font-medium` is 500, the body is 400), including a
  `<b>`, `<strong>`, `<th>` or `<optgroup>`, which the browser draws bolder;
- a new numeric style such as `slashed-zero` or `diagonal-fractions`
  (`tabular-nums` is kept), or any `font-feature-settings`;
- a change to SPLIT_LATIN or CORE below.

Each file keeps every character its fontsource file drew, so text draws in the
same font as before. A page downloads a file only when it shows one of the
characters in that file's unicode-range.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEB = Path(__file__).resolve().parent.parent
PACKAGE = WEB / "node_modules/@fontsource-variable/inter"
OUT = WEB / "src/fonts"

# The site asks for 400 (body text) and 500 (font-medium). The cut keeps 400 to
# 900: 900 is the source's own extreme, so every weight draws exactly as in the
# source. Ending the axis at 500 saves 3.5 KB on the latin file, but rescales
# the outlines and moves points by up to 1/2048 em.
WEIGHT = (400, 900)

# The OpenType features the browser turns on by default and that Inter has,
# plus tnum for tabular-nums. Fontsource's files also carry frac, numr, dnom
# and pnum, which nothing turns on.
FEATURES = ["calt", "ccmp", "kern", "locl", "mark", "mkmk", "tnum"]

# With SPLIT_LATIN, the preloaded inter-latin.woff2 keeps only CORE, and
# inter-latin-extended.woff2 holds the rest of the latin file. It is off: the
# browser shapes each file's characters apart, so "Kölsch" and "Sébastien"
# would lose the kerning and contextual forms that join an accented letter to
# its ASCII neighbours.
SPLIT_LATIN = False
CORE = set(range(0x20, 0x7F)) | {
    0xA0,  # no-break space
    0xB7,  # middle dot
    0x2013,  # en dash
    0x2014,  # em dash
    0x2018,  # left single quotation mark
    0x2019,  # right single quotation mark
    0x201C,  # left double quotation mark
    0x201D,  # right double quotation mark
    0x2026,  # horizontal ellipsis
}


def unicode_ranges(css: str) -> list[tuple[str, set[int]]]:
    """The fontsource subsets in declaration order, with their unicode-range."""
    faces = re.findall(
        r"/\* inter-(.+?)-wght-normal \*/.*?unicode-range: ([^;]+);", css, re.S
    )
    if not faces:
        sys.exit("Found no @font-face rules in the fontsource CSS.")
    return [(name, parse_range(text)) for name, text in faces]


def parse_range(text: str) -> set[int]:
    codepoints = set()
    for part in text.split(","):
        start, _, end = part.strip().removeprefix("U+").partition("-")
        codepoints.update(range(int(start, 16), int(end or start, 16) + 1))
    return codepoints


def format_range(codepoints: set[int]) -> str:
    runs = []
    for codepoint in sorted(codepoints):
        if runs and runs[-1][1] == codepoint - 1:
            runs[-1][1] = codepoint
        else:
            runs.append([codepoint, codepoint])
    return ",".join(
        f"U+{start:04X}" if start == end else f"U+{start:04X}-{end:04X}"
        for start, end in runs
    )


def cut(source: Path, codepoints: set[int], target: Path) -> set[int]:
    """Writes `source` cut to `codepoints` and the weight range, and returns
    the characters the written file draws."""
    font = TTFont(source)
    options = subset.Options()
    options.layout_features = FEATURES
    # Keep fontsource's name table, prep and gasp: they are a few dozen bytes,
    # and gasp sets how Windows smooths small text.
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.hinting = True
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font = instancer.instantiateVariableFont(font, {"wght": WEIGHT})
    # Keep the source's timestamp, so a rerun writes the same bytes.
    font.recalcTimestamp = False
    font.flavor = "woff2"
    font.save(target)
    return set(TTFont(target).getBestCmap())


def face(file: str, codepoints: set[int]) -> str:
    return f"""@font-face {{
  font-family: "Inter Variable";
  font-style: normal;
  font-display: swap;
  font-weight: {WEIGHT[0]} {WEIGHT[1]};
  src: url(./{file}) format("woff2-variations");
  unicode-range: {format_range(codepoints)};
}}
"""


def main() -> None:
    if not PACKAGE.exists():
        sys.exit(f"{PACKAGE} is missing: run `bun install` first.")
    version = json.loads((PACKAGE / "package.json").read_text())["version"]
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.woff2"):
        old.unlink()
    rules = []
    for name, declared in unicode_ranges((PACKAGE / "index.css").read_text()):
        source = PACKAGE / f"files/inter-{name}-wght-normal.woff2"
        drawn = set(TTFont(source).getBestCmap()) & declared
        parts = [(name, drawn)]
        if name == "latin" and SPLIT_LATIN:
            parts = [(f"{name}-extended", drawn - CORE), (name, drawn & CORE)]
        for part, codepoints in parts:
            file = f"inter-{part}.woff2"
            kept = cut(source, codepoints, OUT / file)
            if kept != codepoints:
                sys.exit(f"{file} draws {sorted(kept ^ codepoints)} differently.")
            rules.append(face(file, kept))
            print(f"{file}: {(OUT / file).stat().st_size} bytes, {len(kept)} characters")
    css = OUT / "inter.css"
    css.write_text(
        f"/* Written by apps/web/scripts/subset-fonts.py from\n"
        f"   @fontsource-variable/inter {version}. Do not edit. */\n\n"
        + "\n".join(rules)
    )
    # Lay the rules out as the repository's formatter checks them.
    subprocess.run(["bunx", "oxfmt", str(css)], cwd=WEB, check=True)


if __name__ == "__main__":
    main()
