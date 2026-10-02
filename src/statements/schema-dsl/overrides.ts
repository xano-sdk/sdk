/**
 * Scoped corrections for defects in Xano's upstream statement schema YAML
 * (which `AGENTS.md` treats as read-only third-party). Applied to an
 * interpreted {@link StatementSpec} as the last step of generation, so the fix
 * survives every regeneration — hand-editing the generated catalog would be
 * clobbered on the next codegen run. The canonical regeneration pipeline
 * (`scripts/codegen.ts`) and the reproducibility test both route through here,
 * so the committed catalog and a fresh regeneration always agree.
 */
import type { FieldRule, StatementSpec } from "./interpret.js";

/**
 * Apply every known upstream-schema correction to `spec` in place.
 *
 * - `mvp:mcp_call_tool` (`s.ai.external.mcp.tool.run`): the upstream engine
 *   schema copy-pastes `connection_type`'s `?="sse"`
 *   default onto the unrelated `args` rule (`args?="sse"`), so the grounding
 *   doc renders a bogus `args = "sse"`. Drop that default; `connection_type`'s
 *   own legitimate "sse" default is left intact.
 *
 * - The **Elasticsearch / OpenSearch / S3-list family**: the upstream schema for
 *   these six carries the wrong field set, and it is not a cosmetic difference —
 *   `cloud.elasticsearch.query` had no way to emit `base_url`, so every
 *   statement it authored named no server.
 *
 *   Elasticsearch is not AWS and its engine classes have **no `region`**, while
 *   OpenSearch's do; the upstream schema gives `region` to both, which is what a
 *   copy of the OpenSearch shape onto the Elasticsearch surfaces would produce.
 *   Both query surfaces also lost `base_url` and `expression`.
 *
 *   Four independent sources agree on the corrected shapes, which is why these
 *   are safe to assert: the engine's own declared schema for each statement;
 *   the stored bytes of every affected statement in a 187-workspace sweep; the
 *   editor, whose shared query component carries a per-platform POSITIONAL index
 *   map that is uniformly one lower for Elasticsearch than OpenSearch — exactly
 *   the `region` it does not have; and the round trip, which decodes.
 *
 *   Order is reproduced, not load-bearing. The engine binds `input[]` entries by
 *   NAME — the list is keyed under each entry's own `name` before binding
 *   — so a reordered list cannot cross-wire values. What order costs is
 *   BYTE-FIDELITY: a list the engine would not have written drops the statement
 *   to `raw()`. The rules are re-ordered for that reason, and the editor's index
 *   map is the evidence for which order the bytes actually carry.
 *   See {@link ADJUDICATED_ORDER}.
 *
 * - **{@link UNDECLARED_CONTEXT}**: a context member the engine class declares
 *   and reads, which upstream's schema YAML does not list — so it had no
 *   authored form and its mere presence forced a `raw()` fallback.
 *
 * - **{@link BINDS_RESULT}**: a statement whose engine class returns a value,
 *   where upstream's schema declares no `as` argument to name it. The binding is
 *   stored on the stack item all the same, so without the rule a pulled
 *   workspace cannot reproduce it.
 */
export function applySpecOverrides(spec: StatementSpec): void {
  if (spec.name === "mvp:mcp_call_tool") {
    const args = spec.rules.find((r) => r.field === "args");
    if (args && args.default === "sse") delete args.default;
  }
  if (spec.name === "mvp:elasticsearch_request") {
    // Upstream names the body `query`; the engine class reads `payload`. Renamed
    // before the reshape below, so the rule's default survives the move.
    const body = spec.rules.find((r) => r.field === "query");
    if (body && body.route.kind === "input") {
      body.field = "payload";
      body.route = { ...body.route, name: "payload" };
    }
  }
  const search = SEARCH_FAMILY[spec.name];
  if (search) reshapeInputs(spec, search);
  if (spec.name === "mvp:amazon_s3_list_directory") {
    // The engine declares both with a trailing `?`; upstream marks them
    // required, so a stored statement that omits `prefix` could not decode and
    // an author was forced to pass a paging token they do not have.
    for (const field of ["prefix", "next_page_token"]) {
      const rule = spec.rules.find((r) => r.field === field);
      if (rule) rule.optional = true;
    }
  }
  for (const stored of CLASS_OPTIONAL[spec.name] ?? []) {
    findInput(spec, stored, "CLASS_OPTIONAL").optional = true;
  }
  for (const stored of CLASS_REQUIRED[spec.name] ?? []) {
    const rule = findInput(spec, stored, "CLASS_REQUIRED");
    rule.optional = false;
    // A required field may not keep a DEFAULT, and this line is the whole
    // correction for the search family. `scripts/codegen.ts` computes authoring
    // optionality as `optional || default !== undefined`, so a default silently
    // defeats the flag: the field keeps its `?`, the argument object keeps its
    // `= {}`, and the encoder substitutes instead of throwing. The correction
    // would land and change nothing. It is also a contradiction on its own
    // terms — a default is what is used when the field is ABSENT, and absent is
    // exactly what this table refuses.
    delete rule.default;
  }
  for (const field of READ_UNCONDITIONALLY[spec.name] ?? []) {
    const rule = spec.rules.find((r) => r.field === field && r.route.kind === "context-nest");
    if (!rule) {
      throw new Error(
        `READ_UNCONDITIONALLY names "${field}" on ${spec.name}, which has no context field by that name`,
      );
    }
    rule.emptyWhenAbsent = true;
  }
  if (BINDS_RESULT.has(spec.name) && !spec.rules.some((r) => r.route.kind === "as")) {
    // `as` first, matching every sibling spec the upstream schema does declare
    // one for — the order is what the generated factory's field list reads from.
    spec.rules.unshift({ field: "as", type: "string", optional: true, route: { kind: "as" } });
  }
  const context = UNDECLARED_CONTEXT[spec.name];
  if (context && !spec.rules.some((r) => r.field === context.field)) {
    spec.rules.push(context);
  }
  const missing = UNDECLARED_INPUT[spec.name];
  if (missing && !spec.rules.some((r) => r.field === missing)) {
    spec.rules.push({
      field: missing,
      type: "value",
      optional: true,
      route: { kind: "input", name: missing },
    });
  }
}

