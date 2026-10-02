/**
 * Web-platform types named in the public declarations without requiring the
 * consumer's `lib` to carry them. Each resolves to the platform class where the
 * consumer's `lib` (DOM, or `@types/node`) declares it, and otherwise to the
 * members this SDK relies on — so a project compiling with `lib: ["ES2022"]`
 * alone still type-checks the published `.d.ts`.
 */

/** A `URL` instance (`new URL(import.meta.url)`), or its `href` where no `URL` is declared. */
export type UrlLike = typeof globalThis extends { URL: abstract new (...args: never[]) => infer T } ? T : { readonly href: string };

/** A `URLSearchParams` instance, or the members of one used here where none is declared. */
export type SearchParams = typeof globalThis extends { URLSearchParams: abstract new (...args: never[]) => infer T }
  ? T
  : SearchParamsMembers;

/** The `URLSearchParams` members a caller of `toSearchParams` reads. */
export interface SearchParamsMembers {
  append(name: string, value: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  forEach(callback: (value: string, key: string) => void): void;
  toString(): string;
}
