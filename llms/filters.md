# Filter catalog

> Read when piping a value through `fl.*` — the full catalog with each filter's argument types.

Attach to a value with `withFilters(v, fl.name(...))` — the value `filters[]`
pipeline. Filters are passed spread (canonical); the array form
`withFilters(v, [fl.a(), fl.b()])` is also accepted. Every filter is typed. Arity:

- A declared argument list (the catalog below) is an EXACT count, not a floor: passing more
  THROWS, in the type and at runtime.
- Seven declared filters take more: `concat` (trailing separator), `index_by` (trailing list
  flag), `get` (trailing variable map), `array_merge`/`array_merge_recursive` (any number of
  arrays), `jwe_encode`, `jwe_decode`.
- A filter with NO declared list is called `fl.<name>()`; passing an argument is a compile
  error. The variadic filters at the end of the catalog take undeclared arguments and are
  not arity-checked.
- Past any of these — a filter the catalog under-declares, or more than a
  zero-argument filter's `()` accepts — use the untyped `filter("name", …)`.

A typed filter also accepts one object of NAMED arguments (`fl.add({ value: 1 })`); a key
the filter does not declare throws rather than being dropped.
A bare JS **scalar** — string, number or boolean — is accepted in ANY `fl.*` argument and
wrapped as a constant (`fl.get("a.b", 0)` ≡ `fl.get(c.text("a.b"), c.int(0))`). Build an
object or array with `c.obj`/`c.array`. Any argument also takes a runtime value (`inp`, `ref`,
a `withFilters` chain); inside `obj()`/`expr()` an argument cannot carry its own filter
chain — compute it in a prior `set_var`. Arg types below are ENGINE types, not JS types.
`fl.add`/`fl.sub`/`fl.mul` keep an INT when both operands are ints (`2 × 3` is `6`) and give
a decimal when either is one; an int pipeline needs no `fl.to_int()`. `fl.div` is an int only
when it divides exactly.
To add to a numeric column (counter, stock, balance), use `s.db.increment`
(`llms/statements-data.md`) — one atomic UPDATE. A pipeline read-modify-write is NOT
atomic (concurrent writers lose updates), and `col("clicks")` does NOT resolve to the
stored value inside a `db.edit` `row` (it is `null`; `null + 1` aborts): `db.get` the row
`as: "current"`, then `withFilters(ref("current.clicks"), fl.add(c.int(1)))`.
⚠ NULL operands, by filter:
- Text filters (`trim`/`upper`/`strlen`/`to_int`/…) pass null through (`strlen(null)` is `null`;
  `strlen` of a non-string is `null` too, not a length).
- Arithmetic treats null as `0` (`null|add:1` → `1`).
- `fl.concat` on a null or list base returns `""` and SILENTLY DROPS its argument
  (`null|concat:"x"` → `""`). Default the base first:
  `withFilters(inp("middle"), fl.first_notnull(c.text("")), fl.concat("x"))`.
- `fl.split` of null is `[""]`.

⚠ `fl.trim`/`ltrim`/`rtrim` (and the `s.text.*` trims) take `mask` as a SET OF CHARACTERS, not a
substring. It is a PHP MASK, so `"a..c"` means the RANGE a-c, not the three characters `a`, `.`, `c`.

