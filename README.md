# VoApps DirectDrop Voicemail: Direct Integration Kit

Drop DirectDrop Voicemail (DDVM) into your own application and skip Zapier's
per-task costs at volume. This kit packages the exact logic the VoApps Zapier
integration uses, as a dependency-free reference you can port to any stack:
find-or-create transactional campaigns, the consistent campaign naming, bulk CSV
import, per-record sends, and postback (webhook) signature verification.

**When to use this instead of Zapier:** Zapier bills one task per action step, so
~50k records/month in a per-record Zap runs roughly $350-600/month in Zapier fees.
A direct integration (or Zapier's own daily-batch pattern) collapses that to a
handful of calls. Above ~10k-20k sends/month, integrate directly. (This is only
about Zapier's task fees and integration overhead. Your VoApps cost is per
voicemail delivered and is the same no matter how you send.)

Prefer no-code? A Zapier integration is also available, private and by invite.
Contact VoApps for access.

## No-code setup guides

Connect your CRM or marketing platform without writing code:

- [HubSpot](docs/zapier-hubspot.md): via the VoApps Zapier integration (private, by invite: email support@voapps.com).
- [Iterable](docs/iterable.md): native, using Iterable's own journey webhooks to call VoApps directly (no Zapier).

Everything below is the developer path (direct API).

## Files

| File | What it is |
|------|------------|
| `voapps.js` | Node.js (>=18) reference module. No dependencies. CommonJS. |
| `postback_server.example.js` | Minimal Express receiver that verifies signatures and reads results. |
| `verify_postback.py` | Python HMAC verification (+ a Flask snippet). |
| `records.sample.csv` | Example bulk-import CSV. |

## API basics

- **Base URL:** `https://directdropvoicemail.voapps.com/api/v1`
- **Auth header:** `Authorization: Token token=<YOUR_API_KEY>`
- **Account in the path:** every call is under `/accounts/<ACCOUNT_ID>/…`
- **Caller number** is the actual phone number to display (e.g. `+18885551212`), **not** a caller-number resource id.
- Keep your API key and signing secret in environment variables, never in code.

## Two ways to send

### 1. Per-record (event-driven)
Find-or-create today's transactional campaign, then add one record. Best when your
app sends as events happen (a new record, a status change) and wants each one out
the door right away.

```js
const { createClient } = require('./voapps');
const voapps = createClient({ apiKey: process.env.VOAPPS_API_KEY, accountId: 12345 });

const { record, campaign_id, campaign_name } = await voapps.sendVoicemail({
  number: '+15551234567',
  messageId: 678,              // from your VoApps messages
  callerNumber: '+18885551212',
  zip: '92563',                // recommended: improves the delivery window
  accountNumber: 'CRM-1001',   // your tie-back id; echoed back on the postback
  label: '45+ DPD',            // optional campaign-name prefix
});
// record.id, campaign_id, campaign_name
```

`messageId` and `callerNumber` are required because they are needed to create the
day's campaign if one does not exist yet. The campaign is named
`"<label> | Transactional Campaign | <ISO 8601 w/ offset>"`, e.g.
`45+ DPD | Transactional Campaign | 2026-10-21T19:35:48.705-07:00`.

### 2. Daily batch (one call for the whole day)
Create one transactional campaign seeded with the whole day's records in a single
call. This is the direct-integration equivalent of the daily-batch Zap. It costs
the **same** at VoApps as sending per-record; VoApps bills per voicemail either
way. The advantages are operational: one API call instead of thousands, one
campaign to manage per day, and no rate-limit pressure.

```js
const records = [
  { number: '+15551234567', voapps_zip_code: '92563', account_number: 'CRM-1001' },
  { number: '+15559876543', voapps_zip_code: '90001', account_number: 'CRM-1002' },
  // ...thousands more
];

const campaign = await voapps.createCampaign({
  label: '45+ DPD',
  messageId: 678,
  callerNumber: '+18885551212',
  records,                 // or: csv: '<raw csv text>'
});
// campaign.id, campaign.name
```

## Bulk CSV format

A header row plus one row per record. Only `number` (or `phone_number`) is
required. Optional `voapps_` columns mirror the per-record fields; any other
columns (e.g. `account_number`) pass through and come back in the results.

```
number,voapps_zip_code,account_number
+15551234567,92563,CRM-1001
+15559876543,90001,CRM-1002
```

Recognized columns: `number`, `voapps_zip_code`, `voapps_message_id`,
`voapps_caller_number`, `voapps_voice_append`, `voapps_postback_url`,
`voapps_target_date`, plus any passthrough columns.

## HTTP recipes (any language)

**Create a transactional campaign with a CSV**
```bash
curl -X POST "https://directdropvoicemail.voapps.com/api/v1/accounts/ACCOUNT_ID/campaigns" \
  -H "Authorization: Token token=YOUR_API_KEY" \
  -F "name=45+ DPD | Transactional Campaign | 2026-10-21T19:35:48.705-07:00" \
  -F "message_id=678" \
  -F "caller_number=+18885551212" \
  -F "transactional=true" \
  -F "confirm=true" \
  -F "campaign_import=@records.csv;type=text/csv"
# -> { "campaign": { "id": 2195528, "name": "...", "status": "..." } }
```

**Add one record to a campaign** (form-urlencoded; the value is a JSON string)
```bash
curl -X POST "https://directdropvoicemail.voapps.com/api/v1/accounts/ACCOUNT_ID/campaigns/CAMPAIGN_ID/records" \
  -H "Authorization: Token token=YOUR_API_KEY" \
  --data-urlencode 'record_attributes={"number":"+15551234567","voapps_zip_code":"92563","account_number":"CRM-1001"}'
# -> { "record": { "id": 1348042444 } }
```

**Find today's reusable campaign** (local day boundary, with offset)
```bash
curl -G "https://directdropvoicemail.voapps.com/api/v1/accounts/ACCOUNT_ID/campaigns" \
  -H "Authorization: Token token=YOUR_API_KEY" \
  --data-urlencode "created_date=2026-10-21 00:00:00 -07:00"
# -> { "campaigns": [ { "id": ..., "status": "running", "target_date": "..." }, ... ] }
```
Reuse a campaign whose status is one of `setup, importing, pending, running,
paused`; if several qualify, pick the one whose `target_date` is closest to now;
if none, create a new one.

**Get a campaign's status / results export**
```bash
curl "https://directdropvoicemail.voapps.com/api/v1/accounts/ACCOUNT_ID/campaigns/CAMPAIGN_ID" \
  -H "Authorization: Token token=YOUR_API_KEY"
# -> { "campaign": { "status": "...", "export": "<S3 CSV url>", "records_count": N, ... } }
```
Download the `export` URL with a plain GET (no auth header: it is a presigned S3
link, and adding the token header breaks it).

## Delivery results (postbacks)

Set a `voapps_postback_url` per record (or a campaign/account default) and VoApps
POSTs each record's **final** result to it. Postbacks fire only on final codes,
never while pending/running. Respond `200` within ~5 seconds or VoApps retries.

**Result codes:** `100` pending · `101` running · `200` delivered · `300`
expired · `301` canceled · `400`-`410` failed/invalid · `500`-`504` restricted.

**Optional signature verification (HMAC).** If your org enables signing, VoApps
sends:
```
X-VoApps-Signature:   v1=<hex>
X-VoApps-Timestamp:   <unix seconds>
X-VoApps-Destination: <destination phone number>
```
The signature is `HMAC-SHA256(signing_secret, "<timestamp>.<destination>.<raw_body>")`.
Verify using the **exact raw body** (not a re-serialized object), check the
timestamp is fresh (≤ 300s), and compare in constant time. See
`verify_postback_signature` in `voapps.js` (Node) or `verify_postback.py`
(Python), and `postback_server.example.js` for a working Express receiver.

## ESM instead of CommonJS

`voapps.js` is CommonJS (`require`/`module.exports`). For an ESM project, either
set `"type": "commonjs"` for this file, or convert the two lines: replace
`const crypto = require('node:crypto');` with `import crypto from 'node:crypto';`
and the `module.exports = { … }` block with `export { … }`.

## Notes

- This is a reference implementation; test it against your VoApps account before
  production. The network calls mirror the VoApps Zapier integration exactly.
- For the full API reference, result codes, and the Postman collection, open the
  VoApps Knowledge Base: log in to your DirectDrop Voicemail portal and click
  **Help Center** in the left nav.
- Timezone defaults to `America/Los_Angeles`; pass `timezone` to `createClient` to
  match your business hours. Keep it consistent with however you schedule sends.

## License

MIT. See [LICENSE](LICENSE). Use it, modify it, ship it.