/**
 * Context fields optional to AUTHOR that the engine reads unconditionally.
 *
 * Upstream's XanoScript schema marks each block optional (`password?`), but the
 * engine class declares the context key with no default, so a statement that
 * omits it deploys clean and then answers every request with `400 Missing
 * param: <field>` — on every engine. Requiring the field would make an author
 * invent a password to read an unencrypted archive, so neither side is right
 * as it stands.
 *
 * The engine's own XanoScript form settles it: its golden stores
 * `password = ""` on every one of these statements (and `password_encryption =
 * ""` on `add_to_archive`), which is what "no password" means to the
 * statement. So an omitted field is written as that empty constant
 * ({@link FieldRule.emptyWhenAbsent}), and the decoder reads the empty constant
 * back as omitted. A statement stored with NO key (saved before this fill)
 * decodes to an explicit `null`, which writes no key, so a pull still
 * reproduces it byte-for-byte.
 *
 * `create_archive` is not here: its password routes through `input[]`, which
 * the engine does default.
 */
export const READ_UNCONDITIONALLY: Readonly<Record<string, readonly string[]>> = {
  "mvp:zip_add_file_resource": ["password", "password_encryption"],
  "mvp:zip_delete_file_resource": ["password"],
  "mvp:zip_extract_file_resource": ["password"],
  "mvp:zip_view_contents": ["password"],
};

/**
 * The input rule a correction table names, or a throw.
 *
 * Both tables key on the STORED input name, which is what the engine class
 * declares — an authoring name may differ (`mvp:mcp_call_tool` authors `tool`
 * and stores `tool_name`), so matching on the authoring name is a mistake.
 *
 * It throws rather than skipping because the failure is otherwise invisible: a
 * renamed rule or a mistyped key would leave the correction silently unapplied,
 * and the only symptom is a field quietly reverting to whatever upstream said.
 * These tables exist to stop exactly that class of silent wrongness, so they may
 * not fail that way themselves. Codegen and the reproducibility test both route
 * through here, so a bad key fails the build rather than shipping.
 */
function findInput(spec: StatementSpec, stored: string, table: string): FieldRule {
  const rule = spec.rules.find((r) => r.route.kind === "input" && r.route.name === stored);
  if (!rule) {
    throw new Error(
      `${table}["${spec.name}"] names input "${stored}", which the spec has no rule for. ` +
        `Either the upstream schema renamed it, or the entry is a typo — fix the table, ` +
        `never the generated catalog.`,
    );
  }
  return rule;
}

/**
 * Statements that BIND a result the upstream schema gives them no way to name.
 *
 * `as` is a member of every stored stack item, not an argument of a particular
 * statement, and the engine class for each of these returns a value — so the
 * editor lets an author bind it and the workspace stores the binding. Upstream's
 * schema YAML declares the `as` arg for the siblings (`redis.shift`, `redis.pop`,
 * `redis.range`, `redis.ratelimit` all have one) and omits it here, which is the
 * signature of an omission rather than a decision.
 *
 * Without the rule the binding has nowhere to go: the statement cannot be
 * authored with one, and a pulled workspace that stored one degrades to `raw()`
 * — while any later step reading `$var.<name>` resolves to nothing.
 *
 * `redis.set` is the same omission carrying one more piece of evidence: its
 * engine class DECLARES the value it returns (a bool) as its output schema, and
 * the one redis sibling declaring no output — `redis.del` — is also the one
 * whose schema legitimately omits `as`. That contrast is the argument: across
 * the family, no `as` tracks no return value everywhere except here.
 *
 * The binding is not inert for want of the declaration, and that is measured
 * rather than reasoned: a deployed run claiming one key twice reports `true`
 * then `false` on the two bindings, so the value resolves AND carries the
 * conditional write's real outcome. The engine sets the variable from the stack
 * item's own `as` member, for every statement alike, rather than from anything
 * the statement's schema declares — so what the rule restores is the ability to
 * author and recover a binding the engine already honours.
 *
 * It matters more since `create_only` became authorable: a
 * conditional write may not happen, and the returned bool is the only thing that
 * says whether it did.
 */
