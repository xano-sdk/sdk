/**
 * A `lam.file` body: one default-exported function whose first parameter
 * destructures the bindings for its surface.
 *
 * A body earns its own module once it has real structure — the author's own
 * tsconfig type-checks it, their editor navigates it, and the file is read as
 * TEXT at build time, so what the engine runs is exactly what is written here.
 */
import type { LambdaBindings } from "@xano/sdk";

export default ({ $result, $this }: LambdaBindings<"reduce">) => {
  const line = $this.qty * $this.price;
  const discount = $this.qty >= 10 ? 0.1 : 0;
  return $result + line * (1 - discount);
};
