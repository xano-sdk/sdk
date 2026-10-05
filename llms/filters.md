# Filter catalog

> Read when piping a value through `fl.*` — the full catalog with each filter's argument types.

Attach to a value with `withFilters(v, fl.name(...))` — the value `filters[]`
pipeline. Filters are passed spread (canonical); the array form
`withFilters(v, [fl.a(), fl.b()])` is also accepted. Every filter is typed:
the ones below carry named args, and the rest take NO arguments — call them
`fl.<name>()`, and passing an argument is a compile error.
A typed filter's declared argument list is an EXACT count, not a floor: passing more
than it lists THROWS, in the type and at runtime. The extra argument used to ride into
the filter's arg list, where the engine either ignores it or fails opaquely on a live
endpoint. `filter("name", …)` is the untyped escape for a filter the catalog
under-declares. Seven declared filters are exceptions the engine really does take more from, so they
stay variadic: `concat` (trailing separator), `index_by` (trailing list flag), `get` (trailing variable
map), `array_merge` and `array_merge_recursive` (any number of arrays), `jwe_encode` and
`jwe_decode`. To send more than a zero-argument filter's `()` accepts, use the same
`filter("name", …)` escape. A filter with NO declared list takes nothing and is emitted
`()` — except the variadic few listed under the catalog, which take arguments the
catalog never declared and so are not arity-checked at all.
A typed filter also accepts one object of NAMED arguments (`fl.add({ value: 1 })`); a key
the filter does not declare throws rather than being dropped.
A bare JS **scalar** — string, number or boolean — is accepted in ANY `fl.*` argument and
wrapped as the constant you would have written by hand (`fl.get("a.b", 0)` encodes
identically to `fl.get(c.text("a.b"), c.int(0))`). An object or array must still be built
with `c.obj`/`c.array`. Any argument also takes a runtime value (`inp`, `ref`, a
`withFilters` chain) — inside `obj()`/`expr()` an argument cannot carry its own filter
chain, so compute it in a prior `set_var`. The arg types below name each argument's
ENGINE type, not the JS type you may pass.
`fl.add`/`fl.sub`/`fl.mul` keep an INT when both operands are ints (`2 × 3` is `6`, not
`6.0`) and give a decimal only when either operand is one — the `decimal` return type
below covers both, so an int pipeline needs no `fl.to_int()`. `fl.div` is an int only
when it divides exactly.
To add to a numeric column (counter, stock, balance), use `s.db.increment`
(`llms/statements-data.md`) — one atomic UPDATE. A pipeline read-modify-write is NOT
atomic (concurrent writers lose updates), and `col("clicks")` does NOT resolve to the
stored value inside a `db.edit` `row` (it is `null`; `null + 1` aborts): `db.get` the row
`as: "current"`, then `withFilters(ref("current.clicks"), fl.add(c.int(1)))`.

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
- `fl.array_upmerge(match: obj, node: obj): <T>[]` — merges the node INTO each matched element; `array_replace` swaps the element whole
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
- `fl.encrypt(algorithm: enum, key: text, iv: text): text`
- `fl.ends_with(search: text): bool` — piped value is the subject text; the arg is the substring searched for
- `fl.epochms_add_ms(milliseconds: int): epochms`
- `fl.epochms_add_secs(seconds: int): epochms`
- `fl.epochms_date(format: text, timezone?: text): text`
- `fl.epochms_from_format(format: text, timezone?: text): text`
- `fl.epochms_transform(format: text, timezone?: text): text` — applies a relative shift (e.g. "+1 day") to the timestamp
- `fl.eq(value: <T>): bool`
- `fl.every(code: text, timeout?: int): any[]` — `code` is a JS body run per element (true for all?), over `$this`/`$index`/`$parent`
- `fl.filter(code: text, timeout?: int): any[]` — `code` is a JS body run per element (keep it? true/false), over `$this`/`$index`/`$parent`
- `fl.filter_empty(path?: text): <T>[]` — keeps entries that are not empty ("", null, 0, "0", false, [], {})
- `fl.filter_empty_array(path?: text): <T>[]`
- `fl.filter_empty_object(path?: text): <T>[]`
- `fl.filter_empty_text(path?: text): <T>[]`
- `fl.filter_false(path?: text): <T>[]`
- `fl.filter_null(path?: text): <T>[]`
- `fl.filter_zero(path?: text): <T>[]`
- `fl.find(code: text, timeout?: int): any[]` — `code` is a JS body run per element; returns the first element it accepts
- `fl.findIndex(code: text, timeout?: int): any[]` — `code` is a JS body run per element; returns the first matching index
- `fl.first_notempty(value: any): any` — first value that is not empty ("", null, 0, "0", false, [], {})
- `fl.first_notnull(value: any): any`
- `fl.fsort(path?: text, type?: "text"|"itext"|"natural"|"inatural"|"number", asc?: bool): <T>[]` — `type` is the comparator, and ONLY "number" compares numerically — "text"/"itext" are strcmp/strcasecmp, "natural"/"inatural" are the human-readable "a2 < a10" orderings. Default "itext". Anything else silently sorts as text, so a numeric sort MUST spell "number"; the path arg drills into each element
- `fl.get(path: text, default?: json): any` — `path` may be a runtime value: after `fl.index_by("suite_id")`, `fl.get(ref("suite.id"))` returns that key's rows (null for a missing key)
- `fl.gt(value: <T>): bool`
- `fl.gte(value: <T>): bool`
- `fl.has(path: text): bool`
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
- `fl.reduce(initial_value: int, code: text, timeout?: int): any[]` — `code` is a JS body run per element; the ACCUMULATOR is `$result` (there is no `$acc`) and `initial_value` is REQUIRED — omitting it would slot the code as the initial value
- `fl.regex_match(subject: text): text[]` — piped value is the PATTERN, the arg is the subject — see `regex_test`
- `fl.regex_match_all(subject: text): text[]` — piped value is the PATTERN, the arg is the subject — see `regex_test`
- `fl.regex_quote(delimiter?: text): text`
- `fl.regex_replace(replacement: text, subject: text): text` — piped value is the PATTERN, `subject` is the text searched — see `regex_test`. The replacement comes FIRST
- `fl.regex_test(subject: text): bool` — piped value is the PATTERN (build it with `c.regex(...)`); the arg is the subject — the REVERSE of `contains`/`starts_with`. Swapped, it answers false for every input with no error, so write `withFilters(c.regex("^a+$"), fl.regex_test(inp("s")))` (or name the arg: `fl.regex_test({ subject: inp("s") })`). A pattern found in the subject slot is refused at build time
- `fl.round(precision?: int): decimal`
- `fl.rtrim(mask?: text): text`
- `fl.secureid_decode(salt: text): int`
- `fl.secureid_encode(salt: text): text`
- `fl.set(path: text, value: any): any`
- `fl.set_conditional(path: text, value: any, conditional: any): any`
- `fl.set_ifnotempty(path: text, value: any): any`
- `fl.set_ifnotnull(path: text, value: any): any`
- `fl.sha1(raw?: bool): text`
- `fl.sha256(raw?: bool): text`
- `fl.sha384(raw?: bool): text`
- `fl.sha512(raw?: bool): text`
- `fl.some(code: text, timeout?: int): any[]` — `code` is a JS body run per element (true for any?), over `$this`/`$index`/`$parent`
- `fl.splice(offset: int, length?: int, path?: text): <T>[]` — returns the REMOVED slice, not the remainder — [1,2,3,4] spliced at offset 1 length 2 yields [2,3]; with a `path` it removes in place and returns the whole value instead
- `fl.split(separator: text): text[]`
- `fl.starts_with(search: text): bool` — piped value is the subject text; the arg is the substring searched for
- `fl.string_replace(search: text, replacement: text): text`
- `fl.strip_tags(exclude?: text): text`
- `fl.stripos(search: text): int`
- `fl.strpos(search: text): int`
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
- `fl.unique(path?: text): <T>[]`
- `fl.unpick(keys: text): <T>` — returns the object without the named keys (inverse of a pick)
- `fl.unset(path: text): any`
- `fl.url_addarg(key: text, value: text, encoding_rfc3986?: bool): text`
- `fl.url_delarg(key: text): text`
- `fl.url_getarg(key: text, default?: text): text`
- `fl.url_hasarg(key: text): text`
- `fl.yaml_encode(options?: bool, inline?: int, indent?: int): text`

