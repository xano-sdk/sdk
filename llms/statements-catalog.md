# Statement catalog

> Read for the field signature of a specific statement — every surface, grouped by `s.*` namespace.

`[special]`: hand-written signature (`llms.txt` Specials, `llms/statements-*`). `[output]`: the engine's output flag; in-place mutators carrying it (`s.math.add`, `bitwise.*`) still take no `as`.

### (top-level)

`s.throw` raises a named error `s.try_catch` catches; uncaught, it answers HTTP 200 `{ payload, statement: "Throw Error" }`, or its `status` (100–599) when it sets one. Inside `s.db.transaction` a throw or failed precondition rolls it back.

- `s.await({ as?: string; ids?: value; timeout?: value; terminate?: value })`
- `s.foreach_break` [special]
- `s.comment` [special]
- `s.conditional` [special]
- `s.foreach_continue` [special]
- `s.for` [special]
- `s.foreach_remove` [special]
- `s.foreach` [special]
- `s.group` [special]
- `s.lambda({ as?: string; code: value; timeout?: value })`
- `s.precondition({ expr: comparison; error_type?: "standard" | "notfound" | "toomanyrequests" | "accessdenied" | "unauthorized" | "badrequest" | "inputerror"; error?: value; payload?: value })`
- `s.return` [special]
- `s.switch` [special]
- `s.throw({ name?: string; value: value; status?: number })`
- `s.try_catch` [special]
- `s.update_var` [special]
- `s.set_var` [special]
- `s.while` [special]

### action

- `s.action.call` [special]
- `s.action.package.call` [special]

### addon

- `s.addon.call` [special]

### ai

- `s.ai.agent.run` [special]
- `s.ai.external.mcp.server_details({ as?: string; url: value; bearer_token?: value; connection_type?: "sse" | "stream" })`
- `s.ai.external.mcp.tool.list({ as?: string; url: value; bearer_token?: value; connection_type?: "sse" | "stream" })`
- `s.ai.external.mcp.tool.run({ as?: string; url: value; bearer_token?: value; connection_type?: "sse" | "stream"; tool: value; args?: value })`

### api

- `s.api.call` [special]
- `s.api.request` [special, output]
- `s.api.stream({ value: value })`

### array

`by` is a `$this` expression, NOT a column name: `by: ref("$this.id")` (warns `stack.array-key-constant`). A predicate's `if` binds `$this` only; `$index` only in `partition` (warns `stack.array-index-unbound`).

- `s.array.difference({ as?: string; expr: value; value: value; by?: value })`
- `s.array.every({ expr: value; as?: string; if: comparison })` [output] → as: boolean
- `s.array.filter_count({ expr: value; as?: string; if: comparison })`
- `s.array.filter({ expr: value; as?: string; if: comparison })`
- `s.array.find_index({ expr: value; as?: string; if: comparison })`
- `s.array.find({ expr: value; as?: string; if: comparison })` [output]
- `s.array.group_by({ as?: string; expr: value; by?: value })`
- `s.array.has({ expr: value; as?: string; if: comparison })`
- `s.array.intersection({ as?: string; expr: value; value: value; by?: value })`
- `s.array.map` [special]
- `s.array.merge({ name: string; value: value })` [output]
- `s.array.partition({ expr: value; as?: string; if: comparison })`
- `s.array.pop({ name: string; as?: string })` [output]
- `s.array.push({ name: string; value: value })` [output]
- `s.array.shift({ name: string; as?: string })`
- `s.array.union` [special]
- `s.array.unshift({ name: string; value: value })`

### cloud

