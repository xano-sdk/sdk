/**
 * The one live-datasource warning, shared by every surface that runs against a
 * datasource the engine CLONES first: standalone workflow tests and the saved
 * unit tests on a query/function/middleware.
 *
 * Running either clones the named datasource before the run. Against
 * production-sized data that is slow enough to fail the run outright, so `""`
 * (an EMPTY datasource — what the Xano UI labels "empty (recommended)") is the
 * only default worth having.
 */
/** Whether `datasource` names the live one — the check `checkLiveDatasourceTests` makes. */
export function isLiveDatasource(datasource: string): boolean {
  return datasource.trim().toLowerCase() === "live";
}

/** The live-datasource warning text, naming the offender as `subject`. */
export function liveDatasourceMessage(subject: string): string {
  return (
    `${subject} runs against the "live" datasource. ` +
    `Running a test CLONES its datasource first — against production-sized data ` +
    `this is slow enough to fail the run. Prefer \`datasource: ""\` (an empty ` +
    `datasource, the recommended default) or a small fixture datasource.`
  );
}
