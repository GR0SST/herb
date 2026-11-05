# Herb plugin

Lets an agent call your iPhone: `phone_call`, `phone_call_status`, and instructions for when and how to call.

## Connect

Create an account at https://herb.grosst.cc, then sign in to the Herb app on your iPhone with your account key.

The website has the steps for ChatGPT, Claude and Grok Bot. They all use this address:

```
https://herb.grosst.cc/mcp
```

Install the plugin in Codex:

```sh
codex plugin marketplace add GR0SST/herb
codex plugin add herb@herb
```

In Claude Code:

```sh
claude plugin marketplace add GR0SST/herb
claude plugin install herb@herb
```

The first time your agent connects, a sign-in page opens. Enter your account key or create an account, then tap Connect.

Clients without browser sign-in can use an API token from the website, sent as `Authorization: Bearer <token>`.

## Your own server

Deploy `relay/`, change the address in `.mcp.json`, and set your server on the app's sign-in screen. Push needs your own APNs key and an app built with your own bundle ID.
