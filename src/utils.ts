/**
 * Returns the plural version of a word based on a count or boolean flag.
 *
 * @param word - The singular form of the word.
 * @param isPlural - A boolean or number indicating whether the word should be pluralized.
 * @param pluralWord - An optional specific plural form of the word.
 * @returns The pluralized word.
 */
export function plural(
  word: string,
  isPlural: boolean | number,
  pluralWord?: string,
): string {
  if ((typeof isPlural === "number" && isPlural > 1) || isPlural)
    return pluralWord ? pluralWord : word + "s";
  return word;
}

/**
 * Returns a promise that resolves after a specified duration.
 *
 * @param t - The duration to delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
export function delay(t: number) {
  return new Promise((resolve) => setTimeout(resolve, t).unref());
}
