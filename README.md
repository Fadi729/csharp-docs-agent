# C# Docs

Ask quick C# and .NET documentation questions from Raycast, with follow-ups in the same conversation.

The answer streams into the view as the agent writes it. Press `⌘N` to ask a follow-up once the first answer finishes — follow-ups resume the same session, so you can say "and with LINQ?" without restating context.

Questions that aren't about C# or .NET are declined.

## Requirements

The [Cursor CLI](https://cursor.com/cli) must be installed and signed in:

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

The extension looks for the `agent` binary in `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`, and uses whatever credentials the CLI has already stored. There is nothing to configure in Raycast.

## Development

```bash
npm install
npm run dev
```

`npm run lint` checks the manifest and formatting; `npm run fix-lint` fixes what it can.

## How it works

The command spawns the Cursor CLI in `ask` mode with `--output-format stream-json`, parses the NDJSON event stream line by line, and renders assistant text deltas into a `Detail` view. The agent runs in an empty extension-owned scratch directory so that `--trust` can't reach into your home folder for a question that never needs the filesystem.
