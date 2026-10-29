import type { Json } from "./protocol";
export function enumOptions(
  schema: Json,
): Array<{ value: string; label: string }> | null {
  const values = schema.type === "array" ? schema.items : schema;
  if (values?.enum)
    return values.enum.map((value: string, index: number) => ({
      value,
      label: values.enumNames?.[index] ?? value,
    }));
  const choices = values?.oneOf ?? values?.anyOf;
  return choices
    ? choices.map((entry: Json) => ({
        value: String(entry.const),
        label: entry.title ?? String(entry.const),
      }))
    : null;
}
export function validateFormValue(
  key: string,
  schema: Json,
  value: unknown,
  required: boolean,
): unknown {
  if (
    value === "" ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  ) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  const options = enumOptions(schema);
  if (schema.type === "array") {
    if (!Array.isArray(value))
      throw new Error(`${key}: choose a list of values`);
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new Error(
        `${key}: choose ${schema.minItems ?? 0}–${schema.maxItems ?? "any"} options`,
      );
    if (value.some((v) => !options?.some((o) => o.value === v)))
      throw new Error(`${key}: invalid option`);
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      (schema.type === "integer" && !Number.isInteger(number))
    )
      throw new Error(`${key}: enter a valid ${schema.type}`);
    if (
      number < (schema.minimum ?? -Infinity) ||
      number > (schema.maximum ?? Infinity)
    )
      throw new Error(`${key}: value is outside the allowed range`);
    return number;
  }
  if (schema.type === "boolean") return Boolean(value);
  const text = String(value);
  if (options && !options.some((o) => o.value === text))
    throw new Error(`${key}: invalid option`);
  if (
    text.length < (schema.minLength ?? 0) ||
    text.length > (schema.maxLength ?? Infinity)
  )
    throw new Error(`${key}: text length is outside the allowed range`);
  return text;
}