- `s.cloud.algolia.request({ as?: string; application_id: value; api_key: value; url: value; method?: "POST" | "GET" | "DELETE" | "PUT"; payload: value })` [output]
- `s.cloud.aws.opensearch.document({ as?: string; auth_type?: "IAM" | "master"; key_id: value; access_key: value; region: value; base_url: value; method?: "GET" | "POST" | "PUT" | "DELETE"; index: value; doc_id: value; doc: value })`
- `s.cloud.aws.opensearch.query({ as?: string; auth_type?: "IAM" | "master"; key_id: value; access_key: value; region: value; base_url: value; index: value; payload: value; size?: value; from?: value; included_fields?: value; return_type?: "search" | "count"; expression?: value; sort?: value })`
- `s.cloud.aws.opensearch.request({ as?: string; auth_type?: "IAM" | "master"; key_id: value; access_key: value; region: value; method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "PATCH"; url: value; query: value })`
- `s.cloud.aws.s3.delete_file({ as?: string; bucket: value; region: value; key: value; secret: value; file_key: value })`
- `s.cloud.aws.s3.get_file_info({ as?: string; bucket: value; region: value; key: value; secret: value; file_key: value })`
- `s.cloud.aws.s3.list_directory({ as?: string; bucket: value; region: value; key: value; secret: value; prefix?: value; next_page_token?: value })`
- `s.cloud.aws.s3.read_file({ as?: string; bucket: value; region: value; key: value; secret: value; file_key: value })`
- `s.cloud.aws.s3.sign_url({ as?: string; bucket: value; region: value; key: value; secret: value; file_key: value; ttl?: value })`
- `s.cloud.aws.s3.upload_file({ as?: string; bucket: value; region: value; key: value; secret: value; file_key?: value; file: value; metadata?: value; object_lock_mode?: "compliance" | "governance"; object_lock_retain_until?: value })`
- `s.cloud.azure.storage.delete_file({ as?: string; account_name: value; account_key: value; container_name: value; filePath: value })`
- `s.cloud.azure.storage.get_file_info({ as?: string; account_name: value; account_key: value; container_name: value; filePath: value })`
- `s.cloud.azure.storage.list_directory({ as?: string; account_name: value; account_key: value; container_name: value; path?: value })`
- `s.cloud.azure.storage.read_file({ as?: string; account_name: value; account_key: value; container_name: value; filePath: value })`
- `s.cloud.azure.storage.sign_url({ as?: string; account_name: value; account_key: value; container_name: value; path: value; ttl?: value })`
- `s.cloud.azure.storage.upload_file({ as?: string; account_name: value; account_key: value; container_name: value; filePath: value; file: value; metadata?: value })`
- `s.cloud.elasticsearch.document({ as?: string; auth_type?: "Basic" | "Bearer" | "API Key"; key_id: value; access_key: value; base_url: value; index: value; method?: "GET" | "POST" | "PUT" | "DELETE"; doc_id: value; doc: value })`
- `s.cloud.elasticsearch.query({ as?: string; auth_type?: "Basic" | "Bearer" | "API Key"; key_id: value; access_key: value; base_url: value; index: value; payload: value; size?: value; from?: value; included_fields?: value; return_type?: "search" | "count"; expression?: value; sort?: value })`
- `s.cloud.elasticsearch.request({ as?: string; auth_type?: "Basic" | "Bearer" | "API Key"; key_id: value; access_key: value; method?: "POST" | "GET" | "PUT" | "DELETE" | "PATCH"; url: value; payload: value })`
- `s.cloud.google.storage.delete_file({ as?: string; service_account: value; bucket: value; filePath: value })`
- `s.cloud.google.storage.get_file_info({ as?: string; service_account: value; bucket: value; filePath: value })`
- `s.cloud.google.storage.list_directory({ as?: string; service_account: value; bucket: value; path: value })`
- `s.cloud.google.storage.read_file({ as?: string; service_account: value; bucket: value; filePath: value })`
- `s.cloud.google.storage.sign_url({ as?: string; service_account: value; bucket: value; filePath: value; method?: "GET" | "POST"; ttl?: value })`
- `s.cloud.google.storage.upload_file({ as?: string; service_account: value; bucket: value; filePath: value; file: value; metadata?: value })`
- `s.cloud.job.await` [special]
- `s.cloud.job.status` [special]
- `s.cloud.job` [special]

### datadog

- `s.datadog.log_bulk({ entries: value; connection?: value })`
- `s.datadog.log({ message: value; status?: "debug" | "info" | "notice" | "warn" | "error" | "critical" | "alert" | "emergency"; attributes?: value; service?: value; source?: value; env?: value; hostname?: value; tags?: value; timestamp?: value; connection?: value })`
- `s.datadog.metric_bulk({ entries: value; connection?: value })`
- `s.datadog.metric({ metric: value; value: value; type?: "count" | "gauge" | "rate" | "histogram" | "distribution"; tags?: value; service?: value; source?: value; env?: value; hostname?: value; timestamp?: value; connection?: value })`

