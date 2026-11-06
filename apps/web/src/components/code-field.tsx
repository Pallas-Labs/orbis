import { codeFromText } from "@orbis/contracts";
import type { CodeFormat } from "@orbis/contracts";
import { OTPInputContext } from "input-otp";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { detach } from "@/lib/detach";
import { useCopy } from "@/lib/use-copy";

/** Each group's slot indexes, such as `[[0, 1, 2, 3], [4, 5, 6, 7]]` for `[4, 4]`. */
const slotGroups = (format: CodeFormat) =>
  format.groups.map((size, group) => {
    const start = format.groups
      .slice(0, group)
      .reduce((sum, each) => sum + each, 0);
    return Array.from({ length: size }, (_, offset) => start + offset);
  });

const Slots = ({
  className,
  format,
}: {
  readonly className?: string;
  readonly format: CodeFormat;
}) =>
  slotGroups(format).map((indexes) => (
    <InputOTPGroup className="min-w-0 flex-1" key={indexes[0]}>
      {indexes.map((index) => (
        <InputOTPSlot className={className} index={index} key={index} />
      ))}
    </InputOTPGroup>
  ));

/**
 * Types a code into one slot per character. Characters outside the format's
 * alphabet never enter, lower case becomes capitals, and a pasted `abcd-efgh`
 * or link fills every slot, even when the slots already hold a code.
 * `onComplete` runs when the last slot fills or a whole new code is pasted.
 * `initialCode` fills the slots when the field first appears.
 */
export const CodeField = ({
  format,
  id,
  initialCode = "",
  label,
  name,
  onComplete,
}: {
  readonly format: CodeFormat;
  readonly id: string;
  readonly initialCode?: string | undefined;
  readonly label: string;
  readonly name: string;
  readonly onComplete: () => void;
}) => {
  const [code, setCode] = useState(() => codeFromText(format, initialCode));
  // input-otp pastes at the selection, which is the last slot of a full field,
  // so a whole pasted code is kept here and replaces the field.
  const pastedCode = useRef<string | null>(null);
  const change = (text: string) => {
    const next = pastedCode.current ?? codeFromText(format, text);
    pastedCode.current = null;
    if (next === code) {
      return;
    }
    // The form reads the hidden input, so it must hold the code before submit.
    flushSync(() => {
      setCode(next);
    });
    if (next.length === format.length) {
      onComplete();
    }
  };
  return (
    <InputOTP
      aria-label={label}
      autoCapitalize="characters"
      containerClassName="w-full gap-2"
      id={id}
      inputMode={/^\d+$/u.test(format.alphabet) ? "numeric" : "text"}
      maxLength={format.length}
      name={name}
      onChange={change}
      pasteTransformer={(text) => {
        const pasted = codeFromText(format, text);
        pastedCode.current = pasted.length === format.length ? pasted : null;
        return pasted;
      }}
      pattern={`^[${format.alphabet}${format.alphabet.toLowerCase()}]*$`}
      value={code}
    >
      <Slots className="h-10 w-auto min-w-0 flex-1 text-base" format={format} />
    </InputOTP>
  );
};

/**
 * A code to read from across a table, in the slots `CodeField` types it into,
 * with a button that copies it. Screen readers hear it one character at a time.
 */
export const ShownCode = ({
  code,
  copyLabel,
  format,
  label,
}: {
  readonly code: string;
  readonly copyLabel: string;
  readonly format: CodeFormat;
  readonly label: string;
}) => {
  const { copy, copyText } = useCopy(code);
  // oxlint-disable-next-line typescript/no-misused-spread -- sign-in codes are ASCII, so each code point is one character.
  const characters = [...code];
  const spoken = slotGroups(format)
    .map((indexes) => indexes.map((index) => characters[index]).join(" "))
    .join(", ");
  return (
    <div className="flex flex-col items-center gap-3">
      <div aria-label={label} role="status">
        <span className="sr-only">{spoken}</span>
        <OTPInputContext.Provider
          value={{
            isFocused: false,
            isHovering: false,
            slots: characters.map((char) => ({
              char,
              hasFakeCaret: false,
              isActive: false,
              placeholderChar: null,
            })),
          }}
        >
          <div aria-hidden="true" className="flex items-center gap-2">
            <Slots
              className="size-11 min-w-0 shrink text-2xl"
              format={format}
            />
          </div>
        </OTPInputContext.Provider>
      </div>
      <Button onClick={detach(copyText)} size="sm" variant="outline">
        {copy === "copied" ? "Copied" : copyLabel}
      </Button>
      {copy === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          Could not copy the code. Type it instead.
        </p>
      ) : null}
    </div>
  );
};
