# API Contract Audit

What in this kit's API contract is **verified** (live-tested), **documented** (stated in the
authoritative VoApps Knowledge Base), **assumed** (inferred from code/examples), or
**unresolved** (needs Engineering). Evidence hierarchy: live test > Knowledge Base /
Engineering > guide-derived Postman examples > kit code/prose > inference.

> Nothing here has been live-tested against a real account by the kit authors, so the best
> current status is **documented**. Treat "documented" as reliable-but-confirm, and
> "assumed"/"unresolved" as not-yet-trustworthy.

Sources: KB *API Access Guide*, *Errors & Status Codes*, *Result Codes Defined*, *Creating
Campaigns/Records*, *Optional CSV Fields*, *Verifying Postbacks*; the Postman collection; and
this kit's `README.md` / `voapps.js`.

## HTTP status & response shape

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Success code | `200` in practice; the KB lists "200 / 201 — success". Kit models `200` and treats any 2xx as success. | KB *Errors & Status Codes*; Postman (200) | documented | low |
| Validation error | `400` with `{"error":"..."}`; multiple problems joined comma-separated. **Not 422.** | KB *Errors & Status Codes* | documented | low |
| Auth errors | `401` empty body (bad/missing key); `403` `{"error":"not_authorized"}`. | KB | documented | low |
| Not found | `404` `{"error":"not-found"}`. | KB | documented | low |
| Server error | `500` `{}`; retry after back-off. | KB | documented | low |
| Rate limit | API does **not** issue `429`. | KB; AGENTS.md | documented | low |
| Response wrappers | JSON with a named wrapper: `{accounts:[…]}`, `{campaigns:[…]}`, `{campaign:{…}}`, `{record:{…}}`, etc. (not bare). | README curl outputs; Postman; `voapps.js` unwrap | documented | low |
| Create-account wrapper | A Postman example showed `{accounts:[…]}` (plural) on create; spec models `{account:{…}}`. | Postman | unresolved | low |

## Duplicate handling (the former "HTTP 402")

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Duplicate record | A duplicate is **not** an HTTP error. The request succeeds; the record is flagged (`duplicate`/`duplicate_hash`) and resolves to **delivery result code `402` ("Duplicate number")**. There is **no HTTP `402`**. | KB *Result Codes Defined*; *Errors & Status Codes* (no 402) | documented | med — the prior spec modeled an HTTP 402, which was wrong |
| Exact success code / body on a duplicate submit | Whether it is `200` with `duplicate:true`, and the precise body, is not pinned down. | — | unresolved | med |

## Request media types

| Endpoint | Content type | Source | Status |
|---|---|---|---|
| `POST /accounts` | `multipart/form-data` (`name`, `timezone`) | Postman; `voapps.js` | documented |
| `POST …/messages` | `multipart/form-data` (`message_file` binary, `name`, `description`, `method`) | Postman | documented |
| `POST …/caller_numbers` | `multipart/form-data` (`number`, `name`, `verified_by_user`) | Postman | documented |
| `POST …/campaigns` | `multipart/form-data` (`name`, `message_id`, `caller_number`, `transactional`, `confirm`, `campaign_import` CSV, `target_date`, `pace`) | README; Postman; `voapps.js` | documented |
| `POST …/records` | `application/x-www-form-urlencoded`, single `record_attributes` = JSON string | README; `voapps.js` | documented |
| `PUT …/campaigns/{id}` | `application/x-www-form-urlencoded` (`method`, `pace`) | Postman | documented |

## Fields & naming

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Per-record fields | `voapps_`-prefixed: `voapps_message_id`, `voapps_caller_number`, `voapps_target_date`, `voapps_zip_code`, `voapps_voice_append`, `voapps_postback_url`. (The earlier spec used un-prefixed `message_id`/`caller_number`/`target_date`.) | KB *Optional CSV Fields* / record example | documented | med if un-prefixed names are used |
| `voapps_caller_number` meaning | The actual **phone number**, not a caller-number resource id. Same for campaign `caller_number`. | KB; README | documented | med |
| Passthrough / tie-back | Non-`voapps_` keys (e.g. `account_number`, `account`) pass through and are echoed under `original_fields`. | KB record example; README | documented | low |
| Per-record overrides take effect | Result codes `408 Invalid caller number` / `409 Invalid message id` imply per-record caller/message are validated and used. Confirm they override a reused campaign's defaults. | KB *Result Codes Defined* | assumed | med |
| `number` display format | Do not assume a fixed `+1` format; use what the API returns. | KB examples | documented | low |

## Campaign listing / dates

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| `created_date` required | List campaigns needs `created_date` **or** a `created_date_start`/`created_date_end` range. | KB | documented | low |
| `created_date` meaning | The date the campaign was **created**, not when it ran / is scheduled. | KB | documented | low |
| `created_date` format | Accepts a plain date or a datetime with offset (`2026-10-21 00:00:00 -07:00`). | README; `voapps.js` | documented | low |
| Pagination | `page` param; results newest-first. Page size / total-count fields not pinned down. | KB | assumed | low |

## Day cutoff / scheduling

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Daily cutoff | VoApps cuts days at a **fixed UTC-07:00** year-round (no DST). The kit anchors its "today's campaign" boundary to this (not a DST-aware zone). | KB; AGENTS.md | documented | med — a DST-aware Pacific zone is wrong in winter |

## Delivery result codes (21; distinct from HTTP)

`100` Pending\* · `101` Running\* · `200` Successfully delivered · `300` Expired · `301`
Canceled · `400` Unsuccessful delivery attempt · `401` Not a wireless number · `402`
Duplicate number · `403` Not a valid US number · `404` Undeliverable · `405` Not in service ·
`406` Voicemail not setup · `407` Voicemail full · `408` Invalid caller number · `409` Invalid
message id · `410` Prohibited self call · `500` Restricted · `501` Restricted for frequency ·
`502` Restricted geographical region · `503` Restricted individual number · `504` Restricted
WebRecon.  (\* = non-final; everything else is final.)  **Source:** KB *Result Codes Defined* —
documented.

## Signed postbacks

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| `X-VoApps-Destination` | The **postback URL** it was sent to, exactly as given in the record (NOT a phone number). | KB *Verifying Postbacks* | documented | was contradictory in the kit; now fixed |
| Signing string | `v1=` + HMAC-SHA256 hex over `timestamp.destination.raw_body` (literal dots, exact raw body), keyed with the org signing secret. | KB (Ruby sample) | documented | low |
| Signing is opt-in | Signing is enabled per organization; not all postbacks are signed by default. | KB | documented | low |
| Delivery / retries | Postbacks fire only on final result codes; respond 2xx within ~5s or VoApps retries up to two more times. | KB; kit | documented | low |
| Header presence | Modeled as optional in the webhook (present only when signing is enabled). | inference | assumed | low |

## Partner API

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| `GET /partners/users` | Exists for partner keys; response shape not captured. | KB mention | unresolved | low |

## Open questions for Engineering

1. Exact HTTP status per create endpoint — is it ever `201`, or always `200`?
2. Create-account response wrapper: `{account}` or `{accounts:[…]}`?
3. Duplicate-record submit: exact HTTP status and body (does it return `200` with `duplicate:true` + `duplicate_hash`?).
4. Do per-record `voapps_message_id` / `voapps_caller_number` override the campaign defaults on a reused campaign?
5. `/partners/users` response schema.
6. Campaign-list pagination: page size, total-count field, max `page`.
7. Postback retry schedule specifics (count/timing) and the exact rules for http/private-host/redirect endpoints.
8. Caller-number certification: exact field name/semantics for `verified_by_user`.
