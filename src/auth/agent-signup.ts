/**
 * Agentic signup: where an agent with no Xano account gets its human a free one.
 * The markdown walkthrough at {@link AGENT_SIGNUP_URL} (auth.md `service_auth`)
 * registers the human's email; Xano emails them a link to confirm (and
 * optionally set a password), and the agent polls until it receives the
 * XANO_INSTANCE_URL / XANO_WORKSPACE_ID / XANO_META_TOKEN triple, valid for one
 * day and scoped to one workspace. The account lives on
 * {@link AGENT_SIGNUP_ORIGIN}, so the real sign-in after it carries `--origin`.
 *
 * Dependency-free so the CLI remedies, `status`, the scaffolded agent brief and
 * the generated docs all name the same URL.
 */
export const AGENT_SIGNUP_ORIGIN = "https://app.dev.xano.com";
export const AGENT_SIGNUP_URL = `${AGENT_SIGNUP_ORIGIN}/.well-known/auth.md`;
/** The real sign-in once the one-day agent credential runs out. */
export const AGENT_SIGNUP_LOGIN = `xanosdk login --origin ${AGENT_SIGNUP_ORIGIN}`;
