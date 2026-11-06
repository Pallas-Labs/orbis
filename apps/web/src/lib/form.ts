/** A text field's value, or "" when the form has no such field or it holds a file. */
export const formText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return value instanceof File ? "" : (value ?? "");
};

/** A text field's trimmed value, or "" when the form has no such field. */
export const formField = (form: FormData, name: string): string =>
  formText(form, name).trim();