### db

- `s.db.add_or_edit` [special] → as: InferRow<T> (upserts and never misses)
- `s.db.add` [special] → as: InferRow<T> (the full inserted row incl. id/created_at)
- `s.db.bulk.add` [special]
- `s.db.bulk.delete` [special] → as: number (count of deleted rows)
- `s.db.bulk.patch` [special] → as: InferRow<T>[]
- `s.db.bulk.update` [special]
- `s.db.del` [special] → as: null (the engine deletes and returns no value; throws NotFound on a miss)
- `s.db.direct_query` [special]
- `s.db.edit` [special] → as: InferRow<T> (the full post-mutation row; throws NotFound on a miss)
- `s.db.external.mssql.direct_query` [special]
- `s.db.external.mysql.direct_query` [special]
- `s.db.external.oracle.direct_query` [special]
- `s.db.external.postgres.direct_query` [special]
- `s.db.external.snowflake.direct_query` [special]
- `s.db.get` [special] → as: InferRow<T> | null (binds null on a miss, never throws)
- `s.db.has` [special] → as: boolean
- `s.db.increment` [special] → as: InferRow<T>[] | number (the updated rows, or the changed-row count with returnType "count")
- `s.db.patch` [special] → as: InferRow<T> (the full post-mutation row; throws NotFound on a miss)
- `s.db.query` [special] → as: InferRow<T>[] (a paging envelope when metadata paging is on)
- `s.db.schema` [special]
- `s.db.set_datasource({ value: value; workspace_id?: value })`
- `s.db.transaction` [special]
- `s.db.truncate` [special]

### debug

`s.debug.stop` is a REAL terminator: it ends the request with HTTP 200 `{ payload, statement: "Stop & Debug" }` (use `s.precondition` for an error status). Also exported flat as `die()`; there is no `s.die`.

- `s.debug.log({ value: value })`
- `s.debug.stop({ value: value })`

### expect

Assertions. Use only in a `workflowTest({...})` stack, asserting on what a `.call` bound with `as`; elsewhere a failure aborts the request with HTTP 500 and the assertion's message (`to_equal failed - expected value 2 does not equal 1`). `to_throw` sees only an error carrying a MESSAGE, so an empty-message failure (`ERROR_CODE_ACCESS_DENIED`) reports "response is ok", and `to_be_within` EXCLUDES both bounds — `min < expr < max`.

- `s.expect.to_be_defined({ expr: value })`
- `s.expect.to_be_empty({ expr: value })`
- `s.expect.to_be_false({ expr: value })`
- `s.expect.to_be_greater_than({ expr: value; value: value })`
- `s.expect.to_be_in_the_future({ expr: value })`
- `s.expect.to_be_in_the_past({ expr: value })`
- `s.expect.to_be_less_than({ expr: value; value: value })`
- `s.expect.to_be_null({ expr: value })`
- `s.expect.to_be_true({ expr: value })`
- `s.expect.to_be_within({ expr: value; min: value; max: value })`
- `s.expect.to_contain({ expr: value; value: value })`
- `s.expect.to_end_with({ expr: value; value: value })`
- `s.expect.to_equal({ expr: value; value: value })`
- `s.expect.to_match({ expr: value; value: value })`
- `s.expect.to_not_be_defined({ expr: value })`
- `s.expect.to_not_be_null({ expr: value })`
- `s.expect.to_not_equal({ expr: value; value: value })`
- `s.expect.to_start_with({ expr: value; value: value })`
- `s.expect.to_throw` [special]

### function

- `s.function.call` [special]
- `s.function.run` [special]

### math

- `s.math.add({ name: string; value: value })` [output]
- `s.math.bitwise.and({ name: string; value: value })` [output]
- `s.math.bitwise.or({ name: string; value: value })` [output]
- `s.math.bitwise.xor({ name: string; value: value })` [output]
- `s.math.div({ name: string; value: value })`
- `s.math.mod({ name: string; value: value })`
- `s.math.mul({ name: string; value: value })`
- `s.math.sub({ name: string; value: value })`

