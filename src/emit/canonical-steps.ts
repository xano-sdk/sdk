/**
 * The order in which deploys can move public URL slugs between this
 * environment's own objects — a swap (two objects trading slugs) or a chain
 * (one object takes the slug another is leaving).
 *
 * One import checks every pinned slug against what the environment serves when
 * it starts: a slug another object holds is refused even when the same import
 * moves that object off it. So a slug changes hands only in the deploy AFTER
 * its holder left it, and a swap needs one object parked on a slug nobody
 * holds first. Each step here is one ordinary deploy of the project with some
 * canonicals set to something other than declared; the last is the project as
 * declared.
 */

/** One object whose served slug the project changes. */
export interface SlugMove {
  /** The SDK kind (`apiGroup`, `mcpServer`, …) and name the prose uses. */
  kind: string;
  name: string;
  guid: string;
  /** The slug it serves now; `undefined` for an object the environment does not hold yet. */
  from: string | undefined;
  /** The slug the project declares for it. */
  to: string;
}

/** A canonical a step sets other than as declared, and why. */
export interface SlugOverride {
  kind: string;
  name: string;
  slug: string;
  /** The slug the project declares for it — where it goes once a later step no longer sets it. */
  declared: string;
  /** `park`: a slug nobody holds, to free the one it has. `stay`: where it is now, until its slug is free. */
  why: "park" | "stay";
}

/** One deploy: the canonicals it sets other than as declared (none for the last). */
export type SlugStep = readonly SlugOverride[];

/**
 * The deploys that land every move, or `undefined` when no order lands them
 * (a slug held by something that is not moving off it).
 *
 * @param moves every object whose declared slug differs from the one it serves now
 * @param held every slug the environment serves now, to the guid serving it
 */
export function slugMoveSteps(moves: readonly SlugMove[], held: ReadonlyMap<string, string>): SlugStep[] | undefined {
  const at = new Map(moves.map((m) => [m.guid, m.from] as const));
  const owner = new Map(held);
  const taken = new Set([...held.keys(), ...moves.map((m) => m.to)]);
  const steps: SlugStep[] = [];
  for (let round = 0; round <= moves.length + 1; round++) {
    const pending = moves.filter((m) => at.get(m.guid) !== m.to);
    const blocked = pending.filter((m) => {
      const holder = owner.get(m.to);
      return holder !== undefined && holder !== m.guid;
    });
    if (blocked.length === 0) {
      steps.push([]);
      return steps;
    }
    // Held by an object that is not moving off it: no order frees it.
    if (blocked.some((m) => !pending.some((p) => p.guid === owner.get(m.to)))) return undefined;
    const wants = new Map(blocked.map((m) => [m.guid, m.to] as const));
    // A cycle: following "the slug I want is held by" from a blocked object
    // comes back to it. One member of each is parked, which breaks it.
    const parked = new Set<string>();
    for (const m of blocked) {
      const seen: string[] = [];
      let cur: string | undefined = m.guid;
      while (cur !== undefined && wants.has(cur) && !seen.includes(cur)) {
        seen.push(cur);
        cur = owner.get(wants.get(cur)!);
      }
      if (cur === undefined || !seen.includes(cur)) continue;
      const cycle = seen.slice(seen.indexOf(cur));
      if (!cycle.some((g) => parked.has(g))) parked.add(cycle[0]!);
    }
    const blockedGuids = new Set(wants.keys());
    const step: SlugOverride[] = [];
    const next = new Map<string, string | undefined>();
    for (const m of pending) {
      if (!blockedGuids.has(m.guid)) {
        next.set(m.guid, m.to);
        continue;
      }
      const here = at.get(m.guid);
      if (parked.has(m.guid) || here === undefined) {
        const slug = freeSlug(here ?? m.to, taken);
        taken.add(slug);
        step.push({ kind: m.kind, name: m.name, slug, declared: m.to, why: "park" });
        next.set(m.guid, slug);
      } else {
        step.push({ kind: m.kind, name: m.name, slug: here, declared: m.to, why: "stay" });
      }
    }
    for (const [guid, slug] of next) {
      const before = at.get(guid);
      if (before !== undefined && owner.get(before) === guid) owner.delete(before);
      if (slug !== undefined) owner.set(slug, guid);
      at.set(guid, slug);
    }
    steps.push(step);
  }
  return undefined;
}

/** `<slug>-tmp`, numbered past any slug already in use. */
function freeSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const slug = n === 1 ? `${base}-tmp` : `${base}-tmp${n}`;
    if (!taken.has(slug)) return slug;
  }
}

/**
 * The steps as numbered lines, each ending in the deploy to run. Each names the
 * whole set of canonicals to have in code for that deploy: what it sets other
 * than declared, what goes back to its declared slug since the step before
 * (said with that slug, since the code still holds the previous step's value),
 * and every other canonical as declared — read literally, no step is a no-op.
 */
export function renderSlugSteps(steps: readonly SlugStep[], rerun: string, indent = "  "): string[] {
  const id = (o: SlugOverride) => `${o.kind}\0${o.name}`;
  return steps.map((step, i) => {
    const here = new Set(step.map(id));
    const set = step.map(
      (o) => `${o.kind} "${o.name}"'s canonical to "${o.slug}" (${o.why === "park" ? "a slug nobody holds" : "where it is now"})`,
    );
    const back = (i === 0 ? [] : steps[i - 1]!)
      .filter((o) => !here.has(id(o)))
      .map((o) => `${o.kind} "${o.name}"'s canonical back to "${o.declared}" (as declared)`);
    const listed = [...set, ...back];
    const what =
      listed.length === 0 ? "deploy the project as declared" : `set ${listed.join(", ")} — every other canonical as declared`;
    return `${indent}${i + 1}. ${what}, then run \`${rerun}\``;
  });
}
