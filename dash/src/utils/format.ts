/** Zero-pad an integer for the fixed-width instrument readouts. */
export function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}
