# Notional

Notional is a maintained fork of the abandoned Nobsidion plugin for syncing
Obsidian notes with Notion pages.

The goal is a functional, usable, two-way sync tool that keeps Obsidian and
Notion aligned without surprising overwrites — backed by timestamp-based
conflict detection.

## Features

- **Sync side panel** — a dockable panel (ribbon icon or the `Open sync panel`
  command) showing the active note's connection status, link state, last-synced
  time, and whether each side has changed, with one-click Sync / Push / Pull,
  explicit conflict resolution, and a rolling activity log.
- Upload the current Obsidian note to Notion.
- Upload the entire vault to Notion with bounded parallelism.
- Create Notion pages for linked Obsidian notes when needed.
- Convert Obsidian wiki-links into Notion internal page mentions.
- Upload content with nested blocks deeper than Notion's two-level append
  request limit.
- Pull the current Notion page back into the linked Obsidian note.
- Sync the current note in the direction implied by stored sync timestamps.
- Stop before overwriting when both Notion and Obsidian changed since the last
  recorded sync.
- Optional automatic sync (experimental): push a linked note shortly after you
  edit it and periodically pull the open note, with conflicts deferred to the
  panel.

## Status

`1.1.9` is the current release line (see [Installation](#installation)).
Obsidian-to-Notion upload is the most mature path; the Notion-to-Obsidian
pull/sync direction works but is conservative, and automatic sync is opt-in and
experimental. Read [Current Limitations](#current-limitations) and test on
throwaway notes before trusting it with important ones.

## Quick start

1. **Install** via BRAT (`bryanbans/Notional`, betas enabled) or by dropping the
   release assets into your vault — see [Installation](#installation).
2. **Connect Notion** in the plugin settings: paste your connection token and
   click *Test*, share a Notion page with the connection, then paste that page's
   link and click *Create* — see [Setup](#setup).
3. **Sync a note**: open the sync panel (the **sync** ribbon icon) and click
   **Push**.

## Installation

Notional is not yet in the Obsidian community plugin store. Install it one of
two ways:

**Via BRAT (recommended — handles updates)**

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT, choose *Add Beta Plugin*, enter `bryanbans/Notional`, and allow
   pre-releases so you receive betas.
3. Enable **Notional** under *Community Plugins*.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](https://github.com/bryanbans/Notional/releases).
2. Copy them into `<vault>/.obsidian/plugins/notional/`.
3. Reload Obsidian and enable **Notional** under *Community Plugins*.

After enabling, open the plugin settings and follow the [Setup](#setup) steps.

## Sync panel

Click the **sync** ribbon icon (or run `Open sync panel`) to dock the panel in
the right sidebar. It always reflects the active note and lets you:

- See connection status and whether the note is linked to a Notion page.
- See last-synced time and whether the local file and/or Notion page changed.
- **Sync** (safe, direction inferred from timestamps), **Push** (overwrite the
  Notion page), or **Pull** (update the note, stops on conflict).
- Resolve conflicts explicitly with **Keep local → Notion** or
  **Keep Notion → local**.
- Review a rolling log of recent sync activity.

## Commands

Use Obsidian's command palette:

- `Upload current note to Notion`
- `Upload entire vault to Notion`
- `Pull current note from Notion`
- `Sync current note with Notion`
- `Open sync panel`

## Setup

Open **Settings → Notional** and follow the two steps:

1. **Connect to Notion.** Create a connection at
   [notion.so/my-integrations](https://www.notion.so/my-integrations) (choose
   *Access token*), paste its secret into **Notion API token**, and click
   **Test** to confirm it works. Then open the Notion page you want to use and
   share it with the connection (*••• → Connections*).
2. **Choose where your notes go.** Paste the link of that shared page into
   **Notion parent page link** and click **Create**. Notional creates a
   database there and remembers it — no hunting for a database ID.

Other settings:

- **Automatic sync (experimental)** — off by default. When on, a linked note is
  pushed to Notion a few seconds after you stop editing it, and the open note is
  periodically pulled. Conflicts are never auto-resolved — they surface in the
  sync panel. **Poll interval (minutes)** controls how often the open note is
  checked for Notion-side changes.
- **Banner URL** — image URL used as a page banner.
- **Notion Workspace ID** — formats share links as
  `https://<workspace>.notion.site/`.
- **Convert tags** — copy Obsidian tags into a Notion `Tags` column.
- **Advanced → Database ID** — set manually to use an existing database instead
  of creating one.

## Sync Metadata

Notional stores Notion sync metadata in each note's YAML front matter:

```yaml
notionPageId: ...
notionPageUrl: ...
notionLastEditedTime: ...
obsidianLastSyncedAt: ...
```

These fields let the plugin decide whether a Notion page changed, whether the
local Obsidian file changed, and whether a pull or push would risk overwriting
work.

## Current Limitations

- Notion-to-Obsidian conversion covers common blocks (paragraphs, headings,
  lists, todos, quotes, code, dividers, images, tables, callouts, toggles,
  equations, and media links). Anything else is flagged, not dropped (see
  below).
- Automatic sync is opt-in and scoped to the note you're working on (push on
  edit, periodic pull of the open note); it is not a full continuous
  whole-vault sync.
- Conflict resolution is a "keep one side" choice (push or force-pull); there is
  no line-level merge UI.
- Notion blocks outside the supported subset are not converted, but they are
  **not dropped silently**: each is replaced with a `> [!missing]` callout that
  preserves any text and media URL, so you can see what didn't round-trip.

## Roadmap

Recently landed:

- Parallel vault upload, deep block nesting, and wiki-link → Notion page
  mentions.
- Two-way sync foundation: pull/sync commands with timestamp conflict detection.
- Sync side panel with one-click actions and explicit conflict resolution.
- Guided setup: a *Test connection* button and auto-created notes database, so
  you never copy a database ID by hand.
- Wider Notion → Obsidian block coverage (tables, callouts, toggles, images,
  equations, media), with unsupported blocks flagged instead of dropped.
- Rate-limit/transient-error retry with backoff on all Notion requests.
- Automatic sync (experimental, opt-in): push on edit + periodic pull of the
  open note, deferring conflicts to the panel.

Planned, roughly in priority order:

- [ ] **One-click OAuth ("Connect to Notion")** — authorize in the browser and
      pick pages with Notion's own picker, removing the token / sharing steps
      entirely. Needs a small hosted token-exchange endpoint.
- [ ] **Whole-vault background sync** — extend auto-sync beyond the open note to
      all linked notes, safely and within rate limits.
- [ ] A dedicated sync-state store instead of ad hoc front-matter fields.
- [ ] Submit to the Obsidian community plugin store after a guideline audit.

Have a request? Open an issue on
[GitHub](https://github.com/bryanbans/Notional/issues).

## Development

Requires Node.js (the CI builds on Node 20). Install dependencies and run the
checks:

```bash
npm install
npm run build
npm run lint
npm test
```

The build outputs `main.js`; releases bundle `main.js`, `manifest.json`, and
`styles.css`. Tagging a commit whose name matches the `manifest.json` version
(no `v` prefix) triggers the release workflow, which drafts a GitHub release
with those assets.

## Acknowledgements

This project is a fork of
[Obsidian to Notion](https://github.com/EasyChris/obsidian-to-notion/) by
[EasyChris](https://github.com/EasyChris), with additional work from the
original Nobsidion fork by Quan Phan.

## License

Notional is released under the [GNU General Public License v3.0](LICENSE).
