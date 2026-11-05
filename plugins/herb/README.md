# Herb plugin

Lets an agent call your iPhone: `phone_call`, `phone_call_status`, and instructions for when and how to call.

## Install

Install the Herb app first. Your account is created when you open it.

Codex:

```sh
codex plugin marketplace add /path/to/herb
codex plugin add herb@herb
```

Claude Code:

```sh
claude plugin marketplace add /path/to/herb
claude plugin install herb@herb
```

Grok Bot reads plugin catalogs from Git repositories. Add the Herb repository as a catalog and install `herb`.

Any other MCP client: add `https://herb.grosst.cc/mcp`.

## Sign in

1. Ask your agent to call you. It opens a sign-in link in your browser.
2. In the Herb app, open Agents, tap +, and enter the code on that page.

Clients without browser sign-in can use an API token from the same screen, sent as `Authorization: Bearer <token>`.

## Your own server

Deploy `relay/`, change the address in `.mcp.json`, and set the same server in the app under Settings, Server. Push needs your own APNs key and an app built with your own bundle ID.
