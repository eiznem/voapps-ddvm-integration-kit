# API Contract Audit

What in this kit's API contract is **verified** (confirmed with VoApps or live-tested),
**documented** (stated in the authoritative VoApps Knowledge Base), **assumed** (inferred from
code/examples), or **unresolved** (needs Engineering). Evidence hierarchy: live test / VoApps
confirmation > Knowledge Base > guide-derived Postman examples > kit code/prose > inference.

> **Update 2026-11-06:** the eight items previously listed as *open questions for Engineering*
> were **confirmed directly with VoApps** and are now marked **verified** (see *Resolved* at the
> end). Rows still marked "documented" are KB-stated and reliable; treat any "assumed" row as
> not-yet-confirmed.

Sources: KB *API Access Guide*, *Errors & Status Codes*, *Result Codes Defined*, *Creating
Campaigns/Records*, *Optional CSV Fields*, *Verifying Postbacks*, *Duplicate recipient records*,
*Failed postbacks*; the Postman collection; this kit's `README.md` / `voapps.js`; and VoApps
confirmation on 2026-11-06.

## HTTP status & response shape

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Success code | Always `200` — for reads **and** creates. The API does **not** use `201`. | VoApps 2026-11-06; KB; Postman | verified | low |
| Validation error | `400` with `{"error":"..."}`; multiple problems joined comma-separated. **Not 422.** | KB *Errors & Status Codes* | documented | low |
| Auth errors | `401` empty body (bad/missing key); `403` `{"error":"not_authorized"}`. | KB | documented | low |
| Not found | `404` `{"error":"not-found"}`. | KB | documented | low |
| Server error | `500` `{}`; retry after back-off. | KB | documented | low |
| Rate limit | API does **not** issue `429`. | KB; AGENTS.md | documented | low |
| Response wrappers | JSON with a named wrapper: `{accounts:[…]}`, `{campaigns:[…]}`, `{campaign:{…}}`, `{record:{…}}`, etc. (not bare). Exception: `GET /partners/users` returns a bare array. | VoApps 2026-11-06; README; Postman; `voapps.js` unwrap | verified | low |
| Create-account wrapper | **Create** returns the singular `{account:{…}}`. **List Accounts** returns the plural `{accounts:[…]}` — even when only one account comes back. | VoApps 2026-11-06 | verified | low |

## Duplicate handling (the former "HTTP 402")

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Duplicate record | A duplicate is **not** an HTTP error. The create still returns **`200`** with a new record id; the normalized top-level `number` is **empty**, a `duplicate_hash` (UUID) is added **inside `original_fields`** (identifying the matched original), the record is **excluded from delivery**, and it resolves to **delivery result code `402` ("Duplicate number")** in results and postbacks. There is **no HTTP `402`**. | VoApps 2026-11-06; KB *Duplicate recipient records*, *Result Codes Defined* | verified | low |

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
| Per-record fields | `voapps_`-prefixed: `voapps_message_id`, `voapps_caller_number`, `voapps_target_date`, `voapps_zip_code`, `voapps_voice_append`, `voapps_postback_url`. | KB *Optional CSV Fields* / record example | documented | low |
| `voapps_caller_number` meaning | The actual **phone number**, not a caller-number resource id. Same for campaign `caller_number`. | KB; README | documented | low |
| Passthrough / tie-back | Non-`voapps_` keys (e.g. `account_number`, `account`) pass through and are echoed under `original_fields`. | KB record example; README | documented | low |
| Per-record overrides take effect | Per-record `voapps_message_id` / `voapps_caller_number` **do override** the campaign's `message_id` / `caller_number` defaults when a record is added to a reused campaign. | VoApps 2026-11-06 | verified | low |
| Caller-number certification | `verified_by_user` (boolean) certifies that you are authorized to originate from the number. A **Do-Not-Originate** number is **rejected at caller-number creation** (`400`). | VoApps 2026-11-06 | verified | low |
| `number` display format | Do not assume a fixed `+1` format; use what the API returns. | KB examples | documented | low |

