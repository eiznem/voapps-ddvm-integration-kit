'use strict';
/**
 * Minimal postback (webhook) receiver for VoApps DirectDrop Voicemail delivery results.
 *
 *   npm install express
 *   VOAPPS_SIGNING_SECRET=... node postback_server.example.js
 *
 * Point your VoApps postback URL (or the Send Voicemail "Postback URL" field) at
 *   https://your-host/voapps/postback
 *
 * Postbacks fire only on FINAL result codes (delivered/expired/failed/restricted),
 * never while a record is pending/running. VoApps expects a 200 within ~5 seconds
 * and retries a few times otherwise, so acknowledge fast and do slow work async.
 */

const express = require('express');
const { verifyPostbackSignature } = require('./voapps');

const app = express();

// Capture the RAW body - signature verification needs the exact received bytes.
app.use(express.raw({ type: '*/*' }));

const SIGNING_SECRET = process.env.VOAPPS_SIGNING_SECRET; // leave unset if your org has not enabled signing

app.post('/voapps/postback', (req, res) => {
  const rawBody = req.body.toString('utf8');

  // If signing is enabled, verify. If you have NOT enabled org signing, you can
  // skip this block - but then you cannot cryptographically trust the sender.
  if (SIGNING_SECRET) {
    const ok = verifyPostbackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: req.get('X-VoApps-Timestamp'),
      destination: req.get('X-VoApps-Destination'),
      rawBody,
      signatureHeader: req.get('X-VoApps-Signature'),
    });
    if (!ok) return res.status(401).send('invalid signature');
  }

  let result;
  try {
    result = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('bad json');
  }

  const record = result.record || result;
  // Fields of interest:
  //   record.account_number        -> your tie-back reference (what you sent)
  //   record.phone_number / number -> the destination
  //   record.delivery_status       -> human-readable status
  //   record.delivery_status_code  -> 200 delivered, 300 expired, 301 canceled,
  //                                   400-410 failed/invalid, 500-504 restricted
  //   record.voapps_timestamp      -> when the result was produced
  console.log('VoApps result',
    record.account_number, record.delivery_status, record.delivery_status_code);

  // Acknowledge immediately, then do CRM work without blocking the response.
  res.status(200).send('ok');

  setImmediate(() => {
    // TODO: update your CRM (log a call, stamp the delivery status, etc.).
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`VoApps postback receiver listening on :${port}`));
