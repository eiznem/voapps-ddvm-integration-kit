# AGENTS.md — VoApps DirectDrop Voicemail API

Orientation for an AI coding assistant building a **VoApps DirectDrop Voicemail (DDVM)** integration. DDVM delivers a pre-recorded voicemail straight to a mobile voicemail box without ringing the phone. This file is a quick-start; confirm specifics against the Knowledge Base and the Integration Kit (links at the bottom).

## Authentication
- Authenticate with your account's **VoApps API key** (from the DirectDrop Voicemail portal; see the API Access Guide → *Accessing your API key*). Keep it secret — never commit it, log it, or ship it in a client app.
- Integration **partners** manage client accounts with a **partner API key** via the Partner API; a client's `account_id` scopes each request.
- Pass the key exactly as the API Access Guide / Postman collection show for each request; don't invent a header.

## Campaigns & reuse (the #1 thing to get right)
- **Transactional campaigns are per-day and expire at the end of the day.** A transactional campaign covers a single day's outreach and is **closed/expired at the end of that day** — VoApps cuts days at **midnight UTC-07:00**. Create (or find) **one** transactional campaign for the current day, add that day's records to it, and start a **fresh** campaign the next day. Do **not** reuse yesterday's campaign, and do **not** carry records over — once the day ends, that campaign is done.
- **Within a day, create the campaign once, then add records to it.** Find-or-create today's transactional campaign, then post records to it — never a new campaign per record.
- **Campaign names must be unique per account.** Reusing a name returns `400 Name must be unique for this account`. Append an ISO-8601 timestamp (which also naturally scopes the name to the day), e.g. `90+ DPD - 2026-10-26T14:03:00Z`.
- **Mind concurrency:** don't fire many `POST /campaigns` calls with the same name at the same instant — they collide and 400. Create (or look up) the campaign first, then add records.
- **Batch campaigns** are the other mode — a one-time list you upload and send — and are not the daily transactional pattern above.

## Error handling
- **Check every response status.** A `400` is a client error — the request was rejected, nothing was created, and no voicemail was sent. **Do not retry a 400** (the retry just 400s again); fix the request instead. Reserve automatic retries for `5xx`.
- The API does **not** issue `429` (rate-limit). When a call fails you'll get a 4xx, or a 5xx on a server-side error.
- Common validation messages and their fixes are catalogued on the KB **Errors & Status Codes** page. The **HTTP status of your API call is separate from the voicemail delivery result** (below).

## Delivery results
- A successful API response means the request was **accepted** — it is **not** the delivery outcome.
- Retrieve outcomes two ways: **webhook postback** (include a `voapps_postback_url` on the campaign/record, then verify the HMAC signature on each postback) or **poll** the `records` / `campaigns` endpoints.
- **Result codes** describe the *voicemail outcome* (e.g. `200` delivered, `401` not a wireless number, `500` restricted) and are distinct from HTTP status.
- VoApps **cuts days at midnight UTC-07:00**; pull completed-day results after that cutoff so the day is final.

## Resources
- **Knowledge Base** — API Access Guide, API Integration Outline, *Errors & Status Codes*, *Error Handling & Campaign Names*.
- **Integration Kit** (reference module, HTTP/curl recipes, postback-signature verification in Node & Python): <https://github.com/eiznem/voapps-ddvm-integration-kit>
- **Postman collection** (worked examples + assertions, built from the API Access Guide): <https://github.com/eiznem/voapps-api-postman-collection>

> This file is a quick orientation, not the full specification. Always verify endpoints, fields, and auth against the Knowledge Base and Integration Kit before relying on them.