const BINDS_RESULT: ReadonlySet<string> = new Set(["mvp:redis_remove_list", "mvp:redis_set"]);

/**
 * Statement CONTEXT members the engine reads that upstream's schema never
 * declares.
 *
 * `create_attachment`'s `include_meta` is declared in the engine class's own
 * context schema (`include_meta?=false: bool`) and read there to pick the
 * statement's OUTPUT shape: set, the statement returns the file's whole metadata
 * record; unset, it returns the blob alone. It is a toggle in the editor and
 * four statements in the survey corpus carry it, all at `false` — which was
 * enough to force `raw()` on its own, since presence and absence are different
 * bytes.
 *
 * No default is declared here on purpose. The engine defaults the flag and its
 * renderer omits it at that default, so absent, `false` and `true` are three
 * distinct stored states and the rule has to carry whichever it was given.
 */
const UNDECLARED_CONTEXT: Readonly<Record<string, FieldRule>> = {
  "mvp:create_attachment": {
    field: "include_meta",
    type: "boolean",
    optional: true,
    route: { kind: "context-plain", path: "include_meta" },
  },
};

/**
 * Statement inputs the engine READS that upstream's schema never declares.
 *
 * Both are ordinary optional inputs in the engine's declared schema for these
 * statements, and both are read at runtime: `set_data_source` takes
 * `workspace_id` as the workspace to switch to, and `create_attachment` takes
 * `type` and honours it when it is one of `image`/`video`/`audio`. Upstream's
 * schema YAML lists neither, so the generated factories had no way to author them
 * and a stored one had nowhere to go.
 *
 * They are asserted rather than dropped BECAUSE they are live. The two instances
 * in the survey corpus happen to be inert at their stored values — PHP reads
 * `workspace_id: 0` as falsy, so it behaves exactly like absent, and `type: ""`
 * is not in the allowed list — but that is a fact about those two values, not
 * about the fields. A real `workspace_id` or `type: "image"` changes what the
 * statement does, so discarding the surface would lose a live one.
 */
const UNDECLARED_INPUT: Readonly<Record<string, string>> = {
  "mvp:set_data_source": "workspace_id",
  "mvp:create_attachment": "type",
};

/**
 * Inputs the schema YAML declares that the engine class NEVER READS.
 *
 * The two sources answer different questions, and this is the case where the
 * split matters most. The XanoScript schema is authoritative for
 * SERIALIZATION — it is what the editor compiles, so the stored bytes carry
 * whatever it declares. The engine class is authoritative for SEMANTICS. A
 * field the schema declares and the class never touches is therefore REAL in
 * the bytes and INERT at run time, which is the worst combination to leave
 * unmarked: an author supplies it, it round-trips perfectly, and it does
 * nothing.
 *
 * `connect_webflow_api_request`'s `headers` is the one found so far, and it is
 * not a near miss. The class's declared argument list does not contain the
 * field at all, and its request path builds a fresh header array holding only
 * the API version and the bearer credential, then passes THAT to the fetch —
 * `$args["headers"]` appears nowhere in the file. So an authored header is
 * stored, ignored, and never sent. For a statement whose whole purpose is
 * calling an authenticated third-party API, "my auth header vanished" is the
 * expensive version of that mistake.
 *
 * ## Why the rule is KEPT, and the refusal is at the TYPE only
 *
 * Deleting the rule is the tidier-looking fix and the riskier one. The schema
 * YAML declares `headers?=[]`, so a workspace authored in the editor may store
 * the field; a catalog with no rule for it cannot reproduce those bytes and
 * every such statement falls to `raw()` on pull. The corpus has ZERO instances
 * of this statement, so there is no evidence either way about what the editor
 * emits — and a guess that costs a `raw()` fallback on every editor-authored
 * webflow call is the wrong guess to make blind.
 *
 * The refusal therefore lives on the AUTHORING TYPE — `headers` is omitted from
 * `WebflowRequestArgs` — and not in the encoder. This is a deliberate departure
 * from the both-paths posture the rest of this file takes, and the reason is
 * that here the two paths genuinely disagree. `encodeFromSpec` serves BOTH
 * authoring and the decode → re-encode round trip, with no signal separating
 * them: an encoder throw refuses the author (wanted) and simultaneously breaks
 * reproduction of a stored statement (not wanted). A missing REQUIRED field has
 * no such conflict, which is why the both-paths rule holds there and not here.
 *
 * What this leaves uncovered, stated plainly: untyped JavaScript can still pass
 * `headers` and have it stored. The type is the SDK's feedback channel for the
 * author it is built for, and that is the half worth having.
 */
