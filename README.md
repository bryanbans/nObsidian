# nObsidian

nObsidian is a maintained fork of the abandoned Nobsidion plugin for syncing
Obsidian notes with Notion pages.

The current goal is a functional, usable sync tool that can keep Obsidian and
Notion aligned without surprising overwrites. Obsidian-to-Notion upload is the
most mature path today; Notion-to-Obsidian sync now exists as an experimental
foundation with timestamp-based conflict checks.

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

## Settings

Required:

- `Notion API Token`
- `Database ID`

Optional:

- `Banner URL`
- `Notion Workspace ID`
- `Convert tags`
- `Bidirectional sync (experimental)`

## Sync Metadata

nObsidian stores Notion sync metadata in each note's YAML front matter:

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

- Notion-to-Obsidian conversion supports a conservative block subset:
  paragraphs, headings, bullets, numbered lists, todos, quotes, code blocks,
  and dividers.
- Automatic background sync is not enabled yet. Syncing is driven from the sync
  panel or the command palette.
- Conflict resolution is a "keep one side" choice (push or force-pull); there is
  no line-level merge UI.
- Notion blocks outside the supported subset are skipped during pull.

## Development

Install dependencies and run checks:

```powershell
$env:Path = "C:\Users\Bryan\AppData\Local\nvm\v24.17.0;" + $env:Path
npm.cmd run build
npm.cmd run lint
npm.cmd test
```

## Acknowledgements

This project is a fork of
[Obsidian to Notion](https://github.com/EasyChris/obsidian-to-notion/) by
[EasyChris](https://github.com/EasyChris), with additional work from the
original Nobsidion fork by Quan Phan.

## License

nObsidian is released under the [GNU General Public License v3.0](LICENSE).
