---
name: phone-call
description: Call the user's iPhone through Herb, either just ringing or speaking a message with the Lily voice. Use for "позвони мне", "набери", "скажи голосом", "разбуди звонком", "call me", or when a task the user asked to be alerted about needs a phone alert. Also use when setting up Herb or when its tools fail.
---

# Herb phone call

Rings the user's iPhone through the Herb app. Text is optional: without it the phone just rings. With it, the phone reads the text aloud with the Lily voice after they answer (Supertonic, generated on the phone). The call is one-way: the user cannot reply by voice, and nothing they say is heard.

## First-time setup

Each user has their own account, created automatically when they open the Herb app. The plugin needs no tokens in its files.

1. Call `phone_call_status` or start the client's sign-in for the `herb` MCP server. A sign-in link opens in the browser.
2. In the Herb app the user opens Agents, taps +, and gets a sign-in code. They enter the code and an agent name on the page. The agent then appears in the app.
3. Never ask for codes or tokens in chat. The user types them only on the sign-in page.

If the user has no Herb app, tell them to install it first and stop: there is nothing you can do from here. Clients without browser sign-in can use an API token from the same screen in the app, sent as `Authorization: Bearer <token>`.

## When to call

Call only when the user asked for it or set up the rule in advance. Never call on your own initiative or to report routine progress. Call once per event.

## How to call

1. To just ring, call `phone_call` with no text. Add a short `title` when it helps.
2. To speak, write the message for listening: short, plain sentences, up to 2000 characters. Prepare it by the rules in the next section.
3. Pass `text` with `language` (`ru`, `uk`, `en`...). Without `language` the phone guesses it from the text, so always pass it.
4. Use one stable `idempotency_key` per event, such as `wake-2026-11-05`. Reuse the same key when you retry after a network error, so the phone does not ring twice.
5. Check the result with `phone_call_status`. A call rings for up to 60 seconds.

## Preparing text for speech

The server accepts any text and checks nothing. Pronunciation depends entirely on what you send.

**Russian and Ukrainian: stress marks are mandatory.** Without them the voice puts stress in the wrong place.

- Put COMBINING ACUTE ACCENT U+0301 right after the stressed vowel in every word of two or more syllables: `Напомина́ю: пора́ сде́лать пере́рыв.`
- One-syllable words need no mark. Do not put more than one mark in a word.
- Keep ё as ё: it already marks the stress. Never replace it with е.
- Use only U+0301. Capital letters, `+`, apostrophes and spacing accents do not work.
- Resolve words whose stress depends on meaning from context: за́мок / замо́к, му́ка / мука́.
- If you are unsure of a stress or a name, rewrite the sentence with a word you are sure of.
- Mixed text: mark every Russian or Ukrainian word and pass the main language as `language`.

**All languages:**

- Write numbers, dates, times, units and abbreviations as words, with stress marks in Russian and Ukrainian: `в де́вять три́дцать`, not `в 9:30`.
- No Markdown, links, code, emoji or lists. Use punctuation for pauses.
- Long messages are split into phrases by sentence, so finish sentences with punctuation.

## Reporting the result

| Status | Tell the user |
| --- | --- |
| `ringing` | The phone is still ringing |
| `answered` | They picked up. A call without a message ends here. With a message, they may have hung up before the end |
| `played` | The message played to the end. This does not prove they heard it |
| `declined` | They declined |
| `missed` | No answer |
| `failed` | The call failed |

Do not claim the message was heard unless the user confirms it. Do not redial after `declined` or `missed` unless the user asked for that.

## When something fails

| Result | Meaning | What to do |
| --- | --- | --- |
| `push: "disabled"` | The server has no push key | The phone rings only while the app is open. Tell the user |
| `push: "failed"` | The push did not reach the phone | Same. Ask the user to open the app once, so it re-registers |
| `daily_limit` | The account reached its daily limit | Tell the user. Try again tomorrow |
| `401`, or the client asks to sign in | Access expired or was removed | Start the sign-in flow again |
| `rate_limited` | More than 6 calls per minute from this bot | Wait a minute. Do not retry in a loop |
| `invalid_content` | Both text and audio were sent | Send one of them |
| `text_too_long` | Over 2000 characters | Shorten the text |
| Server unreachable | Network or server problem | Retry once with the same `idempotency_key`, then tell the user the call was not made |