export const UNREAD_INPUT: Readonly<Record<string, readonly string[]>> = {
  "mvp:connect_webflow_api_request": ["headers"],
};

/**
 * Inputs the schema YAML marks REQUIRED and the engine class marks OPTIONAL.
 *
 * This direction is the one that strands a stored statement. The decoder has to
 * satisfy its own spec, so a required rule with nothing to recover from is a
 * decline — and a workspace that legitimately omitted the field (because the
 * engine lets it) drops to `raw()` with the message "required X not recoverable
 * from its input route". Two of these were reported directly; the rest are the
 * same defect on their siblings.
 *
 * Evidence is the engine class's own declared input schema — a trailing `?` on
 * the field — plus, for the S3 and GCS uploads, a live round trip: an upload
 * imported with NO metadata entry comes back without one, so absent is a state
 * the engine keeps rather than fills in.
 *
 * The OPPOSITE direction is deliberately not corrected here. The audit also
 * finds fields the class marks required and the schema marks optional
 * (`crypto_encrypt`'s `key`, `lambda`'s `code`, …). Narrowing those would make
 * an authoring argument mandatory on the strength of one source, and the failure
 * they describe is a runtime error on a statement nobody could have stored by
 * accident — the opposite of a workspace that cannot be pulled.
 */
const CLASS_OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  "mvp:amazon_s3_upload_file": ["metadata"],
  "mvp:google_cloud_storage_upload_file": ["metadata"],
  "mvp:azure_blob_storage_upload_file": ["metadata"],
  "mvp:azure_blob_storage_list_directory": ["path"],
  "mvp:azure_blob_storage_signed_url": ["ttl"],
  "mvp:google_cloud_storage_signed_url": ["method", "ttl"],
  "mvp:microservice_request": ["method", "params", "timeout", "follow_location"],
  "mvp:algolia_request": ["method"],
};

