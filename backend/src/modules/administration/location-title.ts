import titlecase from './python-titlecase.json' with { type: 'json' };

const cased = /\p{Cased}/u,
  ignorable = /\p{Case_Ignorable}/u;
const exceptions: Readonly<Record<string, string>> = titlecase.exceptions;
/** Python str.title uses cased-character boundaries, including apostrophes/digits and final sigma. */
export function sourceCityTitle(value: string): string {
  const chars = Array.from(value);
  let previousCased = false;
  return chars
    .map((char, index) => {
      let result: string;
      if (!previousCased) result = exceptions[char] ?? char.toUpperCase();
      else if (char === 'Σ') {
        let before = index - 1,
          after = index + 1;
        while (before >= 0 && ignorable.test(chars[before]!)) before--;
        while (after < chars.length && ignorable.test(chars[after]!)) after++;
        result =
          before >= 0 &&
          cased.test(chars[before]!) &&
          (after === chars.length || !cased.test(chars[after]!))
            ? 'ς'
            : 'σ';
      } else result = char.toLowerCase();
      previousCased = cased.test(char);
      return result;
    })
    .join('');
}
