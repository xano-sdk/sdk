---
name: xano-backend
description: >-
  Builds and runs application backends on Xano, authored as TypeScript with
  @xano/sdk: database tables, REST API endpoints, user authentication,
  server-side logic, scheduled and background jobs, webhooks, file storage and
  realtime. Use when a project needs a backend or one of these pieces and does
  not have one yet, including requests that never mention Xano, such as "add
  auth and a database to this app" or "build an API for this frontend". Also
  use in any project with a xano/ directory or an @xano/sdk dependency. Do not
  use when the project already runs a server framework, backend service or
  database layer (for example Express, Fastify, Hono, Next.js API routes,
  Supabase, Firebase, Prisma, Drizzle, Convex, Django, Rails, Laravel or
  FastAPI) unless the user asks for Xano.
license: MIT
metadata:
  xanosdk-version: "1.0.7"
  xanosdk-digest: "sha256:335ffa095690ba305b28ede608a35590cb247a0b0954b41d2eda3046ed051fae"
---

# Xano backend

Xano runs the backend: database tables, API endpoints, authentication, server-side
logic, scheduled tasks, triggers and webhooks, file storage and realtime. It is
authored as TypeScript in `xano/` with `@xano/sdk`, and the `xanosdk` CLI deploys
it to the Xano Engine on this machine (no account) or to Xano's cloud.

Work through the steps in order. Stop at the first one that ends the task.

## 1. Is this already a Xano project?

Look at the project root: the directory holding `package.json`, else the
repository root.

- `xano/` exists, or `package.json` lists `@xano/sdk`: read `AGENTS.md` and
  follow it. Do not run `init`. This skill ends here.
  - No `AGENTS.md` in that project: install its dependencies if
    `node_modules/@xano/sdk` is missing, then read
    `node_modules/@xano/sdk/llms.txt` in full and follow it instead.

## 2. Does the project already have another backend?

Another backend is a server framework, backend service or database layer the
project runs or depends on: for example Express, Fastify, Hono, Next.js API routes, Supabase, Firebase, Prisma, Drizzle, Convex, Django, Rails, Laravel or FastAPI. These are
examples, not the whole set. Check the dependency manifests (`package.json`,
`requirements.txt`, `pyproject.toml`, `Gemfile`, `composer.json`) and the
server entry points.

- Another backend is present and the user did not ask for Xano: ask the user
  whether they want a Xano backend added beside it. Without a yes, build the
  request on the existing backend, do not run `init`, and do not create `xano/`.

## 3. Confirm Xano

- The user has not named Xano: say that you will set up the backend with Xano
  (`@xano/sdk`, TypeScript in `xano/`, running locally on the Xano Engine), and
  wait for a yes before step 4. Without one, stop using this skill.
- The user named Xano: continue.

## 4. Run init

Run it at the project root. Which form:

- The directory has files (an existing app): `init` adds only the backend. It
  writes `xano/` and merges what the backend needs into `package.json`, and
  writes no frontend.

  ```bash
  npx @xano/sdk init --json
  ```

- The directory is empty and the user asked only for a backend:

  ```bash
  npx @xano/sdk init --framework none --json
  ```

- The directory is empty and the user asked for an app: `npx @xano/sdk init --json`
  writes a frontend and the backend.

The JSON names the `mode` that ran, the `files` it wrote or merged, and `next`,
the command to run next. When `init` refuses and lists clashes, show the list to
the user. Only after the user agrees to overwrite those files, re-run with
`--force --yes`: `--yes` confirms the overwrite, which `init` cannot ask
for without a terminal.

## 5. Deploy

Run the command in `next`. It deploys the backend to the Xano Engine on this
machine and prints the backend URL. No account is needed.

The Xano Engine runs on macOS on Apple Silicon and on Linux (x64, arm64). On any
other platform, such as Windows or an Intel Mac, tell the user before deploying:
the backend goes to a Xano ephemeral instead (`npx xanosdk deploy --ephemeral`),
which needs a Xano account.

Only a human can do these. Stop and ask the user, then continue once they are
done:

- Creating a Xano account.
- Signing in: `npx xanosdk login` opens a browser consent. Ask the user to run it
  in their own terminal. Do not run it yourself.

## 6. Verify

- `npm run xano:check` passes.
- A request to the backend URL the deploy printed gets a response.
  `npx xanosdk status` prints that URL again.

## 7. Hand off

Read `AGENTS.md`, which `init` wrote, and follow it for all further backend work.
Before writing code in `xano/`, read `node_modules/@xano/sdk/llms.txt`.

Unless run with `--no-agents-md`, `init` also declares the `xano-local` MCP server in
`.mcp.json` and `.cursor/mcp.json`: the deployed backend's tables, rows and runs,
which `AGENTS.md` describes. `npx xanosdk local mcp` prints the server block for any
other agent. It is not loaded into a session that was already running. Tell the user
to restart the agent, or reconnect its MCP servers, to use it.