/**
 * Inputs the engine class marks REQUIRED and the schema YAML marks OPTIONAL.
 *
 * The inverse of {@link CLASS_OPTIONAL}, and the comment there used to say this
 * direction was deliberately left alone: narrowing would make an authoring
 * argument mandatory "on the strength of one source", and the failure it
 * describes is a runtime error rather than a workspace that cannot be pulled.
 *
 * The first half of that still holds and is honoured below — nothing here rests
 * on the class declaration alone. The second half was a judgement about a HUMAN
 * author, who reads the runtime error and adds the argument. This SDK's primary
 * author is an agent, for which the type is the only feedback that arrives while
 * the code is being written; a deploy-time error reaches whoever is watching the
 * deploy, not the writer. So the cost side of that trade changed, and the
 * correction is worth its evidence.
 *
 * ## Why a bare field is not by itself evidence
 *
 * A class declares three shapes: `name: type` (bare), `name?: type` (optional,
 * no default) and `name?=X: type` (optional with default). Bare means only that
 * the decode declares no default — NOT that the engine rejects an absent value.
 * Several bare fields are plainly upstream oversights, and the contrast that
 * shows it is inside the declaration itself:
 *
 *   - `generate_pass` declares `require_lowercase?=true`, `require_uppercase?=true`
 *     and `require_digit?=true`, then `require_symbol` bare. Four flags of one
 *     kind, three with defaults.
 *   - `amazon_opensearch_query` / `elasticsearch_query` declare `size?=null` and
 *     then `from` bare — the two halves of one paging pair.
 *   - every bare LIST field (`headers[]`, `sort[]`, `expression[]`,
 *     `included_fields[]`). A list's absent state is the empty list.
 *
 * None of those are corrected. Asserting them would encode an upstream defect
 * as an SDK requirement.
 *
 * ## What each entry below rests on
 *
 * Three legs, per
 * `tell-a-schema-omission-from-a-decision-by-the-family-contrast` and
 * `read-the-engine-history-before-calling-a-spec-stale`:
 *
 *  1. **Within-statement control.** The same class marks OTHER fields optional,
 *     so bare is a choice rather than the author's habit. Every statement here
 *     satisfies this except `check_pass` and `calculate_geo_distance`, which
 *     declare no optional field at all; those two rest on the family control
 *     (`generate_pass` is the sibling that does use `?`) plus the fact that a
 *     zero value is meaningless for every field they declare — an empty password
 *     pair, or a distance computed from 0,0.
 *  2. **Engine history.** `git log` over each statement's schema and class file
 *     shows no field here was retired upstream, so the catalog is not simply
 *     older than a removal.
 *  3. **Stored bytes.** A 187-workspace sweep found 306 stored instances of the
 *     statements below — `api_request` 147, `check_pass` 93, `lambda` 40,
 *     `mcp_call_tool` 6, the crypto and JWE/JWS surfaces 12, `geo_distance` 3 —
 *     and NOT ONE omits a field listed here. The same sweep reports no
 *     round-trip mismatch and no new raw fallback on any of them, so the cost
 *     described below is measured at zero on real data rather than argued.
 *
 * ## The two that arrived later, and what they rest on
 *
 * `streaming_api_request` and `connect_webflow_api_request` were not in the
 * first pass, and neither was overlooked — the audit could not SEE the first
 * one and the second's evidence is shaped differently.
 *
 * `streaming_api_request` shares its argument declaration with `api_request` by
 * INHERITANCE, and the audit read only a class's own declaration, so it landed
 * in the "declares no comparable argument schema" tally and was never compared.
 * `scripts/spec-drift.ts` now follows the chain. Its `url` is therefore the same
 * declaration `api_request`'s rests on, read by the same code; the sweep finds 2
 * stored instances and neither omits it.
 *
 * `connect_webflow_api_request`'s `path` carries a leg none of the others do:
 * the class does not merely declare it bare, it REJECTS an empty one at run
 * time with its own named error. That is a direct runtime rejection rather than
 * an inference from a declaration. Its stored-bytes leg is EMPTY rather than
 * passing — the sweep finds zero instances anywhere in the corpus — which means
 * the correction cannot strand a workspace, but also that nothing confirms the
 * field's real-world use. The runtime rejection is what carries it.
 *
 * ## The search family
 *
 * Corrected: 26 fields across the five surfaces — the credentials
 * (`key_id`, `access_key`, `region` on the AWS ones) and the target
 * (`base_url`/`url`, `index`, `payload`/`query`, `doc_id`/`doc`).
 *
 * These needed more than the flag. Every one carried a `""` or `{}` DEFAULT, and
 * a default silently defeats the flag — see the `delete rule.default` in
 * `applySpecOverrides`, which is the line that makes this table reach them.
 *
 * A third leg is available here that the statements above do not have, and it is
 * the strongest of the set: the schema YAML CONTRADICTS ITSELF. Its authoring
 * `blocks:` section declares these fields bare — required — while its
 * `transform:` section, which is what the catalog is generated from, marks the
 * same fields `?=''`. The engine class agrees with `blocks:`. So two of the
 * three declarations say required and the odd one out is the layer that adds an
 * empty default, which is the shape of a serialization artifact rather than a
 * statement about the argument.
 *
 * `mvp:elasticsearch_document` is the within-family control: same class shape,
 * same field set, and it carries NO defaults on any of them — which is why the
 * audit reports nothing against it and why the `''` on its siblings reads as
 * noise rather than intent. Stored bytes: 9 instances across the corpus, none
 * omitting a corrected field.
 *
 * NOT corrected, on the same evidence bar that excludes the bare fields above:
 * `expression[]`, `sort[]` and `included_fields[]` (a list's absent state is the
 * empty list) and `from` (the class declares `size?=null` and then `from` bare
 * — two halves of one paging pair). Eight fields. The audit reports 34
 * findings for this family and 26 are corrected; that is the arithmetic, stated
 * here so nobody has to rederive it.
 *
 * The interaction risk that held this back is tested rather than argued:
 * {@link SEARCH_FAMILY} reshapes membership AND order together, and a MEMBERSHIP
 * error mistypes or strands a field. (The reordering half cannot cross-wire
 * values — `input[]` binds by name; see {@link ADJUDICATED_ORDER} — but it does
 * decide whether the statement round-trips at all.)
 * `mvp:amazon_opensearch_request` is the control for that — it is the one
 * surface with no reshape.
 *
 * ## `mcp_call_tool`'s `tool_name`
 *
 * Corrected too, on the default-clearing above, but its evidence is shaped
 * differently from the search family's and the difference is worth stating.
 *
 * There is NO self-contradiction to lean on here: both halves of the schema
 * YAML agree on `tool?=""`. So this rests on the class declaration plus the
 * three legs, not on an internal disagreement.
 *
 *  1. Within-statement control: the same declaration marks `bearer_token?`,
 *     `connection_type?=sse` and `args?` optional, leaving `url` and `tool_name`
 *     as the two bare ones — and `url` is already corrected off that same
 *     declaration. The stored bytes make the same point from the other side:
 *     `bearer_token` is present-but-EMPTY in all six instances, which is what a
 *     genuinely optional field looks like here, and `tool_name` is empty in
 *     none.
 *  2. Engine history: introduced bare and never touched — no `-` line for it in
 *     the class's whole history, so it was neither loosened nor retired.
 *  3. Stored bytes: 6 instances across the corpus, none omitting it.
 *
 * The field also cannot be meaningfully empty. It names the tool to invoke and
 * is forwarded whole to the MCP service, so an absent one — substituted to `""`
 * per the run-time finding above — asks a remote server for a tool called
 * nothing.
 *
 * ## The cost this accepts
 *
 * `decodeFromSpec` reads the same flag, so a STORED statement that omits one of
 * these fields now declines and falls back to `raw()`. That is lossless — the
 * fallback re-encodes byte-identically — and it is reported rather than silent.
 * Leg 3 keeps the size of that cost from being a guess, and
 * `test/codegen/spec-inverse.test.ts` pins all three properties.
 *
 * ## What the engine does at RUN time
 *
 * It SUBSTITUTES a type default and runs. It does not reject.
 *
 * A class declaring no default is a fact about the declaration, not about the
 * runtime, so this was measured rather than reasoned:
 * `scripts/probe-absent-required-field.ts` deploys each statement authored
 * through `raw()` — the encoder refuses the direct form, which is this table
 * working — and calls it. `calculate_geo_distance` with all four coordinates
 * absent returns `0` at HTTP 200, a real distance from 0,0 to 0,0.
 * `crypto_encrypt` with no `data` returns a valid ciphertext at HTTP 200, of
 * the empty string. Neither errors, warns, or logs.
 *
 * That is the worse of the two possible answers and the one that argues hardest
 * for this table. A rejection would at least be loud to whoever ran the request;
 * a substituted default means the statement returns a confident wrong answer
 * that nothing downstream can tell from a right one. Authoring time is the only
 * place the mistake is catchable, which is where this table catches it.
 */
