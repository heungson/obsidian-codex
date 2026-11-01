type Schema = Record<string, unknown>;

function record(value: unknown): Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : {};
}
function bound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function enumOptions(
  schemaValue: unknown,
): Array<{ value: string; label: string }> | null {
  const schema = record(schemaValue);
  const values = schema.type === "array" ? record(schema.items) : schema;
  if (Array.isArray(values.enum)) {
    const names: unknown[] = Array.isArray(values.enumNames)
      ? values.enumNames
      : [];
    return values.enum.flatMap((value: unknown, index: number) => {
      if (typeof value !== "string") return [];
      const label = names[index];
      return [{ value, label: typeof label === "string" ? label : value }];
    });
  }
  const choices = values.oneOf ?? values.anyOf;
  if (!Array.isArray(choices)) return null;
  return choices.map((choice: unknown) => {
    const entry = record(choice);
    const value = String(entry.const);
    return {
      value,
      label: typeof entry.title === "string" ? entry.title : value,
    };
  });
}
export function validateFormValue(
  key: string,
  schemaValue: unknown,
  value: unknown,
  required: boolean,
): unknown {
  const schema = record(schemaValue);
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
    const min = bound(schema.minItems, 0),
      max = bound(schema.maxItems, Infinity);
    if (value.length < min || value.length > max)
      throw new Error(
        `${key}: choose ${min}–${Number.isFinite(max) ? max : "any"} options`,
      );
    if (value.some((v: unknown) => !options?.some((o) => o.value === v)))
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
      number < bound(schema.minimum, -Infinity) ||
      number > bound(schema.maximum, Infinity)
    )
      throw new Error(`${key}: value is outside the allowed range`);
    return number;
  }
  if (schema.type === "boolean") return Boolean(value);
  const text = String(value);
  if (options && !options.some((o) => o.value === text))
    throw new Error(`${key}: invalid option`);
  if (
    text.length < bound(schema.minLength, 0) ||
    text.length > bound(schema.maxLength, Infinity)
  )
    throw new Error(`${key}: text length is outside the allowed range`);
  return text;
}
