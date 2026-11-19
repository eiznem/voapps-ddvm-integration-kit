# Send and log DirectDrop Voicemail in HubSpot (native, no Zapier)

Send VoApps DirectDrop Voicemail (DDVM) from a HubSpot workflow and log each
result back on the contact as an outbound call, entirely inside HubSpot. No
Zapier and no separately hosted receiver.

This guide reflects a configuration built and tested in a HubSpot portal on
November 18, 2026. It separates three things: what is configured, what passed in
controlled tests, and what has **not** yet been validated for production.

Prefer no code? See the [HubSpot via Zapier guide](zapier-hubspot.md). Prefer your
own stack? See the [developer (direct API) path](../README.md).

## How it works

Two workflows in HubSpot's new workflow builder:

- **DDVM HubSpot Integration Send Voicemail:** validates the configured
  selections, selects a campaign, reserves a call, submits one record to VoApps,
  and creates an acceptance note on the contact.
- **DDVM HubSpot Integration Webhook Receiver:** receives the VoApps result
  postback, parses its timestamp, and updates the reserved call.

**Acceptance is not delivery.** The note confirms that VoApps accepted the
submission. The call's outcome records the later delivery result.

### Status

**Passed in controlled tests:** mobile-first number selection; named-campaign
submission; acceptance-note creation; native webhook receipt (HTTP 202);
timestamp parsing; call outcome, status, owner, and duration handling; updating
the reserved call; sequential duplicate postbacks; and blocking a repeated send
for the same contact and campaign.

**Not yet validated for general production:** simultaneous submissions, injected
timeouts, rate limits, new-campaign creation after the discovery fix, and
operational recovery. Interactive account/message/caller selection and automatic
saving of replacement campaign IDs are not implemented.

