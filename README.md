# Rootr Sync (for Obsidian)

**Keep working in Obsidian, exactly as you do today.** Rootr Sync pushes just
the folder (or tagged notes) your team needs to collaborate on — or wants to
feed to Claude/ChatGPT — into your team's [Rootr](https://rootr.io)
workspace. Everything else in your vault stays local and private, untouched.

## Privacy, up front

- **Only the scope you configure ever leaves your machine.** The plugin sends
  Rootr nothing but the notes inside the single folder path and/or tag you
  type into its settings. To work out *which* notes those are, it does what
  any Obsidian plugin must do locally: it asks Obsidian for the vault's
  markdown file list and, if you set a tag filter, reads Obsidian's own
  in-memory metadata cache for those files. That matching happens entirely on
  your machine — the contents of out-of-scope notes are never read from disk
  and never transmitted.
- **Nothing is sent in the background, except when you say so.** Data leaves
  your machine only when you run the **"Rootr Sync: Push selected folder now"**
  command yourself, or — if you've explicitly turned on **auto-sync on
  save** — when you save a file that's inside the folder/tag you configured.
  There is no polling, no scheduled sync, and no sync of anything outside
  that scope.
- **Rootr does not use this content to train AI models.** Content pushed by
  this plugin is stored in your team's Rootr workspace for your team's own
  use (including your own use of Claude/ChatGPT against it, if you choose)
  and is not used by Rootr to train any AI model.
- **This plugin ships with zero telemetry.** No analytics, no usage
  tracking, no crash reporting, no phone-home of any kind — as required for
  Obsidian community plugin review.
- **Your API key stays on your machine, in plain text.** Obsidian plugins have
  no OS keychain access, so the key you paste is stored unencrypted in
  `.obsidian/plugins/rootr-sync/data.json` inside your vault — the same place
  every other Obsidian plugin keeps its settings. Keep that in mind if your
  vault is itself synced or backed up somewhere shared, and prefer a
  workspace-scoped key you can revoke.
- **Privacy policy and terms.** Data pushed by this plugin is handled under
  Rootr's [privacy policy](https://rootr.io/legal/privacy) and
  [terms of service](https://rootr.io/legal/terms).
- **Deleting synced data.** You can delete a synced document or folder
  directly in Rootr at any time. To fully cut off this plugin's access,
  revoke its API key in Rootr under **Settings → Integrations** — once
  revoked, no further reads or writes are possible with that key.

## What this plugin does

- **One-directional sync only (v1): vault → Rootr.** Rootr never writes back
  into your vault. Your local notes are always the source of truth.
- Preserves your folder structure 1:1 — a file at
  `Team/Project/notes/idea.md` in your vault becomes
  `/Team/Project/notes/idea.md` in Rootr.
- Only touches the folder and/or tag you configure. Every other note in your
  vault is left completely alone.
- Writes are conflict-safe. Before each write the plugin re-reads the document
  from Rootr and compares it against what it left there last time. If someone
  changed it in Rootr in the meantime, the push is refused and the file is
  listed as a **conflict** in the status panel — never force-overwritten. The
  write itself additionally carries an `If-Match` ETag so a simultaneous edit
  is rejected server-side (HTTP 412) too.
- The plugin also refuses to overwrite a document that already exists at the
  target path but was never pushed by this plugin — rename or remove it in
  Rootr first. That way a first-time push can't silently replace someone
  else's work.

## What you need

A Rootr account and a workspace you can write to (rootr.io — the free plan is
enough to try this; paid plans exist for larger teams and storage). This
plugin is a client for that service; it does nothing on its own.

## Setup

1. In Rootr, go to **Settings → Integrations** and create an API key with
   `docs:read` and `docs:write` scopes for the workspace you want to sync
   into.
2. In Obsidian, open **Settings → Rootr Sync** and fill in:
   - **Rootr base URL** (defaults to `https://rootr.io/api/v1`)
   - **API key** (the key from step 1)
   - **Workspace ID**
   - **Folder to sync** and/or **Tag to sync** — at least one is required
   - **Auto-sync on save** (optional, off by default)
3. Run the command **"Rootr Sync: Push selected folder now"** (via the command
   palette) to do your first push, or just save a matching file if
   auto-sync is on.
4. Check the **Status** section at the bottom of the settings tab for the
   last sync time, how many files pushed successfully, and any
   failed/conflicted files.

## v1 limitations

- **One-directional only.** Changes made in Rootr are not pulled back into
  Obsidian. If you need bidirectional sync, that's on the roadmap for a
  future version, not v1.
- **No wikilink conversion yet.** `[[Obsidian wikilinks]]` are pushed as
  literal markdown text; they are not rewritten into Rootr-native links in
  v1.
- **Folder/tag scoping is coarse.** v1 supports a single folder path and a
  single tag filter (used as OR, if both are set) — no nested include/
  exclude rules yet.
- **Renames and deletions are not propagated.** Renaming or deleting a note
  locally leaves the previously pushed copy in Rootr; remove it there by hand.
- **Conflicts must be resolved manually.** On a conflict, re-run the push
  after reconciling — there's no merge UI in v1.

## Development

```bash
npm install
npm run typecheck   # type-check only, no output file
npm run build        # type-check + produce main.js via esbuild
```

`main.js` is a build artifact and is intentionally **not** committed to this
repository — for community plugin distribution it is built and attached to
a GitHub release, per Obsidian's submission requirements.

## Who maintains this

Rootr Sync is built and maintained by **Inspirio Inc.**, the team behind
[Rootr](https://rootr.io). This repository hosts the plugin distribution for
the Obsidian community directory; issues and pull requests here are handled by
the same team.

- Product: https://rootr.io
- Privacy policy: https://rootr.io/en/legal/privacy
- Contact: info@inspirio.co
