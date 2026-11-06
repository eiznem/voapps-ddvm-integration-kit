# Send DirectDrop Voicemail from HubSpot (native, no Zapier)

Trigger VoApps DirectDrop Voicemail (DDVM) from a HubSpot workflow, calling the
VoApps API directly from a **Custom code** action. No Zapier and nothing to host:
everything runs inside HubSpot and VoApps.

Requires **Operations Hub Professional or Enterprise** (for the Custom code
workflow action). If you do not have Operations Hub, use the
[HubSpot via Zapier guide](zapier-hubspot.md) instead. Prefer your own stack? See
the [developer (direct API) path](../README.md).

## Why Custom code and not "Send a webhook"

HubSpot's no-code "Send a webhook" action only builds a flat JSON body (each key
maps to one property or a static value). The VoApps records endpoint expects the
record as a single `record_attributes` value in a form-urlencoded body, which that
builder cannot construct. The Custom code action sends the exact request VoApps
expects, so it is the reliable native path.

## Before you start

From **VoApps**, have ready:

- Your **API key**.
- Your **account ID** (the number in the API path).
- A **Message** and its **message ID** (the voicemail audio).
- A **Caller Number** (the phone number that displays), for example `+18885551212`.

In **HubSpot**, you need Operations Hub Pro/Enterprise and workflow edit
permissions. Make sure contacts have a **phone number** property (and ideally a
**zip** property).

## Step 1: Add the Custom code action to a workflow

1. In HubSpot, go to **Automation > Workflows** and open or create a
   contact-based workflow whose enrollment trigger is your audience (for example
   a list membership or a property change).
2. Click the **+** to add an action, and in the **Data ops** section choose
   **Custom code**. Select **Node.js** (the examples below are Node).

## Step 2: Store your API key as a secret

In the Custom code action, under **Secrets**, click **Add secret**:

- **Name:** `VOAPPS_API_KEY`
- **Value:** your VoApps API key

Secrets are stored securely and referenced as `process.env.VOAPPS_API_KEY`.

## Step 3: Map the contact properties as inputs

Under **Property to include in code**, add the properties you want to send, and
note the names you give them:

- `phone` -> the contact's phone number property
- `zip` -> the contact's zip property (optional but recommended)
- `reference` -> the contact's **Record ID** (`hs_object_id`), used for tie-back

## Step 4: Paste the code

Edit the three constants at the top for your account, then paste:

