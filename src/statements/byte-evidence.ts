/**
 * What byte-level evidence stands behind each statement's emitted shape.
 *
 * Every declarative statement is generated from the engine's own schema. That
 * says what the engine DECLARES; it does not prove the SDK emits what the engine
 * PERSISTS. Three things can prove the second, and all three make the same
 * comparison — `normalize()`-equal against bytes an engine actually stored:
 *
 * - **A corpus instance.** The decoder is driven from the stored form and has to
 *   re-encode it exactly, so a real workspace holding the statement proves it,
 *   usually many times over. This covers 123 of the 153 generated specs.
 * - **A captured fixture.** One persisted object, vendored and pinned.
 * - **A live round trip.** Deploy the statement, read the workspace back, diff.
 *   This is what {@link PROBE_CONFIRMED} records, and it is the answer for a
 *   statement no author has ever written — where the first two have nothing to
 *   offer and never will.
 *
 * {@link UNCONFIRMED_STATEMENTS} is what remains: built from the declaration and
 * nothing else. It is EMPTY today, and the machinery is kept for the case that
 * refills it — codegen generates specs from the engine's schema, so a statement
 * the platform adds arrives here with no evidence behind it until someone goes
 * and gets some.
 */

/**
 * Statements proven by a live round trip rather than by a stored instance.
 *
 * `npx tsx scripts/probe-unconfirmed-shapes.ts` deploys these to a throwaway
 * ephemeral, exports the workspace back, and diffs each object against what was
 * authored. All 30 matched on 2026-08-24; that script carries the measured
 * output and the argument set behind it.
 *
 * This set exists to keep the CORPUS audit honest rather than to ship anything.
 * A sweep sees zero instances of every name here and will keep seeing zero until
 * an author writes one, so without this record `audit:decode-coverage` would
 * report all 30 as missing evidence at every run, forever. Read it as the same
 * kind of thing as `ADJUDICATED_ORDER` in the drift audit: a suppression that
 * carries its reason.
 *
 * **A live round trip proves the SHAPE that was authored**, exactly as a fixture
 * does. A field the probe left absent is still unexercised — widen the probe
 * rather than the claim.
 */
export const PROBE_CONFIRMED: ReadonlySet<string> = new Set([
  // The set-operation half of the array family. The rest of the family is
  // covered many times over by the corpus.
  "mvp:array_difference",
  "mvp:array_group_by",
  "mvp:array_intersection",
  "mvp:array_partition",
  // Third-party connectors, each of which needs an account wired up before a
  // workspace would store one — which is why the corpus has none.
  "mvp:connect_webflow_api_request",
  "mvp:datadog_log",
  "mvp:datadog_log_bulk",
  "mvp:datadog_metric",
  "mvp:datadog_metric_bulk",
  "mvp:mcp_list_tools",
  "mvp:mcp_server_details",
  "mvp:get_session",
  // The assertion family. Test objects export like any other and the corpus
  // holds six of them, but all six are EMPTY — so this was an authoring gap
  // upstream, not a gap in what an export carries.
  "mvp:test_expect_to_be_defined",
  "mvp:test_expect_to_be_empty",
  "mvp:test_expect_to_be_false",
  "mvp:test_expect_to_be_greater_than",
  "mvp:test_expect_to_be_in_the_future",
  "mvp:test_expect_to_be_in_the_past",
  "mvp:test_expect_to_be_less_than",
  "mvp:test_expect_to_be_null",
  "mvp:test_expect_to_be_true",
  "mvp:test_expect_to_be_within",
  "mvp:test_expect_to_contain",
  "mvp:test_expect_to_end_with",
  "mvp:test_expect_to_equal",
  "mvp:test_expect_to_match",
  "mvp:test_expect_to_not_be_defined",
  "mvp:test_expect_to_not_be_null",
  "mvp:test_expect_to_not_equal",
  "mvp:test_expect_to_start_with",
]);

/**
 * Statements with no byte-level evidence of any kind behind them.
 *
 * Empty today: the 30 that were here are in {@link PROBE_CONFIRMED}, and the
 * other 123 are covered by the corpus. What refills it is a statement the
 * platform ADDS — codegen generates a spec for it from the engine's schema, and
 * until someone deploys or captures one, the emitted shape is a reading of the
 * declaration and nothing more.
 *
 * Keyed by stored `mvp:` name. When non-empty, the manifest publishes these as
 * `s.` paths under `coverage.statements.unconfirmed` — as `s.` paths, because an
 * agent looks a statement up by the path it writes. When empty the key is
 * omitted entirely rather than shipped as an empty list: there is nothing to
 * say, and a warning channel that is always present teaches a reader to skip it.
 *
 * What a name here does NOT mean:
 *
 * - **Not withheld.** Every statement stays fully authorable and fully offered,
 *   which is the whole difference from `superseded.ts` and `decode-only.ts`.
 *   There is no alternative statement to reach for, so this cannot be a gotcha.
 * - **Not a claim about the hand-authored wrappers.** They carry no generated
 *   spec, so the measurement behind this does not describe them.
 *
 * **Refreshing:** `npm run audit:decode-coverage -- <sweep-dir>` after a corpus
 * sweep. It subtracts {@link PROBE_CONFIRMED} and reports both directions of any
 * remaining disagreement, so the two cannot drift apart silently. The exported
 * workspace population moves between runs — confirm a change against a second
 * sweep, because one absent workspace is not evidence of absence.
 */
export const UNCONFIRMED_STATEMENTS: ReadonlySet<string> = new Set([]);

/**
 * The reader-facing gloss shipped beside the list in `manifest.json`.
 *
 * It lives here rather than in the renderer so the list and its meaning cannot
 * be changed apart from each other, and it stays defined while the list is empty
 * so the shipped wording is reviewed once rather than written in a hurry by
 * whoever next has something to put in the list.
 */
export const UNCONFIRMED_NOTE =
  "Built from the engine's schema declaration, with no stored instance behind " +
  "them to compare the emitted bytes against — every other statement has one. " +
  "Fully authorable and not deprecated; the field schema may simply be less " +
  "exact than the rest. If a deploy rejects one of these, read it as a shape " +
  "question and pull the workspace back to see what the engine stored, rather " +
  "than rewriting working code around it.";
