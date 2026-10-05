/**
 * Code-unit order. Not `localeCompare`: its order follows the machine's ICU
 * locale, and two writers that sort differently write different bytes.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
