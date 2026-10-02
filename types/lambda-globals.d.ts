/**
 * The globals a lambda body can reach without an import, declared for the
 * `lam.file` modules (or any file holding lambda bodies) so they type-check
 * without hand-written `declare const`s.
 *
 * These are GLOBAL declarations: whatever program loads this file sees them
 * everywhere, and in a program with a frontend its `fetch()` would resolve to
 * the lambda runtime's response. So load it only in a tsconfig of the lambda
 * modules' own — a scaffolded project's `xano/lambdas/tsconfig.json` names it in
 * `types`, and the project tsconfig excludes that directory. Outside a
 * scaffold, do the same (or `import type {} from "@xano/sdk/lambda-globals"`
 * from a lambda module checked under its own tsconfig).
 *
 * The preloaded libraries are typed `any`: their own typings are not
 * dependencies of this package. Their names match `LAMBDA_MODULE_GLOBALS`.
 *
 * The runtime globals (`crypto`, `Buffer`, `fetch`, `TextEncoder`/`TextDecoder`,
 * `console`) are declared by merging into the interfaces the DOM lib and
 * `@types/node` already declare, so the file compiles under `lib: ["ES2022"]`
 * alone, with `DOM`, and with `DOM` plus `@types/node`. With `@types/node` and
 * no `DOM` lib, node's own `crypto`/`TextEncoder`/`TextDecoder` declarations
 * disagree with these (node's global `crypto` is Web Crypto only);
 * `skipLibCheck: true` accepts them and keeps the lambda runtime's
 * `createHmac`/`createHash`.
 */
export {};

declare global {
  const _: any;
  const aws4: any;
  const axios: any;
  const cryptojs: any;
  const DateTime: any;
  const ethers: any;
  const fastXmlParser: any;
  const jose: any;
  const luxon: any;
  const mailparser: any;
  const math: any;
  const moment: any;
  const nodemailer: any;
  const socks: any;
  const uuid: any;
  const utils: any;

  /** The byte encodings `Buffer`, `digest()` and `toString()` read and write. */
  type LambdaEncoding = "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "binary" | "ascii";

  /** Bytes returned by `Buffer` and `digest()`: a `Uint8Array` that prints in an encoding. */
  interface LambdaBuffer extends Uint8Array {
    toString(encoding?: LambdaEncoding): string;
  }

  /** `crypto.createHmac(…)` / `crypto.createHash(…)`: feed with `update`, finish with `digest`. */
  interface LambdaHash {
    update(data: string | Uint8Array, encoding?: LambdaEncoding): LambdaHash;
    digest(): LambdaBuffer;
    digest(encoding: LambdaEncoding): string;
  }

  interface Crypto {
    /** HMAC over `key`: `crypto.createHmac("sha256", secret).update(body).digest("hex")`. */
    createHmac(algorithm: string, key: string | Uint8Array): LambdaHash;
    /** A digest: `crypto.createHash("sha256").update(text).digest("hex")`. */
    createHash(algorithm: string): LambdaHash;
    randomUUID(): string;
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    readonly subtle: SubtleCrypto;
  }
  interface SubtleCrypto {
    digest(algorithm: string | { name: string }, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
    importKey(format: string, keyData: any, algorithm: any, extractable: boolean, keyUsages: string[]): Promise<any>;
    sign(algorithm: any, key: any, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
    verify(algorithm: any, key: any, signature: ArrayBufferView | ArrayBuffer, data: ArrayBufferView | ArrayBuffer): Promise<boolean>;
  }
  var crypto: typeof globalThis extends { onmessage: any; crypto: infer T } ? T : Crypto;

  interface BufferConstructor {
    from(data: string, encoding?: LambdaEncoding): LambdaBuffer;
    from(data: ArrayBuffer | ArrayLike<number>): LambdaBuffer;
    alloc(size: number): LambdaBuffer;
    concat(list: readonly Uint8Array[]): LambdaBuffer;
    byteLength(data: string, encoding?: LambdaEncoding): number;
    isBuffer(value: unknown): boolean;
  }
  var Buffer: BufferConstructor;

  interface LambdaHeaders {
    get(name: string): string | null;
    has(name: string): boolean;
    forEach(fn: (value: string, name: string) => void): void;
  }
  interface LambdaResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: LambdaHeaders;
    json(): Promise<any>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }
  interface LambdaRequestInit {
    method?: string;
    headers?: Record<string, string> | [string, string][];
    body?: string | Uint8Array | ArrayBuffer | null;
    signal?: any;
  }
  function fetch(input: string | { readonly href: string }, init?: LambdaRequestInit): Promise<LambdaResponse>;

  interface TextEncoder {
    encode(input?: string): Uint8Array;
  }
  interface TextDecoder {
    decode(input?: ArrayBufferView | ArrayBuffer): string;
  }
  var TextEncoder: typeof globalThis extends { onmessage: any; TextEncoder: infer T } ? T : { prototype: TextEncoder; new (): TextEncoder };
  var TextDecoder: typeof globalThis extends { onmessage: any; TextDecoder: infer T } ? T : { prototype: TextDecoder; new (label?: string): TextDecoder };

  /** Routed to the request log. Only these methods exist; calling any other throws. */
  interface Console {
    log(...data: any[]): void;
    error(...data: any[]): void;
    warn(...data: any[]): void;
    info(...data: any[]): void;
    debug(...data: any[]): void;
    trace(...data: any[]): void;
  }
  var console: Console;
}