```js
const axios = require('axios');

// Edit these for your VoApps account:
const VOAPPS_ACCOUNT_ID = 'YOUR_ACCOUNT_ID';
const VOAPPS_MESSAGE_ID = 'YOUR_MESSAGE_ID';
const VOAPPS_CALLER_NUMBER = '+18885551212';
// Optional: your postback receiver (see "Logging delivery results" below) to close
// the loop back into HubSpot. Leave '' to skip.
const VOAPPS_POSTBACK_URL = '';

exports.main = async (event, callback) => {
  const phone = event.inputFields.phone;
  if (!phone) throw new Error('No phone number on the contact.');

  const attrs = { number: phone };
  if (event.inputFields.zip) attrs.voapps_zip_code = event.inputFields.zip;
  attrs.voapps_message_id = VOAPPS_MESSAGE_ID;
  attrs.voapps_caller_number = VOAPPS_CALLER_NUMBER;
  // Tie-back: send the HubSpot Record ID (hs_object_id) so the result can be matched
  // back to this exact contact. VoApps echoes it in original_fields on the postback.
  if (event.inputFields.reference) attrs.account_number = event.inputFields.reference;
  if (VOAPPS_POSTBACK_URL) attrs.voapps_postback_url = VOAPPS_POSTBACK_URL;

  const body = new URLSearchParams({ record_attributes: JSON.stringify(attrs) }).toString();

  await axios.post(
    `https://directdropvoicemail.voapps.com/api/v1/accounts/${VOAPPS_ACCOUNT_ID}/records`,
    body,
    {
      headers: {
        Authorization: `Token token=${process.env.VOAPPS_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  // axios throws on a non-2xx response, which fails the action so HubSpot retries.
  callback({ outputFields: {} });
};
```

This sends the same request as the VoApps Zapier action and the direct API kit:
form-urlencoded `record_attributes`, with the `Token` auth header. VoApps adds the
record to that day's transactional campaign automatically (creating it if needed).

## Step 5: Test

Use the action's **Test** panel with a test contact whose phone number is your
own. Run it and confirm the voicemail arrives, and that the record shows in that
day's transactional campaign in the VoApps portal. Then turn the workflow on.

## Field reference

Only **number** is required. Recommended: **zip** (delivery-window safety) and a
reference id for tie-back. **Use the contact's HubSpot Record ID (`hs_object_id`) as
that reference** — it is stable and unique, and VoApps echoes it back untouched under
`original_fields` on the result/postback, so you can match each outcome to the exact
contact. Send it in any non-`voapps_` key; this guide uses `account_number`.

Supported keys inside `record_attributes`: `number`, `voapps_zip_code`,
`voapps_message_id`, `voapps_caller_number`, `voapps_voice_append`,
`voapps_postback_url`, `voapps_target_date`, plus passthrough fields such as
`account_number`.

Phone format: E.164 (`+15551234567`) or 10-digit US. Do not put PII in
`voapps_voice_append` (TTS).

## Logging delivery results back into HubSpot (close the loop)

The send above is one-directional. To record each voicemail's outcome back on the
contact, have VoApps **post the final result to a webhook** and write it to the
contact keyed by the `hs_object_id` you sent as the tie-back. Results fire only on
final outcomes (delivered, expired, failed, restricted), never while pending.

### Step A: Create the HubSpot properties to hold the result

On the Contact object, add custom properties, for example:

- `ddvm_delivery_status` (single-line text) — e.g. "Successfully delivered".
- `ddvm_delivery_code` (number) — the numeric result code.
- `ddvm_delivered_at` (date) — when the result arrived.

### Step B: Point each record at a postback receiver

Set `VOAPPS_POSTBACK_URL` in the Step 4 code (or set a campaign/account default in
the VoApps portal). It must be a **public HTTPS URL with a valid certificate** —
plain `http`, private/internal hosts, and redirects are **silently skipped**, and
skipped/failed postbacks show up for Owner/Admin users on the VoApps **Failed
postbacks** screen.

> HubSpot workflow actions can *send* a webhook but cannot *receive* one, so the
> inbound postback needs a tiny endpoint hosted somewhere (a serverless function on
> Cloudflare/Lambda/Vercel, a HubSpot CMS serverless function, etc.). The
> [direct API kit](../README.md) ships a ready `postback_server.example.js` with HMAC
> signature verification — adapt it as below.

### Step C: In the receiver, verify and update the contact

On each postback the receiver should:

1. **Verify the HMAC signature** (if your org enabled signing) — see the kit's
   `verify_postback.py` / `postback_server.example.js`.
2. Read the tie-back and result from the JSON body:
   `record.original_fields.account_number` (the `hs_object_id` you sent) and
   `record.delivery_status_code` / `record.delivery_status`.
3. **PATCH the contact** via the HubSpot CRM API, using that id:

```http
PATCH https://api.hubapi.com/crm/v3/objects/contacts/{hs_object_id}
Authorization: Bearer YOUR_HUBSPOT_PRIVATE_APP_TOKEN
Content-Type: application/json

{
  "properties": {
    "ddvm_delivery_status": "Successfully delivered",
    "ddvm_delivery_code": 200,
    "ddvm_delivered_at": "2026-11-06"
  }
}
```

(Or log a **Call** engagement instead via `POST /crm/v3/objects/calls` and associate
it to the contact.)

### Step D (optional): Act on the result with a HubSpot Workflow

Once the outcome lives on the contact, a normal **contact-based workflow** *triggered
by a change to `ddvm_delivery_status`* can do the follow-up natively — create a task
on a failed delivery, notify the owner, re-enroll for a retry, or move a deal stage.
That is where HubSpot Workflows finish closing the loop.

**Result codes:** `200` delivered, `300` expired, `301` canceled, `400`-`410`
failed/invalid, `500`-`504` restricted.

## Notes

- If `require('axios')` is unavailable in your runtime, Node 20's global `fetch`
  works too: swap the `axios.post(...)` call for a `fetch(url, { method: 'POST',
  headers, body })` and check `res.ok`.
- Set a rate limit on the action if you expect high enrollment volume.
- Your VoApps cost is per voicemail delivered, the same however you send.
