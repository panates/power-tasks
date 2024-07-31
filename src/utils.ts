export function plural(word: string, isPlural: boolean | number, pluralWord?: string): string {
  if ((typeof isPlural === "number" && isPlural > 1) || isPlural) return pluralWord ? pluralWord : word + "s";
  return word;
}

export function delay(t: number) {
  return new Promise((resolve) => setTimeout(resolve, t).unref());
}