Zero-argument filters — call as `fl.<name>()`; an argument is a compile error: abs, acos, acosh, addslashes, array_entries, array_keys, array_lower, array_pop, array_shift, array_shuffle, array_values, asin, asinh, atan, atanh, avg, base64_decode, base64_decode_urlsafe, base64_encode, base64_encode_urlsafe, bin2hex, bindec, bitwise_not, capitalize, ceil, cos, count, create_object_from_entries, decbin, dechex, decoct, deg2rad, empty, escape, even, exp, first, flatten, floor, from_utf8, hex2bin, hexdec, is_array, is_bool, is_decimal, is_int, is_object, is_text, is_uuid, json_decode, json_encode, last, list_encodings, ln, log10, lower, ms_to_secs, not, null, octdec, odd, product, querystring_parse, rad2deg, reverse, rsort, safe_array, secs_to_ms, sin, sort, sql_alias, sql_esc, sqrt, strip_accents, strlen, sum, tan, text_escape, text_unescape, to_bool, to_decimal, to_expr, to_geo_linestring, to_geo_multilinestring, to_geo_multipoint, to_geo_multipolygon, to_geo_point, to_geo_polygon, to_int, to_text, to_utf8, uid, upper, url_decode, url_decode_rfc3986, url_encode, url_encode_rfc3986, url_parse, uuid4, xml_decode, yaml_decode.

Variadic filters — they take arguments, but no declared list, so the count is not checked: sprintf.
