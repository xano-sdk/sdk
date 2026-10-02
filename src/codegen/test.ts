/**
 * Decode a stored `test[]` and a stored `example` back into source.
 *
 * Neither is a deliberate omission. They are authored artefacts — someone wrote
 * them in the editor — so a pull that leaves them behind loses work, and a
 * `deploy` from that tree removes them from the target.
 *
 * ## What is still withheld
 *
 * A test's `token` is an auth credential with an expiry, not authored
 * configuration. It is decoded to nothing and reported through the same
 * `expected-omission` channel that used to carry the whole test, so the loss
 * stays visible rather than becoming silent.
 */
import type { TaggedValue } from "../types/xdo.js";
import type { DefEntry, KindDecodeArgs } from "./kinds/index.js";
import type { Expr } from "./print.js";
import { arr, call, lit, obj } from "./print.js";
import { decodeValue, describeStored } from "./value.js";
import { SDK_MODULE, type DecodeContext } from "./context.js";
import { TEST_EXPECT_TYPES } from "../values/expect.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A stored tagged value, coerced to the shape the value decoder wants.
 *
 * The corpus is inconsistent about whether an int/decimal `value` serializes as
 * a number or a string — the same coercion `normalize` applies for the same
 * reason — so a numeric one is stringified rather than refused.
 */
function tagged(v: unknown): TaggedValue | null {
  if (!isRecord(v) || typeof v.tag !== "string") return null;
  const value = typeof v.value === "number" ? String(v.value) : v.value;
  if (typeof value !== "string") return null;
  return { tag: v.tag, value, filters: Array.isArray(v.filters) ? v.filters : [] } as TaggedValue;
}

/** The `input` record of one test: `{ name: <value> }`. */
function testInputs(ctx: DecodeContext, stored: unknown): Expr | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const entries: Array<readonly [string, Expr]> = [];
  for (const raw of stored) {
    const value = isRecord(raw) && typeof raw.name === "string" ? tagged(raw) : null;
    if (!value) {
      // One unreadable binding costs the WHOLE map — an input record cannot be
      // written half-way — so say so rather than emitting a test that quietly
      // runs with no inputs at all.
      ctx.problem(
        "value-fallback",
        `a test input binding is not a readable tagged value (${describeStored(raw)}); ` +
          `the test's whole \`input\` map is emitted verbatim`,
      );
      return lit(stored);
    }
    entries.push([raw.name as string, decodeValue(ctx, value)]);
  }
  return obj(entries);
}

/**
 * One assertion back to its `expect.*` call.
 *
 * An unrecognised `type` is carried as a plain literal rather than throwing: a
 * newer engine matcher should degrade to a verbatim record that still
 * round-trips, not break the pull outright.
 */
function assertion(ctx: DecodeContext, stored: unknown): Expr {
  const known =
    isRecord(stored) &&
    typeof stored.type === "string" &&
    (TEST_EXPECT_TYPES as readonly string[]).includes(stored.type) &&
    Array.isArray(stored.vars) &&
    stored.vars.every(isTaggedish);
  if (!known) {
    ctx.problem(
      "value-fallback",
      `a test assertion of type ${JSON.stringify(
        isRecord(stored) ? stored.type : stored,
      )} has no \`expect.*\` form; emitted verbatim`,
    );
    return lit(stored);
  }
  const rec = stored as { type: string; vars: unknown[] };
  // `to_throw` fills its own response slot, so only the exception is authored —
  // but only when the stored shape actually HAS that slot. A single-var
  // `to_throw` would otherwise re-encode with two and fail its round trip.
  if (rec.type === "to_throw" && rec.vars.length !== 2) {
    ctx.problem(
      "value-fallback",
      `a to_throw assertion stores ${rec.vars.length} vars where the authoring surface ` +
        `writes two (the response slot and the expected message); emitted verbatim`,
    );
    return lit(stored);
  }
  ctx.use(SDK_MODULE, "expect");
  const args = rec.type === "to_throw" ? rec.vars.slice(1) : rec.vars;
  return call(
    `expect.${rec.type}`,
    ...args.map((v) => decodeValue(ctx, tagged(v)!)),
  );
}

function isTaggedish(v: unknown): boolean {
  return tagged(v) !== null;
}

/** `tests: [...]` for a kind that carries `test[]`, or null when there are none. */
export function decodeTests(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored["test"];
  if (!Array.isArray(stored) || stored.length === 0) return null;

  const items: Expr[] = [];
  for (const raw of stored) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      a.ctx.problem("value-fallback", "a stored test has no `name`; emitted verbatim");
      items.push(lit(raw));
      continue;
    }
    const entries: Array<readonly [string, Expr]> = [["name", lit(raw.name)]];

    // ALWAYS emit the stored id. Xano mints a random one for an editor-created
    // test, which no name derivation reproduces — and emitting it only when it
    // differs would leave the reader unable to tell the two cases apart.
    if (typeof raw.id === "string" && raw.id !== "") entries.push(["id", lit(raw.id)]);
    if (typeof raw.description === "string" && raw.description !== "") {
      entries.push(["description", lit(raw.description)]);
    }
    if (typeof raw.datasource === "string" && raw.datasource !== "") {
      entries.push(["datasource", lit(raw.datasource)]);
    }
    const inputs = testInputs(a.ctx, raw.input);
    if (inputs) entries.push(["input", inputs]);
    if (Array.isArray(raw.expect) && raw.expect.length > 0) {
      entries.push(["expect", arr(raw.expect.map((e) => assertion(a.ctx, e)))]);
    }
    if (typeof raw.token === "string" && raw.token !== "") {
      a.ctx.problem(
        "expected-omission",
        `test "${raw.name}" stores an auth \`token\`. A token is an expiring ` +
          `credential rather than authored configuration, so it is deliberately ` +
          `not written into a committed tree (user data)`,
      );
    }
    items.push(obj(entries));
  }
  return ["tests", arr(items)];
}

/**
 * `example: {...}` — the saved request/response sample, carried verbatim.
 *
 * Emitted by default, deliberately. It is recorded rather than typed, so it is
 * user data; dropping an authored artefact silently is the failure this whole
 * change exists to fix, and a flag to spare the handful of objects that carry
 * one would cost more to explain than it saves.
 */
export function decodeExample(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored["example"];
  if (!isRecord(stored)) return null;
  // Verbatim, not rebuilt from the two halves. `normalize` copies `example`
  // through opaquely, so a stored `output: null` beside a populated `input` is
  // a real byte difference — reconstructing only the non-null halves dropped it
  // and made the object fail its own round trip.
  // A half holding null is the same state as an absent one (the engine stores
  // absence), so it is dropped rather than written back as an authored null
  // that would not survive its own re-export.
  const live = Object.fromEntries(Object.entries(stored).filter(([, half]) => half !== null));
  if (Object.keys(live).length === 0) return null;
  return ["example", lit(live)];
}
