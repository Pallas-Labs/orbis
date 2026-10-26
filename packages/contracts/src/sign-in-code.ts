/** A Sign-in Code (ADR 0020) uses an alphabet without 0/O and 1/I/L look-alikes. */
export const SIGN_IN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Accepts `abcd-efgh`, `ABCD EFGH`, and `ABCDEFGH` as the same code. */
export const normalizeSignInCode = (input: string): string =>
  input.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

/**
 * A code people type or read out: how many characters, which characters, and
 * how its slots group, such as `ABCD EFGH` for `[4, 4]`.
 */
export interface CodeFormat {
  readonly length: number;
  readonly alphabet: string;
  readonly groups: readonly number[];
}

export const SIGN_IN_CODE: CodeFormat = {
  alphabet: SIGN_IN_CODE_ALPHABET,
  groups: [4, 4],
  length: 8,
};

/** A Group Passcode (ADR 0020): 12 characters from the same alphabet, about 59 bits. */
export const GROUP_PASSCODE: CodeFormat = {
  alphabet: SIGN_IN_CODE_ALPHABET,
  groups: [4, 4, 4],
  length: 12,
};

const linkFragment = (text: string): string | null => {
  try {
    const { hash } = new URL(text.trim());
    return hash === "" ? null : hash.slice(1);
  } catch {
    return null;
  }
};

/**
 * The code in `text`: a link's fragment when text is a link with one, in
 * capitals, only alphabet characters, at most `length`. A pasted Join Link
 * such as `https://orbis.p11a.xyz/join#K7Q2M9XH4RPA` keeps only its passcode.
 */
export const codeFromText = (format: CodeFormat, text: string): string =>
  [...(linkFragment(text) ?? text).toUpperCase()]
    .filter((character) => format.alphabet.includes(character))
    .join("")
    .slice(0, format.length);
