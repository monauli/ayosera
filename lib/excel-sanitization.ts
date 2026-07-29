/**
 * Neutralizes user/external text that spreadsheet applications may interpret
 * as a formula. Numeric values and Excel formula objects are deliberately left
 * untouched by callers that use sanitizeExcelCellValue.
 */
export function sanitizeExcelText(value: string): string {
  if (/^\s*'/.test(value)) return value;
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function sanitizeExcelCellValue<T>(value: T): T {
  return (typeof value === "string" ? sanitizeExcelText(value) : value) as T;
}