- `fl.add(value: decimal): decimal`
- `fl.append(value: <T>, path: text): <T>[]`
- `fl.array_diff(value: <T>[]): <T>[]`
- `fl.array_diff_assoc(value: <T>[]): <T>[]`
- `fl.array_fill(start: int, count: int): any[]`
- `fl.array_fill_keys(keys: any[]): any[]`
- `fl.array_filter(match: obj, path?: text): <T>[]` — matches by EXAMPLE (an object of key/value pairs), not by code, and compares LOOSELY
- `fl.array_find(match: obj): <T>` — a MISS THROWS (`Unable to find element.`) rather than yielding null — use `array_has` to test first
- `fl.array_has(match: obj): bool`
- `fl.array_intersect(value: <T>[]): <T>[]`
- `fl.array_intersect_assoc(value: <T>[]): <T>[]`
- `fl.array_merge(value: <T>[]): <T>[]`
- `fl.array_merge_recursive(value: <T>[]): <T>[]`
- `fl.array_push(value: <T>): <T>[]`
- `fl.array_push_conditional(value: any, conditional: bool): <T>[]`
- `fl.array_remove(value: <T>, path: text, strict?: bool): <T>[]`
- `fl.array_replace(match: any, result: any): <T>[]`
- `fl.array_set(path: text, value: any): obj` — sets a DOTTED path and returns the value; a non-object piped value is replaced by an empty one
- `fl.array_slice(offset: int, length?: int): <T>[]`
- `fl.array_unshift(value: <T>): <T>[]`
- `fl.array_upmerge(match: obj, node: obj): <T>[]` — merges the node into the FIRST matched element, and APPENDS it on a miss (an UPSERT, not update-all) — use `fl.map` to update every match; `array_replace` is first-match too but swaps the element whole and THROWS on a miss
- `fl.base_convert(from_base: any, to_base: any): text`
- `fl.bitwise_and(value: int): int`
- `fl.bitwise_or(value: int): int`
- `fl.bitwise_xor(value: int): int`
- `fl.clamp_max(max: decimal): decimal`
- `fl.clamp_min(min: decimal): decimal`
- `fl.concat(value: any): text`
- `fl.contains(search: text): bool` — piped value is the subject text; the arg is the substring searched for
- `fl.convert_encoding(to: text, from: text): text`
- `fl.create_object(values: <T>[]): any`
- `fl.crypto_jwe_decode(check_claims: json, key: json, key_algorithm: enum, content_algorithm: enum, timeDrift?: int): json`
- `fl.crypto_jwe_encode(headers: json, key: json, key_algorithm: enum, content_algorithm: enum, ttl?: int): text`
- `fl.crypto_jws_decode(check_claims: json, key: json, algorithm: enum, timeDrift?: int): json`
- `fl.crypto_jws_encode(headers: json, key: json, algorithm: enum, ttl?: int): text`
- `fl.csv_create(rows: text[], separator: text, enclosure: text, escape: text): text` — the header-writing counterpart to `csv_encode`: the PIPED value is the list of column names (written as the header line) and `rows` carries the data rows
- `fl.csv_decode(separator: text, enclosure: text, escape: text): any`
- `fl.csv_encode(separator: text, enclosure: text, escape: text): text` — writes NO header — values only, each row in THAT row's key order with no normalization across rows, so rows whose keys differ in order or count silently misalign columns. Nested cells are JSON-encoded and `false` writes empty. A piped array of SCALARS is treated as one row. Use `csv_create` for a header
- `fl.csv_parse(separator: text, enclosure: text, escape: text): any`
- `fl.decrypt(algorithm: enum, key: text, iv: text): text`
- `fl.detect_encoding(encodings?: text): text`
- `fl.div(value: decimal): decimal`
- `fl.encrypt(algorithm: enum, key: text, iv: text): text` — binds RAW ciphertext bytes — fl.base64_encode() before returning or storing (fl.decrypt takes the raw bytes back)
- `fl.ends_with(search: text): bool` — piped value is the subject text; the arg is the substring searched for
- `fl.epochms_add_ms(milliseconds: int): epochms`
- `fl.epochms_add_secs(seconds: int): epochms`
- `fl.epochms_date(format: text, timezone?: text): text`
- `fl.epochms_from_format(format: text, timezone?: text): text`
- `fl.epochms_transform(format: text, timezone?: text): int` — applies a relative shift (e.g. "+1 day") to the timestamp. ⚠ a format `strtotime` cannot parse yields `0`, and a MISTYPED one (`"+1 dya"`) a PLAUSIBLE WRONG time, both with NO error — see date-filter failure modes in `llms/statements-runtime.md`
- `fl.eq(value: <T>): bool`
- `fl.every(code: text, timeout?: int): bool` — `code` is a JS body run per element (true for all?), over `$this`/`$index`/`$parent` — returns a BOOL (`true` on an empty list)
- `fl.filter(code: text, timeout?: int): any[]` — `code` is a JS body run per element (keep it? true/false), over `$this`/`$index`/`$parent`
- `fl.filter_empty(path?: text): <T>[]` — keeps entries that are not empty ("", null, 0, "0", false, [], {}) — the only one of the family that drops them all
- `fl.filter_empty_array(path?: text): <T>[]`
- `fl.filter_empty_object(path?: text): <T>[]`
- `fl.filter_empty_text(path?: text): <T>[]` — drops only `""`; null, 0, false, [] and {} stay
- `fl.filter_false(path?: text): <T>[]`
- `fl.filter_null(path?: text): <T>[]`
- `fl.filter_zero(path?: text): <T>[]` — drops only the integer `0` (strict), not `"0"` or `0.0`
- `fl.find(code: text, timeout?: int): <T>` — `code` is a JS body run per element; returns the first ELEMENT it accepts (`null` when none)
- `fl.findIndex(code: text, timeout?: int): int` — `code` is a JS body run per element; returns the first matching INDEX as an int (`-1` when none)
- `fl.first_notempty(value: any): any` — first value that is not empty ("", null, 0, "0", false, [], {})
- `fl.first_notnull(value: any): any`
- `fl.fsort(path?: text, type?: "text"|"itext"|"natural"|"inatural"|"number", asc?: bool): <T>[]` — `type` is the comparator: "number" (the only numeric one), "text"/"itext" (strcmp/strcasecmp), "natural"/"inatural" ("a2 < a10"). Default "itext"; anything else sorts as text. The path arg drills into each element
- `fl.get(path: text, default?: json): any` — `path` may be a runtime value: after `fl.index_by("suite_id")`, `fl.get(ref("suite.id"))` returns that key's rows (null for a missing key). ⚠ the `default` applies only to a MISSING path — a key present with a `null` value stays `null`; chain `fl.first_notnull(default)` to cover both.
- `fl.gt(value: <T>): bool`
- `fl.gte(value: <T>): bool`
- `fl.has(path: text): bool` — `false` for a missing key and for a key whose value is `null` (unlike `fl.get`'s default, which treats a present null as present)
- `fl.hmac_md5(key: text, raw?: bool): text`
- `fl.hmac_sha1(key: text, raw?: bool): text`
- `fl.hmac_sha256(key: text, raw?: bool): text`
- `fl.hmac_sha384(key: text, raw?: bool): text`
- `fl.hmac_sha512(key: text, raw?: bool): text`
- `fl.icontains(search: text): bool` — case-insensitive; piped value is the subject, the arg is the substring
- `fl.iends_with(search: text): bool` — case-insensitive; piped value is the subject, the arg is the substring
- `fl.in(search: <T>): bool`
- `fl.index_by(path: text): { [key: string]: <T>[] }` — a GROUP-BY: every value is an ARRAY of the items sharing that key, even when only one does, so a lookup reads `idx[key][0]`. Items whose path is missing or non-scalar are dropped
- `fl.istarts_with(search: text): bool` — case-insensitive; piped value is the subject, the arg is the substring
- `fl.join(separator: text): text`
- `fl.jwe_decode(arg1: any)`
- `fl.jwe_encode(arg1: any)`
- `fl.lambda(code: text, timeout?: int): any` — runs a JS body once over the piped value, which it binds as `$this` (NOT `$parent`)
- `fl.log(base: <T>): decimal`
- `fl.lt(value: <T>): bool`
- `fl.lte(value: <T>): bool`
- `fl.ltrim(mask?: text): text`
- `fl.map(code: text, timeout?: int): any[]` — `code` is a JS body run per element, over `$this`/`$index`/`$parent` — build it with `lam.fn`
- `fl.max(bound?: decimal): decimal`
- `fl.md5(raw?: bool): text`
- `fl.min(bound?: decimal): decimal`
- `fl.mod(value: int): int`
- `fl.mul(value: decimal): decimal`
- `fl.ne(value: <T>): bool`
- `fl.num_max(value: any): decimal`
- `fl.num_min(value: any): decimal`
- `fl.number_format(decimals: int, decimal_separator: text, thousands_separator: text): string`
- `fl.pick(keys: text): <T>`
- `fl.pow(exp: <T>): decimal`
- `fl.prepend(value: <T>, path: text): <T>[]`
- `fl.range(start: int, stop: int): int[]`
- `fl.reduce(initial_value: any, code: text, timeout?: int): any` — `code` is a JS body run per element; the ACCUMULATOR is `$result` (there is no `$acc`) and `initial_value` is REQUIRED. `initial_value` takes ANY value (an object/text accumulator, `c.obj({...})`/`c.text("")`, not just an int); the result is that accumulator
- `fl.regex_match(subject: text): text[]` — piped value is the PATTERN, the arg is the subject — see `regex_test`
- `fl.regex_match_all(subject: text): text[]` — piped value is the PATTERN, the arg is the subject — see `regex_test`
- `fl.regex_quote(delimiter?: text): text`
- `fl.regex_replace(replacement: text, subject: text): text` — piped value is the PATTERN, `subject` is the text searched — see `regex_test`. The replacement comes FIRST
- `fl.regex_test(subject: text): bool` — piped value is the PATTERN (build it with `c.regex(...)`); the arg is the subject — the REVERSE of `contains`/`starts_with`. Swapped args → always false, no error. Write `withFilters(c.regex("^a+$"), fl.regex_test(inp("s")))` (or name the arg: `fl.regex_test({ subject: inp("s") })`). A pattern found in the subject slot is refused at build time
- `fl.round(precision?: int): decimal`
- `fl.rtrim(mask?: text): text`
- `fl.secureid_decode(salt: text): int` — a wrong salt, or a garbage/empty id, is a 400 (`This signature is invalid.` / `Invalid input format for secureId.`), NOT null — wrap in s.try_catch to handle a miss; only the id from `secureid_encode` of a non-negative int round-trips back
- `fl.secureid_encode(salt: text): text` — the operand must be a NON-NEGATIVE integer — a negative or fractional one encodes without error but `secureid_decode` returns a DIFFERENT positive int (`-3` → `13`, `-42` → `214`, `1.5` → `1`), NOT a round-trip; validate the domain before encoding
- `fl.set(path: text, value: any): any`
- `fl.set_conditional(path: text, value: any, conditional: any): any`
- `fl.set_ifnotempty(path: text, value: any): any`
- `fl.set_ifnotnull(path: text, value: any): any`
- `fl.sha1(raw?: bool): text`
- `fl.sha256(raw?: bool): text` — the optional `raw` arg returns RAW binary, not the hex digest — fl.bin2hex()/fl.base64_encode() it before returning or storing (strlen then UNDER-COUNTS: it counts characters, not bytes); omit `raw` for hex
- `fl.sha384(raw?: bool): text`
- `fl.sha512(raw?: bool): text`
- `fl.some(code: text, timeout?: int): bool` — `code` is a JS body run per element (true for any?), over `$this`/`$index`/`$parent` — returns a BOOL (`false` on an empty list)
- `fl.splice(offset: int, length?: int, path?: text): <T>[]` — returns the REMOVED slice, not the remainder — [1,2,3,4] spliced at offset 1 length 2 yields [2,3]; with a `path` it removes in place and returns the whole value instead
- `fl.split(separator: text): text[]`
- `fl.starts_with(search: text): bool` — piped value is the subject text; the arg is the substring searched for
- `fl.string_replace(search: text, replacement: text): text`
- `fl.strip_tags(exclude?: text): text`
- `fl.stripos(search: text): int|false`
- `fl.strpos(search: text): int|false`
- `fl.sub(value: decimal): decimal`
- `fl.substr(start: int, length: int): text`
- `fl.to_epoch_day(timezone?: text): int`
- `fl.to_epoch_hour(timezone?: text): int`
- `fl.to_epoch_minute(timezone?: text): int`
- `fl.to_epoch_ms(timezone?: text): int`
- `fl.to_epoch_sec(timezone?: text): int`
- `fl.to_epochms(timezone?: text): epochms`
- `fl.transform(expression: text): any` — `expression` is Xano Expression Engine source, NOT a JS body — no `return`, and the piped value is `$0` (or `$$`), NOT `$this` (which is null here). `$var`/`$input`/`$env`/`$auth` resolve and filters pipe inside it: `$0 * 2`, `$0|sort|join:","`. Parenthesize a pipe inside an object literal — `{ s: ($0|sort|join:",") }` — or its comma is read as the key separator and later keys vanish silently. For JavaScript use `lambda`
- `fl.trim(mask?: text): text`
- `fl.unique(path?: text): <T>[]` — with a `path`, dedupes a list of records by the value at that path and keeps the FIRST per key — but it DROPS every element whose path is missing or null (the same rule as `index_by`), so deduping by an optional key loses those rows
- `fl.unpick(keys: text): <T>` — returns the object without the named keys (inverse of a pick)
- `fl.unset(path: text): any`
- `fl.url_addarg(key: text, value: text, encoding_rfc3986?: bool): text`
- `fl.url_delarg(key: text): text`
- `fl.url_getarg(key: text, default?: text): text`
- `fl.url_hasarg(key: text): bool`
- `fl.yaml_encode(options?: bool, inline?: int, indent?: int): text`

Zero-argument filters, by operand type: array: array_entries, array_keys, array_lower, array_pop, array_shift, array_shuffle, array_values, count, first, flatten, last, reverse, rsort, safe_array; comparison: empty, even, is_array, is_bool, is_decimal, is_int, is_object, is_text, is_uuid, not, null, odd; geo: to_geo_linestring, to_geo_multilinestring, to_geo_multipoint, to_geo_multipolygon, to_geo_point, to_geo_polygon; math: abs, acos, acosh, asin, asinh, atan, atanh, avg, bitwise_not, ceil, cos, deg2rad, exp, floor, ln, log10, product, rad2deg, sin, sqrt, sum, tan; other: sort; security: uid, uuid4; text: addslashes, capitalize, escape, from_utf8, list_encodings, lower, querystring_parse, sql_alias, sql_esc, strip_accents, strlen, text_escape, text_unescape, to_utf8, upper, url_parse; timestamp: ms_to_secs, secs_to_ms; transform: base64_decode, base64_decode_urlsafe, base64_encode, base64_encode_urlsafe, bin2hex, bindec, create_object_from_entries, decbin, dechex, decoct, hex2bin, hexdec, json_decode, json_encode, octdec, to_bool, to_decimal, to_expr, to_int, to_text, url_decode, url_decode_rfc3986, url_encode, url_encode_rfc3986, xml_decode, yaml_decode.
`fl.reverse()` reverses a list only: on a text value it answers the text UNCHANGED, with no error.
An unknown `timezone` (a typo, `+05:30`, `PDT`) silently means UTC. A literal warns at export; take a runtime zone as an `input.enum`.
`fl.to_bool()` is NOT a truthiness cast: it accepts only the boolean vocabulary — `true`/`1`/`"1"`/`"true"`/`"on"`/`"yes"` and `false`/`0`/`"0"`/`"false"`/`"off"`/`""` — and ANY other value 400s `ERROR_CODE_INPUT_ERROR` "Invalid boolean input.". For a truthiness cast pipe `fl.ne(c.int(0))`.

Variadic filters — they take arguments, but no declared list, so the count is not checked: sprintf.
