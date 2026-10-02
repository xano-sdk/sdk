# Security policy

## Reporting a vulnerability

Report it privately, not in a public issue:

**[Open a private security advisory](https://github.com/xanots/sdk/security/advisories/new)**

Include what you found, how to reproduce it, and what an attacker could do with
it. A proof of concept helps; a redacted one is fine.

We will acknowledge the report and keep you updated as we work through it. We
are a small team and do not promise a fixed response window — if you have not
heard anything after a week, please ping the advisory thread.

Please give us a chance to ship a fix before disclosing publicly. We will credit
you in the release notes unless you would rather we did not.

## Supported versions

Only the latest published `@xano/sdk` release receives fixes. There are no
maintained release branches — upgrade to the newest version to pick up security
patches.

## Scope

This policy covers the `@xano/sdk` package and this repository, including the
`xanosdk` CLI and the credentials it stores locally.

Vulnerabilities in the Xano platform itself are out of scope here — report those
through Xano's own security channels.

## Handling your own credentials

The CLI stores an authentication token on your machine and reads deploy
credentials from your environment. When sharing logs on an issue, redact tokens
and instance URLs. `XANOSDK_DEBUG=1` prints raw server responses, which can
include values you would not want in a public thread.