const CLASS_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "mvp:lambda": ["code"],
  "mvp:api_request": ["url"],
  "mvp:streaming_api_request": ["url"],
  "mvp:connect_webflow_api_request": ["path"],
  // Keyed on the STORED name: this statement authors `tool` and stores
  // `tool_name`, and matching the authoring name is the mistake `findInput`
  // exists to make impossible.
  "mvp:mcp_call_tool": ["url", "tool_name"],
  "mvp:mcp_list_tools": ["url"],
  "mvp:mcp_server_details": ["url"],
  "mvp:crypto_encrypt": ["data", "key", "iv"],
  "mvp:crypto_decrypt": ["data", "key", "iv"],
  "mvp:crypto_jwe_encode3": ["key"],
  "mvp:crypto_jws_encode2": ["key"],
  "mvp:crypto_jwe_decode2": ["token", "key"],
  "mvp:crypto_jws_decode2": ["token", "key"],
  "mvp:datadog_log": ["message"],
  "mvp:datadog_metric": ["metric"],
  "mvp:check_pass": ["text_password", "hash_password"],
  "mvp:calculate_geo_distance": ["latitude_1", "longitude_1", "latitude_2", "longitude_2"],
  // The search family. See "The search family" above for what these rest on and
  // why eight sibling fields are deliberately NOT here.
  "mvp:amazon_opensearch_request": ["key_id", "access_key", "region", "url", "query"],
  "mvp:elasticsearch_request": ["key_id", "access_key", "url", "payload"],
  "mvp:amazon_opensearch_query": ["key_id", "access_key", "region", "base_url", "index", "payload"],
  "mvp:elasticsearch_query": ["key_id", "access_key", "base_url", "index", "payload"],
  "mvp:amazon_opensearch_document": ["key_id", "access_key", "region", "index", "doc_id", "doc"],
};

/**
 * Statements whose stored `input[]` ORDER disagrees with the engine class's
 * DECLARED argument order, adjudicated in favour of upstream's schema.
 *
 * The value is the evidence, which `scripts/spec-drift.ts` prints when it
 * suppresses the finding. Recording the reason here rather than the finding
 * itself is what keeps a clean audit run meaningful.
 *
 * ## Why the class's order is not the stored order
 *
 * A statement's stored `input[]` is a list of `{name, value}` entries, and the
 * engine keys it BY NAME before binding: the list is migrated into a map under
 * each entry's own `name`. Order is therefore COSMETIC to execution
 * and matters only to byte-fidelity — the SDK has to emit what the engine
 * persists, but emitting a different order could never transpose two fields'
 * values.
 *
 * The stored lists are also SPARSE: only authored fields appear. Every
 * `send_email` in the corpus omits `to` from the middle of the list while
 * keeping the fields after it, which positional binding could not survive —
 * `bcc` would land in `to`'s slot and no email would have a recipient.
 *
 * ## `send_email`
 *
 * Upstream's `transform` block lists `api_key` before `service_provider`; the
 * class declares them the other way round. Following the class order costs
 * byte-fidelity: a sweep of 177 real workspaces found 12 stored
 * `send_email` instances, 10 of them leading with `api_key` and the other 2
 * consistent with it (they omit `api_key` entirely). NONE lead with
 * `service_provider` while carrying an `api_key`. Emitting the class order
 * dropped all 10 to `raw()`.
 *
 * A live round trip is not counter-evidence: because binding is by name, the
 * engine returns whatever order it is sent unchanged. It proves the class order
 * is ACCEPTED, not that it is what the engine writes.
 */
