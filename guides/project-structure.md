# Project structure

How a Xano SDK project is laid out on disk, and why registration is explicit.

Lay objects out however you like and register them explicitly — there's no folder
auto-discovery magic (deliberately):

```
xano/
├── function/     get_user.ts         export const getUser = defineFunction({...})
├── table/        table.ts            export const user = table({...})
│   └── trigger/  on_insert.ts        export const onInsert = tableTrigger({...})
├── query/        public.ts           export const publicApi = apiGroup({...})
│                 public/posts_GET.ts export const posts = query({...})
├── agent/        assistant.ts        export const assistant = agent({...})
├── realtime_server/ chat.ts               export const chat = realtimeServer({...})
│                 chat/room.ts              export const room = realtimeChannel({...})
│                 chat/room/send.ts         export const send = realtimeMessage({...})
├── workspace.ts                      export const workspaceSettings = workspaceConfig({...})
└── index.ts      workspace("my-app").registerTables([...]).registerFunctions([...])…
```

Objects nest under whatever owns them. Anything with children — an API group, a
realtime server, a channel — is a file named for itself sitting *beside* the folder
holding its children, so `chat.ts` opens in a tab you can tell apart and a group with
no queries needs no folder at all. Realtime is the deepest, being the only three-level
hierarchy in a workspace — server, then channel, then message — and a trigger sits in
a `trigger/` folder at whichever level it fires on.

Paths are lower case throughout — an HTTP verb is the one exception, because it is
the method rather than a word. Bindings keep the object's own casing, so a file name
and the symbol it exports can differ.

That is the shape `xanosdk init --from` writes, and its `index.ts` re-exports every object
by name — import from the tree's root rather than from a file, since a file path moves
when an object's parent or its `_shared.ts` placement changes. Hand-authored projects are
free to use any other layout; only `index.ts` registering the objects matters.

`workspace("my-app")` is the natural entry point — sugar for
`new Xano().registerWorkspace({ name: "my-app" })`, returning the same chainable registry.
Authoring is **declarative def-objects** passed to factories; there is no callback/chaining
builder. `xano.export()` returns the importable `packageExport` bundle, and
`xanosdk export`/`deploy` read the module's default export.
