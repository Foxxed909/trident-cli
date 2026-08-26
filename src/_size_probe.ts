// size probe file - safe to delete
// This file tests whether ~20KB pushes work through the GitHub connector.
export const SIZE_PROBE = true;
export function probe(): string {
  return 'ok';
}
