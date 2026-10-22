# Send DirectDrop Voicemail from Iterable (Zapier)

Connect Iterable to VoApps DirectDrop Voicemail (DDVM) with Zapier, no code
required. This guide covers sending a voicemail when a user reaches a point in an
Iterable journey, sending in a daily batch at volume, and logging each delivery
result back onto the user in Iterable.

Prefer to integrate in your own code instead? See the
[developer (direct API) path](../README.md).

## Before you start

- **Get access to the VoApps Zapier integration.** It is private and available by
  invite. Request access by emailing **support@voapps.com**; VoApps will send you
  an invite link.
- **A Zapier account.** These are multi-step Zaps, which require a paid Zapier
  plan (Professional or higher) to turn on. The Iterable trigger below uses
  *Webhooks by Zapier*, which is also a paid (Premium) Zapier app. You can build
  and test every step on a free plan first.
- **In VoApps, have a Message and a Caller Number ready.** The Message is the
  voicemail audio; the Caller Number is the caller ID that displays. Your Zap
  selects these from dropdowns.

## Connect VoApps in Zapier

When you add a VoApps step to a Zap for the first time, choose **Connect a new
account** and paste your VoApps **API key**. That is all VoApps needs; there is no
password step.

## What you can send

Only a **phone number** is strictly required per user. Strongly recommended:

- **Zip code** (improves the delivery window and timezone safety).
- A **reference id** for tie-back. Use the Iterable **userId** (or email). VoApps
  returns it untouched on the delivery result so you can match the result back to
  the right user.

Make sure the users you target have a **phone number** field in Iterable (and zip
if you want delivery-window safety).

## Pattern A: Send a voicemail from an Iterable journey (event-driven)

Iterable triggers Zapier most reliably through a webhook in a journey or workflow.

1. **In Zapier, create the trigger: Webhooks by Zapier > Catch Hook.** Zapier
   gives you a unique webhook URL. Copy it.
2. **In Iterable, add a Webhook action** at the point in your Journey (or
   Workflow) where the user should receive a voicemail. Point it at the Catch Hook
   URL and include the fields you need in the payload: `phone`, `zip`, and the
   `userId` (or `email`). Send one test through so Zapier can read the fields.
3. **Action: VoApps > Send Voicemail.** Map:
   - **Account** (your VoApps account).
   - **Phone Number** (required): the phone from the webhook payload, E.164 like
     `+15551234567` or 10-digit US.
   - **Message** (required) and **Caller Number** (required): choose from the
     dropdowns. These are also used to create the day's campaign.
   - **Zip Code** (recommended): from the payload.
   - **Account / Reference #** (recommended): map the Iterable **userId** (or
     email). It comes back on the result for tie-back.
   - **Campaign Label** (optional): a use-case name like `Winback`.
4. Done. Send Voicemail automatically finds or creates **today's transactional
   campaign** and adds the record. It returns **Campaign ID** and **Campaign
   Name** (used for logging, below).

> Each user is one Zapier task. At higher volume, use Pattern B.

## Pattern B: Daily batch (one campaign, many records)

Best at volume. It collects everyone who qualifies that day and sends them in one
campaign, which keeps Zapier task usage tiny (about two tasks per day no matter
how many users).

1. **Trigger: Schedule by Zapier**, once per day at your send time.
2. **Action: Code by Zapier (Run JavaScript).** Pull the day's audience from
   Iterable (for example via the Iterable API, or an exported list), and output
   one CSV string with columns `number,voapps_zip_code,account_number`.
3. **Action: VoApps > Create Campaign.** Set **Message** and **Caller Number**,
   paste the CSV from step 2 into **Bulk Records (CSV)**, and optionally set a
   **Campaign Name** label. The campaign is created transactional and launched
   automatically.

> Developers who would rather not build the Code step can run the batch from the
> [direct API kit](../README.md) instead.

## Log delivery results back into Iterable

VoApps posts each voicemail's **final** result (delivered, expired, failed, and so
on) to a postback URL. Results fire only on final outcomes, never while pending.

**Result codes:** `200` delivered, `300` expired, `301` canceled, `400`-`410`
failed/invalid, `500`-`504` restricted.

### Option 1 (recommended): real-time via webhook

1. **Trigger: VoApps > New Delivery Result** (instant). Copy the webhook URL it
   gives you.
2. Paste that URL into the **Postback URL** field on your Send Voicemail step (or
   set it as your campaign/account default), so results flow to this Zap.
3. **Action: Iterable.** Match the user by the returned **Account / Reference #**
   (the userId or email you sent), then either:
   - **Update User** to set a custom user field such as `lastDdvmResult`, or
   - **Track Event** to record a custom event like `ddvm_result` with the status,
     so it is usable in journeys and analytics.

### Option 2: end-of-day reconciliation (safety net)

On a daily schedule, use **VoApps > Get Campaign Results** for the day's campaign
to pull every record's outcome, then update Iterable. Useful to catch any result
a webhook missed.

## Verify postbacks (optional security)

If your VoApps org enables signing, each postback includes an HMAC signature
header. Verifying it confirms the result genuinely came from VoApps. Zapier cannot
verify signatures on its own; if you need this, receive postbacks in your own
endpoint using the verification code in the
[direct API kit](../README.md) (Node and Python), then forward to Iterable.

## Tips

- Only a phone number is required; zip and a reference id are strongly
  recommended for delivery-window safety and tie-back.
- Do not put PII in the **Voice Append** (TTS) field.
- Multi-step Zaps, and the Webhooks by Zapier trigger, need a paid Zapier plan.
- Your VoApps cost is per voicemail delivered and is the same whether you send per
  user or in a daily batch.
