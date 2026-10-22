# Send DirectDrop Voicemail from HubSpot (Zapier)

Connect HubSpot to VoApps DirectDrop Voicemail (DDVM) with Zapier, no code
required. This guide covers sending a voicemail when a contact qualifies, sending
in a daily batch at volume, and logging each delivery result back onto the
contact in HubSpot.

Prefer to integrate in your own code instead? See the
[developer (direct API) path](../README.md).

## Before you start

- **Get access to the VoApps Zapier integration.** It is private and available by
  invite. Request access by emailing **support@voapps.com**; VoApps will send you
  an invite link.
- **A Zapier account.** These are multi-step Zaps, which require a paid Zapier
  plan (Professional or higher) to turn on. You can build and test every step on a
  free plan first.
- **In VoApps, have a Message and a Caller Number ready.** The Message is the
  voicemail audio; the Caller Number is the caller ID that displays. Your Zap
  selects these from dropdowns.

## Connect VoApps in Zapier

When you add a VoApps step to a Zap for the first time, choose **Connect a new
account** and paste your VoApps **API key**. That is all VoApps needs; there is no
password step.

## What you can send

Only a **phone number** is strictly required per contact. Strongly recommended:

- **Zip code** (improves the delivery window and timezone safety).
- A **reference id** for tie-back. Use the HubSpot **Contact ID** (`hs_object_id`,
  shown in Zapier as "Object ID"). VoApps returns it untouched on the delivery
  result so you can match the result back to the right contact.

## Pattern A: Send a voicemail per contact (event-driven)

Best when you want to drop a voicemail as soon as a contact meets a condition.

1. **Trigger (HubSpot).** Pick the event that defines your audience, for example:
   - *Contact Enters a List* (a HubSpot active list), or
   - *Contact Property Change* (for example a status field changes), or
   - a HubSpot **Workflow** with a "Trigger a Zap" / webhook action.
2. **Action: VoApps > Send Voicemail.** Map:
   - **Account** (your VoApps account).
   - **Phone Number** (required): the contact's phone, E.164 like `+15551234567`
     or 10-digit US.
   - **Message** (required) and **Caller Number** (required): choose from the
     dropdowns. These are also used to create the day's campaign.
   - **Zip Code** (recommended): the contact's postal code.
   - **Account / Reference #** (recommended): map the HubSpot **Object ID**
     (Contact ID). It comes back on the result for tie-back.
   - **Campaign Label** (optional): a use-case name like `45+ DPD`.
3. Done. Send Voicemail automatically finds or creates **today's transactional
   campaign** and adds the record. It returns **Campaign ID** and **Campaign
   Name** (used for logging, below).

> Each contact is one Zapier task. At higher volume, use Pattern B.

## Pattern B: Daily batch (one campaign, many records)

Best at volume. It collects everyone who qualifies that day and sends them in one
campaign, which keeps Zapier task usage tiny (about two tasks per day no matter
how many contacts).

1. **Trigger: Schedule by Zapier**, once per day at your send time.
2. **Action: Code by Zapier (Run JavaScript).** Query HubSpot for all contacts
   matching your criteria (the CRM Search API pages through results inside this
   one step, which still counts as a single task), and output one CSV string with
   columns `number,voapps_zip_code,account_number`.
3. **Action: VoApps > Create Campaign.** Set **Message** and **Caller Number**,
   paste the CSV from step 2 into **Bulk Records (CSV)**, and optionally set a
   **Campaign Name** label. The campaign is created transactional and launched
   automatically.

> Developers who would rather not build the Code step can run the batch from the
> [direct API kit](../README.md) instead.

## Log delivery results back into HubSpot

VoApps posts each voicemail's **final** result (delivered, expired, failed, and so
on) to a postback URL. Results fire only on final outcomes, never while pending.

**Result codes:** `200` delivered, `300` expired, `301` canceled, `400`-`410`
failed/invalid, `500`-`504` restricted.

### Option 1 (recommended): real-time via webhook

1. **Trigger: VoApps > New Delivery Result** (instant). Copy the webhook URL it
   gives you.
2. Paste that URL into the **Postback URL** field on your Send Voicemail step (or
   set it as your campaign/account default), so results flow to this Zap.
3. **Action: HubSpot.** Match the contact by the returned **Account / Reference #**
   (the Contact ID you sent), then either:
   - **Create Engagement** to log a **Call** on the contact with the delivery
     status, or
   - **Create or Update Contact** to set a custom property such as
     `Last DDVM Result`.

### Option 2: end-of-day reconciliation (safety net)

On a daily schedule, use **VoApps > Get Campaign Results** for the day's campaign
to pull every record's outcome, then update HubSpot. Useful to catch any result a
webhook missed.

## Verify postbacks (optional security)

If your VoApps org enables signing, each postback includes an HMAC signature
header. Verifying it confirms the result genuinely came from VoApps. Zapier cannot
verify signatures on its own; if you need this, receive postbacks in your own
endpoint using the verification code in the
[direct API kit](../README.md) (Node and Python), then forward to HubSpot.

## Tips

- Only a phone number is required; zip and a reference id are strongly
  recommended for delivery-window safety and tie-back.
- Do not put PII in the **Voice Append** (TTS) field.
- Multi-step Zaps need a paid Zapier plan to turn on.
- Your VoApps cost is per voicemail delivered and is the same whether you send per
  contact or in a daily batch.