> **Source code.** The action code is in [`hubspot/`](../hubspot/) (see
> [Source files](#source-files)). It was reconstructed from the tested revisions,
> not freshly exported from the deployed workflows, and hasn't been re-run since
> it was packaged. It ships with safe defaults (`DRY_RUN = true` in the sender and
> logger, `TEST_MODE = true` in the logger) and placeholder IDs, so copying it
> changes nothing until you configure it. The installed test versions had writes
> enabled. Nothing here updates a live workflow.

## 1. Prepare access and HubSpot settings

### Access

Running code in workflows (the **Custom code** action) requires **HubSpot Data
Hub Professional or Enterprise** (formerly Operations Hub). You also need the **Webhook event is received**
trigger, call properties with unique values, and calling configuration. These
were available in the test portal; confirm them in yours.

The tested runtime is **Node.js 24.x**, with `exports.main` returning
`{ outputFields: { ... } }`. Don't mix in callback-style examples from older
HubSpot documentation.

### Secrets

Store credentials only as Custom code **secrets**. Never paste keys into code,
chat, screenshots, or a repository.

| Secret | Purpose | Used by |
|---|---|---|
| `VOAPPS_API_KEY` | Your VoApps API key | Send Voicemail |
| `HUBSPOT_DDVM_TOKEN` | A dedicated HubSpot service key | Send Voicemail and Log DDVM |

If you choose different secret names, change them in the code too, not only in
your setup.

The tested HubSpot service key used `crm.objects.contacts.read` and
`crm.objects.contacts.write`. With those scopes, reading outcomes, contacts, and
call properties, and creating and updating calls, all succeeded in the test
portal. Contact-schema write access wasn't needed, because the properties and
outcomes were created manually. Don't add automation, export, or sensitive-data
scopes preemptively, and keep any future schema-provisioning access separate
from the runtime key.

In the tested HubSpot UI, the former Private Apps page redirected to **Legacy
Apps**, where **Service key** was one of the creation options. Use the
service-key controls available in your account.

### Create the call type and outcomes

1. Go to **Settings > Calling > Call and meeting types** and add
   **VoApps DirectDrop Voicemail** once.
2. Go to **Settings > Calling > Call outcomes** and add the 19 terminal-result
   labels from the [result mapping](#result-mapping) table, exactly as written.
   Don't include numeric codes or a "DDVM" prefix, and don't create outcomes for
   Pending or Running.

A read-only setup helper
([`setup-outcomes.js`](../hubspot/test-helpers/setup-outcomes.js)) retrieves the
outcome IDs; it does **not** create
outcomes or the call type (no supported creation endpoint was found). The logger
resolves the exact labels at runtime and stops if a label is missing or
ambiguous.

### Create two unique call properties

Go to **Settings > Properties**, choose the **Call** object, and select **Create
property**. Make both properties single-line text with **Require unique values**
turned on:

| Label | Internal name | Purpose |
|---|---|---|
| VoApps Send Reference | `voapps_send_reference` | Account + campaign + contact; reserved before sending |
| VoApps Submission Reference | `voapps_submission_reference` | Account + VoApps record ID; deduplicates result logging |

Suggested description for the send reference: *Unique VoApps account, campaign,
and contact reference used to reserve a send and prevent duplicate submissions.*

Uniqueness is essential. A search-then-create check alone doesn't protect
against simultaneous executions. Never delete reservations to make a retry work.

## 2. Configure the webhook receiver

### Create and link the event

1. Create an unpublished new-builder workflow named **DDVM HubSpot Integration
   Webhook Receiver**.
2. Choose the trigger **Webhook event is received**, then create an event named
   **VoApps Delivery Result**.
3. Keep the event description to **150 characters or fewer**. For example:
   `Logs VoApps results as outbound calls using the supplied timestamp or action-start fallback.`
4. Copy the generated HTTPS receiver URL into the sender configuration (it becomes
   the record's postback URL). Treat it as a sensitive ingestion address: don't
   publish it or commit it to a repository.
5. During initial setup, use **Listen for events** and send a representative
   postback sample. In testing, this listener wasn't available after the event was
   saved; you don't need it for later tests.
6. Link the event to **Contact**, matching `record.original_fields.account_number`
   to **Record ID**. Both were Number fields in the tested event. The sender sends
   the contact reference as text, so confirm ingestion and linking with a real
   sample in your portal.
7. Name the trigger **DDVM Webhook Event Received**, and turn on re-enrollment
   (repeat runs) so later submissions for the same contact are processed.

For the first publication, add an **Only start if** condition: the original
account number equals your approved test contact's Record ID. Keep the sender
unpublished.

### Event properties

Keep the complete nested paths. Phone numbers and ZIP codes are strings, not
numbers.

| Event path | Type |
|---|---|
| `record.id` | Number |
| `record.delivery_status_code` | Number |
| `record.delivery_status` | String |
| `record.voapps_timestamp` | String |
| `record.original_fields.account_number` | Number (matches Contact Record ID) |
| `record.original_fields.phone_number` | String |
| `record.original_fields.voapps_caller_number` | String |
| `record.original_fields.voapps_message_id` | String |
| `record.original_fields.message_name` | String |
| `record.original_fields.message_duration_seconds` | String |
| `record.original_fields.hubspot_call_id` | String |
| `record.original_fields.voapps_send_reference` | String |

Keep the optional ZIP and other original fields as needed. `duplicate_hash`
appears only on Duplicate number results and isn't required. The top-level
`record.number` can be null, so use the original `phone_number` as the logged
destination.

Message metadata (name and duration) is fetched by the **sender**, included as
passthrough fields in the submission, and echoed back in the result; the receiver
doesn't look it up. When you add event properties to a saved definition, verify
that real occurrences populate them before a broad rollout.

### Action 1: Result Parser

Add a **Custom code** action named **Result Parser** and paste
[`hubspot/result-parser.js`](../hubspot/result-parser.js). It needs no secret and
no configuration.

Map these inputs from **VoApps Delivery Result (trigger)**, not from Contact
properties:

| Input | Event path |
|---|---|
| `delivery_status` | `record.delivery_status` |
| `delivery_status_code` | `record.delivery_status_code` |
| `voapps_record_id` | `record.id` |
| `contact_id` | `record.original_fields.account_number` |
| `phone_number` | `record.original_fields.phone_number` |
| `caller_number` | `record.original_fields.voapps_caller_number` |
| `message_id` | `record.original_fields.voapps_message_id` |
| `voapps_timestamp` | `record.voapps_timestamp` |

Add String outputs: `call_timestamp`, `timestamp_source`, `result_summary`, and
`voapps_record_key`.

The parser accepts timestamps with an explicit timezone, such as
`2026-11-18 23:13:09 UTC` and `2026-11-18 15:13:09 -08:00` (both parse to
`2026-11-18T23:13:09.000Z`). A **blank** timestamp falls back to the parser
action's start time, not the exact webhook receipt time. A timestamp that is
present but malformed fails the action; it isn't silently replaced. Your VoApps
account settings control whether timestamps are in UTC or the account timezone.

### Action 2: Log DDVM

Add a second Custom code action named **Log DDVM**, paste
[`hubspot/log-ddvm.js`](../hubspot/log-ddvm.js), attach the `HUBSPOT_DDVM_TOKEN`
secret, and set `ACCOUNT_ID`. Start with `DRY_RUN = true` and `TEST_MODE = true`.

| Input | Source |
|---|---|
| `call_timestamp` | Result Parser → `call_timestamp` |
| `timestamp_source` | Result Parser → `timestamp_source` |
| `result_summary` | Result Parser → `result_summary` |
| `voapps_record_id` | Result Parser → `voapps_record_key` |
| `contact_id` | Trigger → `record.original_fields.account_number` |
| `delivery_status_code` | Trigger → `record.delivery_status_code` |
| `phone_number` | Trigger → `record.original_fields.phone_number` |
| `caller_number` | Trigger → `record.original_fields.voapps_caller_number` |
| `message_id` | Trigger → `record.original_fields.voapps_message_id` |
| `message_name` | Trigger → `record.original_fields.message_name` |
| `message_duration_seconds` | Trigger → `record.original_fields.message_duration_seconds` |
| `hubspot_call_id` | Trigger → `record.original_fields.hubspot_call_id` |
| `voapps_send_reference` | Trigger → `record.original_fields.voapps_send_reference` |

Add String outputs: `logging_status`, `hubspot_call_id`, and `logging_details`.

The logger checks the reserved call's send reference and contact association,
then updates that call. A mismatch stops processing; it doesn't create a
replacement call. The code also keeps a legacy path that creates a call when a
result has no reservation; decide whether to disable it before production.

Calls are logged as outbound and assigned to the contact's current owner (an
unowned contact's call stays unassigned). The activity creator isn't set to the
contact owner, and the caller number's name isn't stored. The message name, ID,
duration, and result code are written to the call details. Only a code `200`
result sets the call duration (seconds converted to milliseconds); other terminal
results keep the message duration in the details only.

### Result mapping

| Code | Outcome label (exact) | Call status |
|---|---|---|
| 100 | Pending | Not logged (not terminal) |
| 101 | Running | Not logged (not terminal) |
| 200 | Successfully delivered | Completed |
| 300 | Expired | Canceled |
| 301 | Canceled | Canceled |
| 400 | Unsuccessful delivery attempt | Completed |
| 401 | Not a wireless number | Canceled |
| 402 | Duplicate number | Canceled |
| 403 | Not a valid US number | Canceled |
| 404 | Undeliverable | Canceled |
| 405 | Not in service | Completed |
| 406 | Voicemail not setup | Completed |
| 407 | Voicemail full | Completed |
| 408 | Invalid caller number | Failed |
| 409 | Invalid message id | Failed |
| 410 | Prohibited self call | Failed |
| 500 | Restricted | Canceled |
| 501 | Restricted for frequency | Canceled |
| 502 | Restricted geographical region | Canceled |
| 503 | Restricted individual number | Canceled |
| 504 | Restricted WebRecon | Canceled |

**Completed** means the attempt reached a terminal result, not necessarily that
the voicemail was delivered. Unknown codes stop for review, and a later
conflicting terminal outcome never silently overwrites an earlier one.

## 3. Configure Send Voicemail

1. Create **DDVM HubSpot Integration Send Voicemail** in the new workflow builder.
2. Start with **Run on demand → Inputs for each run → CRM Records → Contact**.
3. Add a Custom code action named **Send Voicemail**, paste
   [`hubspot/send-voicemail.js`](../hubspot/send-voicemail.js), and attach both
   secrets.
4. Set `ACCOUNT_ID`, `MESSAGE_ID`, `CALLER_NUMBER`, `POSTBACK_URL` (the receiver's
   webhook URL), `DEFAULT_CAMPAIGN_LABEL`, and `SAVED_CAMPAIGN` for this use case.
   Leave `SAVED_CAMPAIGN.id` blank until a campaign has been selected. Don't reuse
   another portal's IDs.
5. Keep `DRY_RUN = true` while previewing.

| Input | Contact source |
|---|---|
| `mobilephone` | Mobile Phone Number |
| `phone_number` | Phone Number |
| `reference` | Record ID |
| `voapps_zip_code` | Postal code (optional) |
| `campaign_label` | Optional override of the configured label |

Map both phone inputs. The code uses Mobile Phone Number when it's populated and
otherwise falls back to Phone Number; if both are blank, it stops. A populated
but invalid mobile number stops validation instead of silently sending to the
backup number.

Add String outputs: `send_status`, `send_details`, `campaign_id`,
`campaign_name`, `voapps_record_id`, and `submission_note_body`.

### How selections work today

On every execution, the sender validates its configured account, message, and
caller number against fresh lists of accounts, active messages, and active
caller numbers, and stops if a selection is hidden, deleted, or unavailable. It
includes the selected message's name and duration in the record.

An interactive setup wizard is **not implemented**. Until it is, changing the
account, message, or caller number means fetching the current lists, choosing
valid values, updating the configuration deliberately, and revalidating the saved
campaign. A future wizard should show each message's name and ID and save the
selection per use case, not prompt for each contact.

### Branch on acceptance and create the note

After Send Voicemail, add a branch that compares **Send Voicemail →
`send_status`** to the literal value `accepted`. Don't branch on the action's
generic *Succeeded* state: a dry run or a review-required result also finishes
successfully.

On the accepted path only, add **Create note**:

- **Record:** Contact from trigger.
- **Note body:** the dynamic value **Send Voicemail → `submission_note_body`**.
- **Pin note:** off, unless you need it.

The other path must not create an acceptance note. The note includes the campaign
name and ID, the VoApps record ID, the message, the destination, and the
submission time. (`submission_note_created: false` in the code's output refers to
the code itself; the separate note action runs afterward.)

## 4. Campaign selection and duplicate protection

### Campaign reuse

The sender reuses the saved, eligible transactional campaign for the same use
case, message, and caller number, even across dates, and keeps the existing
campaign's name. New campaigns are named:

`<Use-case label> | Transactional Campaign <account-local date> <configuration fingerprint>`

The saved campaign is validated directly before every send. A changed
configuration, an authentication problem, or an ambiguous failure stops
processing. Only a saved campaign that is definitely missing or closed leads to a
bounded discovery search, and more than one eligible match stops for review
rather than picking one arbitrarily.

Discovery searches by campaign **creation date**, not target date. Date-only end
values mean midnight at the *start* of that date: in testing, an end value of
November 19 missed a campaign created after midnight UTC on November 19, and
moving the end to November 20 found it. Use explicit timestamps with offsets
where supported, or a next-midnight end bound. Don't scan the full history (for
example, from 1970).

The current lookup starts seven days before the current UTC date and ends at the
next UTC midnight. Because it's rounded to dates, it isn't an exact 168-hour
window, and campaigns created before it aren't found by discovery (a saved
campaign can still be validated directly).

Selecting a campaign returns its ID, but **outputs don't rewrite the workflow's
saved configuration**: save replacement IDs deliberately. A valid saved selection
avoids list scans entirely. Campaign-creation races and recovery still need more
testing. If VoApps reports that a campaign name must be unique, never work around
it by generating a different name blindly.

### Reserve before submitting

The rule is **one submission per contact per VoApps campaign**, even if the
contact's phone number or the message changes within that campaign.

1. Build the send reference: `account_id:campaign_id:contact_id`.
2. Create a Queued outbound call with that unique reference, associated with the
   contact.
3. Only the execution that creates the reservation may submit the record.
4. Include `hubspot_call_id` and `voapps_send_reference` in the record's
   passthrough fields, along with the message metadata, campaign ID and name, and
   contact reference.
5. Submit to `POST /api/v1/accounts/{account_id}/campaigns/{campaign_id}/records`
   as form-urlencoded `record_attributes` containing the JSON attributes.
6. On acceptance, save `account_id:voapps_record_id` on the reservation, without
   overwriting a terminal status that a fast postback may already have written.
7. The receiver validates and updates the same call.

For an existing reservation, the sender returns
`reserved_no_resend_review_required`. It doesn't automatically tell an
already-accepted submission apart from other unresolved reservations, so
reconcile before any manual retry. Receiver outcomes include
`updated_reserved_call`, `already_logged`, and `review_required`.

The unique property prevents two reservations with the same key; it doesn't make
the VoApps submission itself idempotent. Deleting or archiving tracking calls,
restoring old code, or changing references can defeat the protection, so never
do any of these as a retry workaround.

## 5. Test and release safely

### Test each layer separately

1. **Setup helper:** run outcome discovery once and confirm every terminal-result
   label resolves. It's read-only and isn't needed in normal operation.
2. **Parser:** test a blank timestamp (falls back to the action start time),
   explicit UTC, a numeric offset, and a malformed value (must fail).
3. **Logger preview:** test codes `200`, `402`, and `408` to cover Completed,
   Canceled, and Failed. Confirm the contact, owner, message, and duration.
4. **Synthetic reservation:** use
   [`reservation-helper.js`](../hubspot/test-helpers/reservation-helper.js) to create a clearly marked
   test reservation. Preview, update it, then repeat the update. Expect the same
   call ID and `already_logged`.
5. **Sender dry run:** run the whole draft workflow, not just the action. Confirm
   mobile selection, campaign validation, and that the non-accepted path creates
   no note.
6. **Publish the receiver:** only with permission, and only after restricting it
   to the test contact with `TEST_MODE = true`. Publishing makes real HubSpot
   activity writes possible; it's not just saving a draft.
7. **One approved real submission:** reserve, send, and create the note. Confirm
   the live postback updates the same reserved call.
8. **Repeat the send** for the same contact and campaign: expect the existing
   reservation, no new VoApps submission, and no new note.

**Testing an individual Custom code action may require filling in the property
test values manually, even after selecting a contact.** A full draft run uses the
mapped contact values. If the chosen phone number is unexpected, inspect the
action's actual runtime inputs.

Don't submit voicemails repeatedly to debug the receiver. A test-only replay
action ([`replay-webhook.js`](../hubspot/test-helpers/replay-webhook.js)) can post a captured or synthetic result directly to the HubSpot receiver.
It sends no voicemail, but it can create or update a real test call while the
receiver is live. Use that action's own **Test** button rather than running a
helper workflow that contains other write actions.

The HubSpot receiver URL returned **202 Accepted** in replay tests, which VoApps
accepts as a successful postback. The receiver runs asynchronously, so a 202
doesn't mean the call was logged: check the workflow's run history. Publishing
the receiver doesn't replay earlier events.

### Release checklist

- [ ] Confirm the code you install matches the tested revisions in `hubspot/`.
- [ ] Remove stale diagnostic comments and preview interlocks only as part of an
      approved release.
- [ ] Keep safe defaults in samples, and document each deployment flag.
- [ ] Verify event linking, nested mappings, unique call properties, and
      service-key access.
- [ ] Verify message metadata in a real ingested event and the resulting call.
- [ ] Confirm reservation updates and repeated-send/postback behavior.
- [ ] Review simultaneous-send, timeout, rate-limit, and later-result-correction
      scenarios.
- [ ] Decide on postback authenticity. **HMAC postback signing is not
      implemented or tested with this native receiver**, and a
      contact-association match is not authentication. If your organization
      requires signed postbacks, use a receiver that verifies signatures (the
      kit's `verify_postback.py` and `postback_server.example.js` show how), and
      test it before relying on it.
- [ ] Assign monitoring and a reconciliation owner for queued reservations and
      review-required results.
- [ ] Approve the production audience, consent and suppression policy, delivery
      windows, rate limits, and campaign configuration.
- [ ] Turn off `TEST_MODE` for production logging deliberately, and review that
      code change before publishing.
- [ ] Replace the receiver's single-contact restriction with the approved
      production scope; don't just remove the control.
- [ ] Turn on sender writes and publish or automate only with explicit
      authorization.

Test-only helpers (setup, replay, and reservation) aren't production components.

## 6. Operations and troubleshooting

| Symptom | Meaning and next action |
|---|---|
| Event creation returns a generic 400 | Check the network response, not just the error message. The observed cause was a description over 150 characters. Share only the response body, never auth headers. |
| No phone number in an individual action test | Check the property test values and the exact input names; selecting a contact may not fill them. |
| Phone Number used instead of Mobile | Verify both the `mobilephone` and `phone_number` mappings and the runtime inputs. |
| "Campaign name must be unique" | An existing campaign may have been excluded by a date boundary or eligibility filter. Inspect it; don't invent another name or resubmit blindly. |
| Saved campaign no longer eligible | Reconcile it, use bounded discovery, and save the replacement ID deliberately. |
| Reservation already exists | No new VoApps submission should occur. Inspect the existing call and the VoApps record history. Never delete the reservation automatically. |
| Timeout or server error after submitting | Acceptance is unknown. Keep the reservation and check VoApps before taking any manual action. |
| Request definitely rejected | Review the configuration and the safe parts of the API response. Keep the tracking record; don't release the reservation automatically. |
| Accepted, but saving the reference failed | Don't resend. The receiver can reconcile using the echoed `hubspot_call_id` and send reference. Check both systems. |
| Note action failed after acceptance | Repair or retry only the note. Rerunning the sender skips the send and won't recreate the note; note creation isn't transactionally tied to acceptance. |
| HTTP 202 but the call wasn't updated | Check the event occurrence and linking, the trigger's scope, the published revision, the action inputs, and the receiver's run history. |
| Result has no reservation fields | Review before using the legacy call-creation path. Don't guess which queued call to update. |
| Unknown result code or conflicting terminal outcome | Stop for review; don't map it to a guessed outcome or overwrite an earlier final result. |

The sender never retries a submission automatically. Reservation locking is
intentionally conservative: an execution can leave a queued reservation even if
VoApps never accepted a record, which calls for reconciliation, not an automatic
resend. The current rejection handling doesn't classify every VoApps response or
provide a complete remediation queue.

The integration doesn't select a compliant audience, manage suppression, or
enforce delivery windows for you. Configure and review those before any customer
campaign.

### Timestamps and call details

The VoApps timestamp is used when present; results `200`, `400`, `405`, `406`,
and `407` carry one. A blank timestamp uses the Result Parser's start time, which
isn't the exact webhook receipt time.

For a `200` result, a 12.9-second message is sent to HubSpot as 12,900
milliseconds; the tested call displayed `0:12`, and the details kept 12.9
seconds. Other terminal results keep the message duration in the details and
leave the call duration empty. No separate numeric duration property is created.

Reservations use the real account and record reference even with
`TEST_MODE = true`, so the sender and receiver agree on the same call. Test mode
labels the activity but doesn't create a separate deduplication namespace, so a
test reservation can block a later send to the same contact in the same campaign.
For a genuinely new send, use an intentionally new, approved campaign; never edit
the reference keys.

## Source files

Paste each file into the Custom code action with the same name. Every file runs
on Node.js 24.x.

| File | Action | Secrets | Configure |
|---|---|---|---|
| [`hubspot/send-voicemail.js`](../hubspot/send-voicemail.js) | Send Voicemail | `VOAPPS_API_KEY`, `HUBSPOT_DDVM_TOKEN` | `ACCOUNT_ID`, `MESSAGE_ID`, `CALLER_NUMBER`, `POSTBACK_URL`, `DEFAULT_CAMPAIGN_LABEL`, `SAVED_CAMPAIGN`, `DRY_RUN` |
| [`hubspot/result-parser.js`](../hubspot/result-parser.js) | Result Parser | none | none |
| [`hubspot/log-ddvm.js`](../hubspot/log-ddvm.js) | Log DDVM | `HUBSPOT_DDVM_TOKEN` | `ACCOUNT_ID`, `DRY_RUN`, `TEST_MODE` |

Test-only helpers live in [`hubspot/test-helpers/`](../hubspot/test-helpers/).
None of them is needed for routine operation:

| File | What it does |
|---|---|
| [`setup-outcomes.js`](../hubspot/test-helpers/setup-outcomes.js) | Read-only: lists call outcomes and checks that every result label resolves. |
| [`reservation-helper.js`](../hubspot/test-helpers/reservation-helper.js) | Creates one `[TEST]` queued call for the test contact under a synthetic campaign ID. Never calls VoApps. |
| [`replay-webhook.js`](../hubspot/test-helpers/replay-webhook.js) | Posts a synthetic Duplicate number result to your receiver URL. Sends no voicemail, but a live receiver can write a test call. |

The placeholders (`YOUR_ACCOUNT_ID`, `YOUR_HUBSPOT_WEBHOOK_URL`, and so on) make
each action stop before writing anything until you replace them. Never commit
your receiver URL, IDs, or keys.

## Passthrough fields

Any key in `record_attributes` that doesn't start with `voapps_` is a passthrough
field: VoApps doesn't use it for delivery and echoes it back unchanged under
`record.original_fields` in the result. This integration relies on that to carry
`account_number` (the contact's Record ID), `phone_number`, `message_name`,
`message_duration_seconds`, and `hubspot_call_id` through to the receiver. It
also echoes `voapps_send_reference`, as shown in the event properties above.

Phone format: E.164 (`+15551234567`) or 10-digit US. Don't put PII in
`voapps_voice_append` (text-to-speech).

Your VoApps cost is per voicemail delivered, however you send.