export const ADJUDICATED_ORDER: Readonly<Record<string, string>> = {
  "mvp:send_email":
    "the class declares `service_provider` before `api_key`; upstream's transform and " +
    "all 12 stored instances in the 177-workspace corpus lead with `api_key`. " +
    "`input[]` binds by name, so the order is cosmetic to execution and the stored " +
    "order is the one worth reproducing.",
};

/**
 * The stored `input[]` order and membership per statement.
 *
 * Membership comes from the engine's declared schema per statement. ORDER comes from
 * the EDITOR, which is what actually writes the bytes: its shared query
 * component carries a per-platform positional index map, and the two disagree —
 * the engine declares `expression`/`sort` mid-schema while the editor stores
 * them last. The editor's order is the one every stored statement has.
 *
 * That per-platform map is also the cleanest proof that Elasticsearch has no
 * `region`: every Elasticsearch index is exactly one lower than its OpenSearch
 * counterpart.
 *
 * `[]`-suffixed names are list-valued (default `[]`).
 */
const SEARCH_FAMILY: Readonly<Record<string, readonly string[]>> = {
  "mvp:elasticsearch_document": ["auth_type", "key_id", "access_key", "base_url", "index", "method", "doc_id", "doc"],
  "mvp:elasticsearch_query": ["auth_type", "key_id", "access_key", "base_url", "index", "payload", "size", "from", "included_fields[]", "return_type", "expression[]", "sort[]"],
  "mvp:elasticsearch_request": ["auth_type", "key_id", "access_key", "method", "url", "payload"],
  "mvp:amazon_opensearch_query": ["auth_type", "key_id", "access_key", "region", "base_url", "index", "payload", "size", "from", "included_fields[]", "return_type", "expression[]", "sort[]"],
  "mvp:amazon_opensearch_document": ["auth_type", "key_id", "access_key", "region", "base_url", "method", "index", "doc_id", "doc"],
};

/**
 * Rewrite a spec's INPUT rules to `wanted`, in order: drop the ones the engine
 * does not declare, add the ones it does, and re-order the rest. Non-input rules
 * (`as`, and anything routed elsewhere) keep their place at the front.
 *
 * Existing rules are reused wherever the name matches, so upstream's defaults
 * and optionality survive; only membership and order are asserted here.
 */
function reshapeInputs(spec: StatementSpec, wanted: readonly string[]): void {
  const byName = new Map<string, FieldRule>();
  for (const rule of spec.rules) {
    if (rule.route.kind === "input") byName.set(rule.route.name, rule);
  }
  const rebuilt = wanted.map((entry) => {
    const isList = entry.endsWith("[]");
    const name = isList ? entry.slice(0, -2) : entry;
    return (
      byName.get(name) ?? {
        field: name,
        type: "value" as const,
        optional: true,
        default: isList ? "[]" : "",
        route: { kind: "input" as const, name },
      }
    );
  });
  spec.rules = [...spec.rules.filter((r) => r.route.kind !== "input"), ...rebuilt];
}

/**
 * Fields an engine class declares BARE that are not requirements, adjudicated.
 *
 * Audit metadata, not a correction — nothing here changes a generated spec. The
 * catalog already types these optional and that is the right answer; this table
 * records WHY, so `scripts/spec-drift.ts` can stop asking.
 *
 * The distinction it encodes is the one {@link CLASS_REQUIRED}'s comment opens
 * with: bare means the decode declares no default, NOT that the engine rejects
 * an absent value. Every entry below was run through the same three legs the
 * corrections were, and failed — which is a result, not an absence of one. Left
 * unrecorded, each costs a maintainer the same investigation on every run, and
 * an audit that reports a dozen findings nobody should act on is one nobody
 * reads.
 *
 * Each reason is the evidence, not a label. If a future engine change makes one
 * false, the line says what to re-check.
 */
