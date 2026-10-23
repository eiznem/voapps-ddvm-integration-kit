# Send DirectDrop Voicemail from Iterable (no Zapier)

Trigger VoApps DirectDrop Voicemail (DDVM) from an Iterable journey, using
Iterable's own **Journey Webhook** to call the VoApps API directly. No Zapier, no
middleware, and nothing to host. Everything is configured inside Iterable and
VoApps.

Prefer to integrate in your own code? See the
[developer (direct API) path](../README.md).

## How it works

Iterable's **Call Webhook** tile, backed by a saved **Journey Webhook**, sends an
HTTP POST to the VoApps records endpoint when a user reaches that step. The POST
carries the user's phone number (and anything else you want) as the voicemail
record. VoApps adds it to that day's transactional campaign automatically.

## Before you start

From **VoApps**, have these ready:

- Your **API key**.
- Your **account ID** (the number in the API path).
- A **Message** and its **message ID** (the voicemail audio).
- A **Caller Number** (the phone number that displays), for example `+18885551212`.

In **Iterable**, you need the **Manage Integrations** permission, and your user
profiles should have a **phone number** field (and ideally a **zip** field).

## Step 1: Create the Journey Webhook

Go to **Integrations > Journey webhooks > New webhook** and set:

| Field | Value |
|---|---|
| **Name** | `VoApps DirectDrop Voicemail` |
| **Destination** | Custom |
| **Method** | POST |
| **Endpoint** | `https://directdropvoicemail.voapps.com/api/v1/accounts/<ACCOUNT_ID>/records` |
| **Authentication** | None |

Then add the auth as a **secure custom header** (VoApps uses a `Token` scheme,
which is not Basic or OAuth):

- Click **Add Header**.
- **Name:** `Authorization`
- **Value:** `Token token=<API_KEY>`
- Check **Secure** (so the key is masked in the UI).

### Body

Set the body format to **URL-encoded** and add a single field:

- **Name:** `record_attributes`
- **Value:**

```
{"number":"{{phoneNumber}}","voapps_zip_code":"{{zip}}","voapps_message_id":"<MESSAGE_ID>","voapps_caller_number":"<CALLER_NUMBER>","account_number":"{{userId}}"}
```

Replace the placeholders:

- `{{phoneNumber}}` and `{{zip}}`: your actual Iterable profile field names.
- `{{userId}}`: the Iterable `userId` (or `{{email}}`), used as your tie-back
  reference. VoApps returns it untouched on the delivery result.
- `<MESSAGE_ID>` and `<CALLER_NUMBER>`: your VoApps message ID and caller number
  (literal values, not merge fields).

Leave **Include all triggering event fields and workflowId** unchecked and add no
**User fields**. Everything VoApps needs is inside `record_attributes`.

### Test and save

Under **Test Connection**, enter sample data to fill the merge fields, for example:

```json
{ "phoneNumber": "+15551234567", "zip": "92563", "userId": "test-1" }
```

Use a phone number you can check (your own). Click **Run Test**. VoApps should
return a `2xx` with a record id. Iterable will not let you save until a test
passes, which is a good guard against typos. Save the webhook.

## Step 2: Add it to your journey

In the journey, at the point where a user should receive a voicemail, add a
**Call Webhook** tile and select the `VoApps DirectDrop Voicemail` webhook.

If you expect high volume, set a **rate limit** on the tile so VoApps receives a
steady pace rather than a burst. There is no per-call fee from Zapier here, so you
do not need to batch; each qualifying user simply hits the tile.

## Step 3: Test end to end

Enroll a test user whose phone number is your own, let them reach the tile, and
confirm the voicemail arrives. Check the VoApps portal: the record should appear
in that day's transactional campaign.

## Field reference

Only **number** is required. Recommended: **zip** (delivery-window safety) and a
reference id (**account_number**) for tie-back. Supported keys inside
`record_attributes`:

`number`, `voapps_zip_code`, `voapps_message_id`, `voapps_caller_number`,
`voapps_voice_append`, `voapps_postback_url`, `voapps_target_date`, plus any
passthrough field (for example `account_number`).

Phone format: E.164 (`+15551234567`) or 10-digit US. Do not put PII in
`voapps_voice_append` (TTS).

## Delivery results

VoApps posts each voicemail's final result (delivered, expired, failed, and so on)
to a postback URL. Getting those results written **back into Iterable** is the one
piece Iterable cannot do on its own, because VoApps postbacks are in VoApps's
format, not Iterable's API format. Your options:

- **Fire and forget:** skip write-back and review outcomes in the VoApps portal or
  your DDVM stats dashboard. This is enough for many voicemail campaigns.
- **Write results back to Iterable:** run a small receiver that accepts the VoApps
  postback and calls Iterable's **Update User** or **Track Event** API. The
  [direct API kit](../README.md) includes a postback receiver (with signature
  verification) you can adapt for this. This is the only part that needs code.

**Result codes:** `200` delivered, `300` expired, `301` canceled, `400`-`410`
failed/invalid, `500`-`504` restricted. Results fire only on final outcomes.

## Notes and limits

- Iterable requires HTTPS (the VoApps endpoint is HTTPS).
- Iterable applies a 10-second timeout and retries on `429/502/503/504`; any other
  non-`2xx` makes the user exit the journey at that step, so confirm your test
  returns `2xx`.
- The account-level `/records` endpoint adds the record to that day's transactional
  campaign automatically (VoApps creates it if needed); the campaign uses VoApps's
  default naming.
- Your VoApps cost is per voicemail delivered, the same however you send.
