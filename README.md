# Local WordPress AI Agent

An experimental, local-first AI assistant for WordPress plugin development,
support investigation, and debugging. It combines safe code inspection,
documentation memory, browser diagnostics, and an approval-based patch flow.

> This project is designed for local development. It is not a hosted support
> bot and should not be pointed at production credentials or customer data.

## What makes it useful

- inspect plugin files without exposing the whole workstation to the model
- search indexed project documentation before answering support questions
- collect browser, PHP, and WP-CLI diagnostics in one workflow
- propose patches for review before anything is applied
- use either a terminal launcher or a local web dashboard

## Goal

- Read plugin code from the local WordPress plugins directory.
- Use official documentation and indexed project memory.
- Visit the local XAMPP site in a browser.
- Inspect console errors, network errors, PHP logs, and plugin files.
- Propose fixes first, then apply edits only after approval.

## Build Steps

1. Create the project scaffold.
2. Add environment loading and a doctor command.
3. Add safe filesystem tools for plugin discovery and reading.
4. Add OpenAI Responses API integration.
5. Add code memory with vector stores/file search.
6. Add Playwright browser debugging.
7. Add WordPress helpers for logs, PHP lint, and WP-CLI.
8. Add patch/edit workflow with approval.

## Current Status

Steps 1 and 2 are complete.

## Setup

Copy the example environment file when you are ready to add your own values:

```bash
cp .env.example .env
```

Then run:

```bash
npm run doctor
```

## Daily Launcher

Start the menu launcher:

```bash
npm run ai
```

The launcher gives you quick access to chat, debug, index status/sync, plugin listing, patch proposal, and doctor checks.

## Local Web Dashboard

Start the chat-first local dashboard:

```bash
npm run web
```

Then open:

```txt
http://127.0.0.1:3333
```

The dashboard is bound to `127.0.0.1` for local use. It supports chat, debug, index status/sync, plugin listing, and chat reset.

Previous dashboard chats are saved in your browser and shown in the Conversations list.

It also includes confirmed controls for activating/deactivating plugins and activating themes.

You can also use chat for direct actions:

```txt
deactivate Bit File Manager plugin
same for Fluent Support Pro
activate both plugins
deactivate all plugins
activate all plugins
reactivate all plugins
install Classic Editor plugin and activate it
add new plugin Query Monitor
activate WP Debug Hub plugin
change theme to Twenty Twenty-Four
switch to Twenty Twenty-Five
enable debug log
disable debug log
```

Dashboard chat, terminal chat, and `npm start -- "..."` execute these plugin/theme/debug-log state changes immediately when the request is clear. Plugin installs resolve by WordPress.org plugin name or slug, install through WordPress' upgrader, and activate after install. Button controls still show browser confirmation, and direct CLI commands still require `--yes`.

For client support questions, the agent checks the installed plugin list, identifies the plugin the client is asking about, verifies that plugin first, then searches other installed plugins for a workaround. For example, if a client asks about scheduled support emails in a ticketing plugin, it can explain whether that plugin has the feature and whether FluentCRM can handle scheduled email campaigns or automations instead.

Confirmed CLI actions:

```bash
npm run wp:plugin -- deactivate file-manager/file-manager.php --yes
npm run wp:plugin -- activate file-manager/file-manager.php --yes
npm run wp:theme -- list
npm run wp:theme -- activate twentytwentyfive --yes
```

## Read-Only Code Tools

List detected plugins:

```bash
npm run plugins
```

List text/code files:

```bash
npm run files -- download-plugin
```

Read a safe text/code file:

```bash
npm run read:file -- download-plugin/download-plugin.php
```

## First AI Call

Ask a simple question:

```bash
npm start -- "What can you inspect right now?"
```

This first AI step is intentionally limited. It can call OpenAI and answer from the provided environment context, but it does not inspect plugin files or control the browser yet.

The default model is configured with:

```env
OPENAI_MODEL=gpt-4.1-mini
```

## AI With Read-Only Tools