### mcp

- `s.mcp.elicit` [special]
- `s.mcp.oauth.complete({ as?: string; request: value; decision: "approve" | "deny"; unsafe_user_id?: value })`
- `s.mcp.oauth.request({ as?: string; request: value })`
- `s.mcp.oauth.revoke({ as?: string; mcp_server: value; user_id?: value; grant_id?: value; all?: value })`
- `s.mcp.progress({ progress: value; total?: value; message?: value })`

### microservice

- `s.microservice.request` [special]

### middleware

- `s.middleware.call` [special]

### object

- `s.object.entries({ as?: string; value: value })` [output] → as: { key: string | number; value: unknown }[] (each entry is a { key, value } OBJECT, NOT a [key, value] tuple; an integer-like key comes back as a number)
- `s.object.keys({ as?: string; value: value })` [output] → as: (string | number)[] (an integer-like key comes back as a NUMBER (PHP coerces it), not a string)
- `s.object.values({ as?: string; value: value })` [output] → as: unknown[]

### realtime

- `s.realtime.get_session({ as?: string })`
- `s.realtime.publish` [special]
- `s.realtime.kick` [special]

### redis

- `s.redis.count({ as?: string; key: value })`
- `s.redis.decr({ as?: string; key: value; by?: value })`
- `s.redis.del({ key: value })`
- `s.redis.get({ as?: string; key: value })` → as: unknown (FALSE (not null) on a miss)
- `s.redis.has({ as?: string; key: value })`
- `s.redis.incr({ as?: string; key: value; by?: value })`
- `s.redis.keys({ as?: string; search: value })`
- `s.redis.pop({ as?: string; key: value; count?: value })`
- `s.redis.push({ as?: string; key: value; value: value })`
- `s.redis.range({ as?: string; key: value; start?: value; stop?: value })`
- `s.redis.ratelimit({ as?: string; key: value; max?: value; ttl?: value; error?: value })`
- `s.redis.remove({ as?: string; key: value; value: value; count?: value })`
- `s.redis.set({ as?: string; key: value; data: value; ttl?: value; create_only?: value })` → as: boolean (false when create_only meets an existing key (kept))
- `s.redis.shift({ as?: string; key: value; count?: value })`
- `s.redis.unshift({ as?: string; key: value; value: value })`

### security

