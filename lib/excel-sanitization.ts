/**
 * Neutralizes user/external text that spreadsheet applications may interpret
 * as a formula. Numeric values and Excel formula objects are deliberately left
 * untouched by callers that use sanitizeExcelCellValue.
 *
 * A leading tab/CR is escaped even without a following =/+/-/@: some
 * spreadsheet parsers still treat a control-character-prefixed cell as
 * formula-adjacent (classic CSV-injection bypass), so treat those two
 * characters as dangerous on their own, not just as skippable whitespace.
 */
export function sanitizeExcelText(value: string): string {
  if (/^\s*'/.test(value)) return value;
  return /^[\t\r]/.test(value) || /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function sanitizeExcelCellValue<T>(value: T): T {
  return (typeof value === "string" ? sanitizeExcelText(value) : value) as T;
}