export const ADJUDICATED_OPTIONAL: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "mvp:api_request": {
    headers:
      "a bare LIST (`headers[]`) — a list's absent state is the empty list. " +
      "146 of 147 stored instances carry it EMPTY and one omits it, so requiring " +
      "it would refuse the call every real workspace already makes",
  },
  "mvp:streaming_api_request": {
    headers: "the same `headers[]` list, inherited from the same declaration as `api_request`'s",
  },
  "mvp:generate_pass": {
    require_symbol:
      "three sibling flags of the same kind — `require_lowercase`, " +
      "`require_uppercase`, `require_digit` — all declare `?=true` and this one " +
      "does not. Four booleans, three defaulted: the shape of an upstream " +
      "oversight, not a fourth flag the caller must supply",
    symbol_whitelist:
      "declared bare beside `require_symbol` and stored EMPTY in both corpus " +
      "instances, so the engine supplies its own symbol set. Requiring it would " +
      "make an author invent one to generate a password",
  },
  "mvp:elasticsearch_query": {
    expression: "a bare LIST (`expression[]`) — absent means no filter, not a missing argument",
    sort: "a bare LIST (`sort[]`) — absent means unsorted",
    included_fields: "a bare LIST (`included_fields[]`) — absent means all fields",
    from:
      "the second half of a paging pair whose first half declares `size?=null`. " +
      "One of the two got a default and the other did not; page-from-zero is the " +
      "meaning of absent",
  },
  "mvp:amazon_opensearch_query": {
    expression: "a bare LIST (`expression[]`) — absent means no filter, not a missing argument",
    sort: "a bare LIST (`sort[]`) — absent means unsorted",
    included_fields: "a bare LIST (`included_fields[]`) — absent means all fields",
    from: "the same `size?=null` / `from` paging pair as the Elasticsearch surface",
  },
};

/**
 * Statements whose stored `input[]` ORDER is asserted by an override table
 * above rather than inherited from upstream's schema YAML.
 *
 * `scripts/spec-drift.ts` consults this to tell a DECISION from a DEFECT. For
 * these statements the catalog is deliberately out of step with the engine
 * class's declared order — {@link SEARCH_FAMILY} because the EDITOR writes the
 * bytes and orders `expression`/`sort` last where the class declares them
 * mid-schema, {@link ADJUDICATED_ORDER} because the stored bytes follow
 * upstream's schema and the class's declared order is not what gets persisted.
 * Reporting either as drift asks a maintainer to re-adjudicate a settled
 * question on every run.
 *
 * Derived from the tables themselves rather than restated, so adding a
 * statement to either one suppresses its order finding without a second edit.
 *
 * Every member carries a REASON, which is the line the audit prints. There is
 * no generic fallback: a suppression with nothing to say is indistinguishable
 * from an unexamined one, and the whole value of a clean run is that each
 * suppressed line already answers "why".
 */
const EDITOR_INDEX_MAP =
  "the EDITOR writes the bytes, and its shared query component carries a per-platform " +
  "positional index map that the engine class does not follow; the editor's order is the " +
  "one every stored statement has";

/**
 * Why each {@link SEARCH_FAMILY} member's order is asserted.
 *
 * Only the two QUERY surfaces declare `expression`/`sort`, so only they can be
 * described by where those two land. The request and document surfaces are
 * asserted on the index map alone — saying otherwise would suppress a future
 * finding on them with a rationale about fields they do not have.
 *
 * Every member needs an entry; the assertion below fails the build otherwise.
 */
const SEARCH_FAMILY_ORDER_REASON: Readonly<Record<string, string>> = {
  "mvp:amazon_opensearch_query": `${EDITOR_INDEX_MAP} — it stores \`expression\`/\`sort\` last, where the class declares them mid-schema`,
  "mvp:elasticsearch_query": `${EDITOR_INDEX_MAP} — it stores \`expression\`/\`sort\` last, where the class declares them mid-schema`,
  "mvp:amazon_opensearch_request": EDITOR_INDEX_MAP,
  "mvp:elasticsearch_request": EDITOR_INDEX_MAP,
  "mvp:amazon_opensearch_document": EDITOR_INDEX_MAP,
  "mvp:elasticsearch_document": EDITOR_INDEX_MAP,
};

const UNREASONED_SEARCH_FAMILY = Object.keys(SEARCH_FAMILY).filter(
  (name) => SEARCH_FAMILY_ORDER_REASON[name] === undefined,
);
if (UNREASONED_SEARCH_FAMILY.length > 0) {
  throw new Error(
    `SEARCH_FAMILY_ORDER_REASON is missing ${UNREASONED_SEARCH_FAMILY.join(", ")} — ` +
      "every asserted order carries its own evidence, and the audit has no generic fallback",
  );
}

export const ORDER_ASSERTED: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ADJUDICATED_ORDER),
  ...Object.keys(SEARCH_FAMILY).map(
    (name) => [name, SEARCH_FAMILY_ORDER_REASON[name]!] as [string, string],
  ),
]);