- `s.security.check_password({ as?: string; text_password: value; hash_password: value })` [output] → as: boolean (true when the plaintext matches the stored hash. ⚠ not input.password — pass input.text() plaintext. ⚠ THROWS 500 on a non-hash hash_password (Invalid password syntax.))
- `s.security.create_auth_token` [special]
- `s.security.create_curve_key({ as?: string; curve?: "P-256" | "P-384" | "P-521"; format?: "object" | "base64" })`
- `s.security.create_password({ as?: string; character_count?: value; require_lowercase?: value; require_uppercase?: value; require_digit?: value; require_symbol?: value; symbol_whitelist?: value })`
- `s.security.create_rsa_key({ as?: string; bits?: value; format?: "object" | "base64" })`
- `s.security.create_secret_key({ as?: string; bits?: value; format?: "object" | "base64" })`
- `s.security.create_uuid({ as?: string })`
- `s.security.decrypt({ as?: string; data: value; algorithm?: "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc" | "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm"; key: value; iv: value })` → as: unknown (the plaintext; takes encrypt's RAW bytes (fl.base64_decode() a stored base64 first). ⚠ THROWS 500 on a wrong key/iv or non-ciphertext — wrap in s.try_catch)
- `s.security.encrypt({ as?: string; data: value; algorithm?: "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc" | "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm"; key: value; iv: value })`
- `s.security.jwe_decode({ as?: string; token: value; key: value; check_claims?: value; key_algorithm?: "A128KW" | "A192KW" | "A256KW" | "A128GCMKW" | "A192GCMKW" | "A256GCMKW" | "ECDH-ES+A128KW" | "ECDH-ES+A192KW" | "ECDH-ES+A256KW"; content_algorithm?: "A128GCM" | "A192GCM" | "A256GCM" | "A128CBC-HS256" | "A192CBC-HS384" | "A256CBC-HS512"; timeDrift?: value })` → as: unknown (the decoded claims. ⚠ THROWS 500 ERROR_FATAL on ANY failure (bad/expired token, wrong key/algorithm, failed check_claims) — wrap in s.try_catch for a 401 (statements-calls.md))
- `s.security.jwe_encode({ as?: string; headers?: value; claims?: value; key: value; key_algorithm?: "A128KW" | "A192KW" | "A256KW" | "A128GCMKW" | "A192GCMKW" | "A256GCMKW" | "ECDH-ES+A128KW" | "ECDH-ES+A192KW" | "ECDH-ES+A256KW"; content_algorithm?: "A128GCM" | "A192GCM" | "A256GCM" | "A128CBC-HS256" | "A192CBC-HS384" | "A256CBC-HS512"; ttl?: value })`
- `s.security.jws_decode({ as?: string; token: value; key: value; check_claims?: value; signature_algorithm?: "PS256" | "PS384" | "PS512" | "RS256" | "RS384" | "RS512" | "HS256" | "HS384" | "HS512" | "ES256" | "ES384" | "ES512"; timeDrift?: value })` → as: unknown (the decoded claims. ⚠ THROWS 500 ERROR_FATAL on ANY failure (bad/garbage/expired/tampered token, wrong key/signature_algorithm, failed check_claims) — wrap in s.try_catch for a 401 (statements-calls.md))
- `s.security.jws_encode({ as?: string; headers?: value; claims?: value; key: value; signature_algorithm?: "PS256" | "PS384" | "PS512" | "RS256" | "RS384" | "RS512" | "HS256" | "HS384" | "HS512" | "ES256" | "ES384" | "ES512"; ttl?: value })`
- `s.security.random_bytes({ as?: string; length?: value })` → as: string (RAW bytes (encrypt too) — fl.bin2hex()/fl.base64_encode() before returning or storing; raw binary mangles in a JSON/text response)
- `s.security.random_number({ as?: string; min?: value; max?: value })`

### storage

- `s.storage.create_attachment({ as?: string; value: value; access?: "public" | "private" = "public"; filename?: value; include_meta?: boolean; type?: value })` → as: XanoFileRef (the stored file VALUE ({ access, path, name, type, size, mime, meta }) — write it into an f.attachment() cell. ⚠ include_meta: true binds the file's internal RECORD instead (id, guid, sig, the storage BUCKET name): never store it as the file value or return it (warns storage.include-meta-returned). type (also optional) coerces the kind when it is image/video/audio)
- `s.storage.create_audio({ as?: string; value: value; access?: "public" | "private" = "public"; filename?: value })` [output]
- `s.storage.create_file_resource({ as?: string; filename: value; filedata: value })` [output]
- `s.storage.create_image({ as?: string; value: value; access?: "public" | "private" = "public"; filename?: value })` [output]
- `s.storage.create_video({ as?: string; value: value; access?: "public" | "private" = "public"; filename?: value })` [output]
- `s.storage.delete_file({ pathname: value })` [output]
- `s.storage.read_file_resource({ as?: string; value: value })` → as: { name; size; mime; data: <contents> }
- `s.storage.sign_private_url({ as?: string; pathname: value; ttl?: value })`

### stream

- `s.stream.from_csv({ as?: string; value: value; separator?: value; enclosure?: value; escape_char?: value })` [output]
- `s.stream.from_jsonl({ as?: string; value: value })`
- `s.stream.from_request` [special]

### task

- `s.task.call` [special]

### text

`name` is an EXISTING variable the statement acts on. `trim`/`ltrim`/`rtrim`/`append`/`prepend` rewrite it IN PLACE and take no `as` (a non-text var is coerced, a null reads as `""`); on the trims `value` is a SET OF CHARACTERS to strip, not a substring (`"abcHIcba"` trimmed by `"abc"` → `"HI"`). The predicates (`contains`/`icontains`/`starts_with`/`istarts_with`/`ends_with`/`iends_with`) leave `name` unchanged and bind a boolean to `as` — without `as` they compute nothing (warns `stack.predicate-unbound`); an empty or omitted needle is `true`. An undeclared `name` 500s `Missing var entry`.

- `s.text.append({ name: string; value: value })`
- `s.text.contains({ name: string; as?: string; value: value })` → as: boolean
- `s.text.ends_with({ name: string; as?: string; value: value })` → as: boolean
- `s.text.icontains({ name: string; as?: string; value: value })` → as: boolean
- `s.text.iends_with({ name: string; as?: string; value: value })` → as: boolean
- `s.text.istarts_with({ name: string; as?: string; value: value })` → as: boolean
- `s.text.ltrim({ name: string; value: value })`
- `s.text.prepend({ name: string; value: value })`
- `s.text.rtrim({ name: string; value: value })`
- `s.text.starts_with({ name: string; as?: string; value: value })` → as: boolean
- `s.text.trim({ name: string; value: value })`

### tool

- `s.tool.call` [special]

### trigger

- `s.trigger.call` [special]

### util

`s.util.sleep`'s `value` is in SECONDS; a decimal is allowed (`c.decimal(0.5)` = 500 ms); a negative value returns at once. `s.util.set_header`'s `value` is a WHOLE `"Name: value"` line (there is no `name` field) — `c.text("X-Thing: on")`; a line with no colon sends an empty header, and a `Content-Type` line is IGNORED when the response is an object/JSON (it applies to a `c.text()` response). `s.util.template_engine`'s `value` is a Twig template with `$var`/`$input` in scope (`"Hello {{ $var.who }}"`); output is NOT HTML-escaped, a missing var renders `""`, and a syntax error 500s.

- `s.util.geo_distance({ as?: string; latitude_1: value; longitude_1: value; latitude_2: value; longitude_2: value })` → as: number (great-circle distance in METRES (a decimal) — divide by 1000 for km. Identical points return 0)
- `s.util.get_all_input({ as?: string })` → as: unknown (inside an ATTACHED middleware it is a { type, vars } envelope whose vars DIFFERS BY PHASE: pre → the request inputs; post → { status, result }, NOT the request — read the request in post with s.util.get_raw_input. ⚠ status is the STRING "ok" | "exception" (NOT an HTTP code), so store it in a text column, not f.int(); on "exception", result is the { code, message, payload } error and payload is set. See llms/kinds-core.md)
- `s.util.get_env({ as?: string })` → as: Record<string, string> (every workspace env var (declared AND dashboard) as one { NAME: value } object, each value TEXT — so this binds every SECRET; never return it to a client or write it to a row)
- `s.util.get_input` [special]
- `s.util.get_raw_input` [special]
- `s.util.get_vars({ as?: string })`
- `s.util.ip_lookup({ as?: string; value: value })` → as: IpLookupResult | null (NESTED, not flat: { continent: {code,name}, country: {code,name}, region: {code,name}, city: {name}, postal: {code}, location: {latitude, longitude, tz, radius} } — ref("geo.location.latitude"), ref("geo.city.name"); radius is KILOMETRES. ⚠ Every leaf is nullable (region/city/postal often null on a normal hit). `city` is an OBJECT: a bare ref("geo.city") into a text column fails and { safe: true } does NOT help; drill to city.name. The whole var is null for an unresolvable address)
- `s.util.post_process` [special]
- `s.util.send_email({ as?: string; api_key?: value; service_provider?: "resend" | "xano"; subject?: value; message?: value; to?: value; bcc?: value; cc?: value; from?: value; reply_to?: value; scheduled_at?: value })`
- `s.util.set_header({ value: value; duplicates?: "replace" | "append" })`
- `s.util.sleep({ value: value })`
- `s.util.template_engine({ as?: string; value: value })`

### webflow

- `s.webflow.request` [special]

### workflow_test

Run another workflow test from inside one. Pass the `workflowTest()` def handle, not a name.

- `s.workflow_test.call` [special]

### zip

- `s.zip.add_to_archive({ file: value; filename: value; zip: value; password?: value; password_encryption?: value })`
- `s.zip.create_archive({ as?: string; filename: value; password?: value; password_encryption?: "standard" | "AES-128" | "AES-192" | "AES-256" })`
- `s.zip.delete_from_archive({ filename: value; zip: value; password?: value })`
- `s.zip.extract({ as?: string; zip: value; password?: value })`
- `s.zip.view_contents({ as?: string; zip: value; password?: value })`
