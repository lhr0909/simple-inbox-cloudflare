export function containsControlCharacters(input: string, includeSpace = false): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isControlCodePoint(codePoint) || (includeSpace && codePoint === 0x20)) return true
  }
  return false
}

export function replaceControlCharacters(
  input: string,
  replacement: string,
  preservedCodePoints: readonly number[] = [],
): string {
  let output = ''
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0
    output +=
      isControlCodePoint(codePoint) && !preservedCodePoints.includes(codePoint)
        ? replacement
        : character
  }
  return output
}

export function removeCodePointRanges(
  input: string,
  ranges: ReadonlyArray<readonly [start: number, end: number]>,
): string {
  let output = ''
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0
    if (!ranges.some(([start, end]) => codePoint >= start && codePoint <= end)) {
      output += character
    }
  }
  return output
}

export function truncateCodePoints(input: string, maximum: number): string {
  if (input.length <= maximum) return input
  return Array.from(input).slice(0, maximum).join('')
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}
