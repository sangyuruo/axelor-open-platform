import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useState } from "react";

import { Input } from "@axelor/ui";

import { FieldControl, FieldProps } from "../../builder";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useInput } from "../../builder/hooks";

export function Text({
  inputProps,
  ...props
}: FieldProps<string> & {
  inputProps?: Pick<
    React.InputHTMLAttributes<HTMLTextAreaElement>,
    "onFocus" | "onBlur" | "autoFocus"
  >;
}) {
  const { schema, readonly, widgetAtom, valueAtom, invalid } = props;
  const { uid, height, placeholder } = schema;
  const { onBlur } = inputProps || {};
  const theme = useAppTheme();

  const { attrs } = useAtomValue(widgetAtom);
  const { required } = attrs;

  const [changed, setChanged] = useState(false);
  const { text, onChange, onBlur: onInputBlur } = useInput(valueAtom);

  const handleChange = useCallback<
    React.ChangeEventHandler<HTMLTextAreaElement>
  >(
    (e) => {
      onChange(e);
      setChanged(true);
    },
    [onChange]
  );

  const handleBlur = useCallback<React.FocusEventHandler<HTMLTextAreaElement>>(
    (e) => {
      if (changed) {
        setChanged(false);
        onInputBlur(e);
      }
      onBlur?.(e);
    },
    [changed, onBlur, onInputBlur]
  );

  return (
    <FieldControl {...props}>
      {readonly ? (
        <Input as="pre" bg={theme === "dark" ? "body" : "light"} mb={0}>
          {text}
        </Input>
      ) : (
        <Input
          data-input
          as="textarea"
          rows={height || 5}
          id={uid}
          invalid={invalid}
          placeholder={placeholder}
          value={text}
          required={required}
          {...inputProps}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      )}
    </FieldControl>
  );
}