## Campaign listing / dates

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| `created_date` required | List campaigns needs `created_date` **or** a `created_date_start`/`created_date_end` range. | KB | documented | low |
| `created_date` meaning | The date the campaign was **created**, not when it ran / is scheduled. | KB | documented | low |
| `created_date` format | Accepts a plain date or a datetime with offset (`2026-10-21 00:00:00 -07:00`). | README; `voapps.js` | documented | low |
| Pagination | `page` (1-based), **25 per page**, newest-first. **No total-count field** and **no maximum page** — keep paging until a page returns fewer than 25 items. | VoApps 2026-11-06 | verified | low |

## Day cutoff / scheduling

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| Daily cutoff | VoApps cuts days at a **fixed UTC-07:00** year-round (no DST), and by default **completes any unfinished campaigns ~15 minutes before** the cutoff. The kit anchors its "today's campaign" boundary to the fixed offset (not a DST-aware zone). | VoApps 2026-11-06; KB; AGENTS.md | verified | low |

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
| `X-VoApps-Destination` | The **postback URL** it was sent to, exactly as given in the record (NOT a phone number). | KB *Verifying Postbacks* | documented | low |
| Signing string | `v1=` + HMAC-SHA256 hex over `timestamp.destination.raw_body` (literal dots, exact raw body), keyed with the org signing secret. | KB (Ruby sample) | documented | low |
| Signing is opt-in | Signing is enabled per organization; not all postbacks are signed by default. | KB | documented | low |
| Delivery / retries | Postbacks fire only on final result codes; respond 2xx within ~5s or VoApps retries up to **two more times** (~+30s then +60s). | VoApps 2026-11-06; KB | verified | low |
| Endpoint rules | Non-HTTPS URLs, private/internal hosts, and redirecting endpoints are **silently skipped** (no API error). Users with the **Owner** or **Admin** role can review skipped/failed postbacks on the *Failed postbacks* screen in the portal. | VoApps 2026-11-06; KB *Failed postbacks* | verified | low |
| Header presence | Modeled as optional in the webhook (present only when signing is enabled). | inference | assumed | low |

## Partner API

| Topic | Behavior / evidence | Source | Status | Risk |
|---|---|---|---|---|
| `GET /partners/users` | Returns a **bare array** of `{ id, email, api_key }` — each managed user's id, email, and that user's VoApps API key. | VoApps 2026-11-06 | verified | low |

## Resolved (confirmed with VoApps, 2026-11-06)

These were the open questions for Engineering; all are now confirmed and folded into
`openapi.yaml` and this audit.

1. **Create status code** — always `200`, for reads and creates alike; the API does **not** use `201`.
2. **Create-account wrapper** — create returns the singular `{account}`; List Accounts returns the plural `{accounts}`, even when only one account is returned.
3. **Duplicate-record submit** — returns `200` with a new record id; the normalized `number` is empty, a `duplicate_hash` (UUID) is added inside `original_fields`, the record is excluded from delivery, and it surfaces as delivery result code `402` "Duplicate number". No HTTP `402`.
4. **Per-record overrides** — per-record `voapps_message_id` / `voapps_caller_number` override the campaign defaults on a reused campaign.
5. **`/partners/users` schema** — a bare array of `{ id, email, api_key }`.
6. **Campaign-list pagination** — `page` (1-based), 25 per page, no total-count field, no maximum page; page until a page returns fewer than 25.
7. **Postback endpoints** — up to two retries (~+30s, +60s); non-HTTPS/private-host/redirecting endpoints are silently skipped (no error); Owner/Admin can review on the *Failed postbacks* screen.
8. **Caller-number certification** — `verified_by_user` (boolean) certifies authorization to originate from the number; a Do-Not-Originate number is rejected at caller-number creation.