The agent can now call these local read-only tools:

- `list_plugins`
- `list_files`
- `read_file`
- `tail_debug_log`
- `lint_php_file`
- `wp_cli_plugin_list`
- `debug_browser_page`

Examples:

```bash
npm start -- "List my local plugins."
npm start -- "Read download-plugin/download-plugin.php and summarize what it does."
npm start -- "List the readable files in my-shop."
npm start -- "Check the latest WordPress debug log errors."
npm start -- "Run PHP lint on my-shop/my-shop-loyalty.php."
npm start -- "Visit my local site and summarize browser console or network errors."
npm start -- "What theme is active and how many posts/pages are published?"
```

Manual diagnostic commands:

```bash
npm run debug:log -- 80
npm run lint:php -- my-shop/my-shop-loyalty.php
npm run wp:plugins
npm run site:summary
npm run browser:debug
```

## Code Memory

## Docs Memory

Put company/support documentation in:

```txt
docs/
```

Supported docs for direct indexing:

```txt
.md
.txt
.html
.json
.csv
.xml
.yml
.yaml
```

Then sync memory:

```bash
npm run index:sync -- --yes
```

The agent checks indexed docs first for support answers, then plugin code and local site facts.

By default, sync can include up to 2500 docs plus the plugin-code file limit. You can change this in `.env`:

```env
INDEX_MAX_DOCS=1000
```

For PDF/DOCX docs, convert them to Markdown or text before placing them in `docs/`. A PDF/DOCX importer can be added as the next step.

Preview the files that would be uploaded to OpenAI file search:

```bash
npm run index:code
```

Index a specific plugin:

```bash
npm run index:code -- my-shop --yes
```

Index all supported plugin code files:

```bash
npm run index:code -- . --yes
```

The indexer creates an OpenAI vector store, uploads supported code files, saves the vector store ID in `memory/vector-store-id.txt`, and updates `.env` with `OPENAI_VECTOR_STORE_ID`.

Generated memory files are ignored by Git.

Dynamic sync for all installed plugins:

```bash
npm run index:status
npm run index:sync
npm run index:sync -- --yes
```

`index:sync` scans the current installed plugin folders, compares file hashes with `memory/index-manifest.json`, and creates a fresh vector store only when files were added, changed, or removed. This keeps memory dynamic when you install or update plugins.

Optional automatic sync:

```env
AUTO_INDEX_ON_CHAT=true
AUTO_INDEX_ON_DEBUG=true
```

When enabled, chat/debug checks whether installed plugin code changed and refreshes memory before starting.

## Debug Workflow

Run the full read-only debugging workflow against the homepage:

```bash
npm run debug
```

Run it against a relative path:

```bash
npm run debug -- support-portal
```

Test a form like a human by filling visible fields, submitting, checking hidden required fields, validation messages, submit requests, and before/after screenshots:

```bash
npm run form:test -- support-portal
npm run debug -- support-portal --form
```

The workflow collects browser diagnostics, the latest WordPress debug log lines, WP-CLI plugin status, and local plugin discovery, then asks the model for a practical diagnosis. Diagnostic JSON is saved under `memory/diagnostics` and ignored by Git.

## Interactive Chat

Start an interactive terminal session:

```bash
npm run chat
```

Useful chat commands:

```txt
/plugins
/files my-shop
/read my-shop/my-shop-loyalty.php
/debug wp-admin
/reset
/exit
```

## Safe Patch Mode

Ask the agent to propose a patch:

```bash
npm run patch:propose -- "Fix the customer lookup nonce check in my-shop"
```

The proposal is saved under `memory/patches` and ignored by Git. Review it first.

Check a reviewed patch without applying it:

```bash
npm run patch:check -- /absolute/path/to/memory/patches/123-proposal.patch
```

Apply a reviewed patch explicitly:

```bash
npm run patch:apply -- /absolute/path/to/memory/patches/123-proposal.patch
```

Patch application validates paths and runs `git apply --check` before changing files. Normal chat and debug commands remain read-only.
