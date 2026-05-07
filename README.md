# Local WordPress AI Agent

This is a local-only AI agent for WordPress plugin development and debugging.

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
```

Manual diagnostic commands:

```bash
npm run debug:log -- 80
npm run lint:php -- my-shop/my-shop-loyalty.php
npm run wp:plugins
npm run browser:debug
```

## Code Memory

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
