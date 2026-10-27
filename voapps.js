'use strict';
/**
 * VoApps DirectDrop Voicemail - Direct Integration Kit
 * ----------------------------------------------------
 * A dependency-free Node.js (>=18) reference implementation of the same logic
 * the VoApps Zapier integration uses, so you can wire DirectDrop Voicemail into
 * your own application and skip Zapier's per-task costs at volume.
 *
 * Requires Node 18+ (uses global fetch, FormData, Blob, URL, URLSearchParams,
 * AbortSignal.timeout). No `npm install` needed. CommonJS; see README.md for ESM.
 *
 * Quick start:
 *   const { createClient } = require('./voapps');
 *   const voapps = createClient({ apiKey: process.env.VOAPPS_API_KEY, accountId: 12345 });
 *
 *   // Per-record send (find-or-create today's transactional campaign, then add one record):
 *   await voapps.sendVoicemail({
 *     number: '+15551234567', messageId: 678, callerNumber: '+18885551212',
 *     zip: '92563', accountNumber: 'CRM-1', label: '45+ DPD',
 *   });
 *
 *   // Daily batch (one transactional campaign seeded with many records = cheapest path):
 *   await voapps.createCampaign({
 *     label: '45+ DPD', messageId: 678, callerNumber: '+18885551212',
 *     records: [{ number: '+15551234567', voapps_zip_code: '92563', account_number: 'CRM-1' }],
 *   });
 *
 * Safety: new campaigns are created with confirm=true (they run) to preserve the
 * previous behavior. Pass confirm:false to createCampaign for a non-running
 * setup/test campaign that sends nothing - use that for dry runs.
 */

const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://directdropvoicemail.voapps.com/api/v1';
const DEFAULT_TZ = 'America/Los_Angeles';
// VoApps cuts days at a FIXED UTC-07:00 year-round (no DST) - per the Knowledge Base.
// The created_date filter that finds "today's" transactional campaign must line up with
// that cutoff, so the day boundary is anchored to UTC-07:00, not a DST-aware zone.
const VOAPPS_DAY_TZ = 'Etc/GMT+7'; // IANA sign is inverted: Etc/GMT+7 == UTC-07:00, fixed.
const VOAPPS_DAY_OFFSET = '-07:00';
const DEFAULT_TIMEOUT_MS = 30000;
// Campaign statuses that can still accept records today.
const USABLE_STATUSES = ['setup', 'importing', 'pending', 'running', 'paused'];

// ---------- naming helpers (match the Zapier action byte-for-byte) ----------

function tzOffset(tz, date) {
  const offMin = Math.round(
    (new Date(date.toLocaleString('en-US', { timeZone: tz })) -
      new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000
  );
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Localized ISO 8601 timestamp with offset + milliseconds, e.g. "2026-10-21T19:35:48.705-07:00". */
function localizedIso(tz = DEFAULT_TZ, date = new Date()) {
  const offset = tzOffset(tz, date);
  const base = date.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}${offset}`;
}

/** Stable campaign-name prefix for a label, up to (and including) the timestamp separator. */
function campaignNamePrefix(label) {
  return label ? `${label} | Transactional Campaign | ` : 'Transactional Campaign | ';
}

/** "<label> | Transactional Campaign | <ts>", or "Transactional Campaign | <ts>" when label is empty. */
function campaignName(label, tz = DEFAULT_TZ) {
  return `${campaignNamePrefix(label)}${localizedIso(tz)}`;
}

/**
 * VoApps day-boundary string for the created_date filter, at the fixed UTC-07:00 cutoff,
 * e.g. "2026-10-21 00:00:00 -07:00". Anchored to VoApps's day cutoff (not the client tz)
 * so "today's campaign" lookups match how VoApps groups campaigns by day.
 */
function localDayBoundary(date = new Date()) {
  const localDate = date.toLocaleDateString('en-CA', { timeZone: VOAPPS_DAY_TZ }); // YYYY-MM-DD at -07:00
  return `${localDate} 00:00:00 ${VOAPPS_DAY_OFFSET}`;
}

// ---------- CSV helper ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a VoApps bulk-import CSV from an array of record objects.
 * Recognized columns: number (or phone_number) - required on EVERY row - plus
 * voapps_zip_code, voapps_message_id, voapps_caller_number, voapps_voice_append,
 * voapps_postback_url, voapps_target_date. Any other keys (e.g. account_number)
 * are kept and echoed back in results.
 */
function recordsToCsv(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('recordsToCsv: records must be a non-empty array');
  }
  const columns = [];
  for (const r of records) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const hasNumberCol = columns.includes('number') || columns.includes('phone_number');
  if (!hasNumberCol) throw new Error('recordsToCsv: records need a "number" (or "phone_number") column');
  // Validate EVERY row has a usable number, not just that the column exists somewhere.
  records.forEach((r, i) => {
    const n = r.number ?? r.phone_number;
    if (n === undefined || n === null || String(n).trim() === '') {
      throw new Error(`recordsToCsv: row ${i} is missing a number/phone_number`);
    }
  });
  const header = columns.join(',');
  const rows = records.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...rows].join('\n');
}

// ---------- HTTP client ----------

function createClient({ apiKey, accountId, timezone = DEFAULT_TZ, baseUrl = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error('createClient: apiKey is required');
  if (!accountId) throw new Error('createClient: accountId is required');
  const authHeader = { Authorization: `Token token=${apiKey}` };
  const acct = `${baseUrl}/accounts/${accountId}`;

  async function request(method, path, { query, form, urlencoded } = {}) {
    const url = new URL(`${acct}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const headers = { ...authHeader };
    let body;
    if (form) {
      body = form; // FormData -> fetch sets multipart Content-Type + boundary automatically
    } else if (urlencoded) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(urlencoded);
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      // Timeout / network error. A POST may or may not have been accepted - do NOT blindly
      // retry writes; reconcile by campaign/record lookup instead.
      const err = new Error(`VoApps ${method} ${path} failed before a response (${cause && cause.name || 'NetworkError'}).`);
      err.code = cause && cause.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ENETWORK';
      err.cause = cause;
      err.retryable = method === 'GET'; // only idempotent reads are safe to retry automatically
      throw err;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : (data && data.error) || JSON.stringify(data);
      const err = new Error(`VoApps ${method} ${path} failed (HTTP ${res.status}). ${String(detail).slice(0, 300)}`);
      err.status = res.status;
      err.data = data;
      // 400 is a client error (fix the request); 5xx may be transient. The API does not issue 429.
      err.retryable = res.status >= 500;
      throw err;
    }
    return data;
  }

  /**
   * Create a transactional campaign (optionally seeded with a CSV or an array of records).
   * confirm defaults to true (the campaign RUNS). Pass confirm:false for a non-running
   * setup/test campaign that sends nothing.
   */
  async function createCampaign({ label, messageId, callerNumber, csv, records, targetDate, pace, confirm = true } = {}) {
    if (!messageId || !callerNumber) throw new Error('createCampaign: messageId and callerNumber are required');
    const form = new FormData();
    form.append('name', campaignName(label, timezone));
    form.append('message_id', String(messageId));
    form.append('caller_number', String(callerNumber)); // the phone number to display, NOT a caller-number id
    form.append('transactional', 'true');
    form.append('confirm', confirm ? 'true' : 'false');
    if (targetDate) form.append('target_date', targetDate);
    if (pace) form.append('pace', String(pace));
    const csvText = csv || (records ? recordsToCsv(records) : null);
    if (csvText) form.append('campaign_import', new Blob([csvText], { type: 'text/csv' }), 'import.csv');
    const data = await request('POST', '/campaigns', { form });
    return (data && data.campaign) || data;
  }

  async function listCampaigns(query) {
    const data = await request('GET', '/campaigns', { query });
    return (data && data.campaigns) || [];
  }

  async function getCampaign(campaignId) {
    const data = await request('GET', `/campaigns/${campaignId}`);
    return (data && data.campaign) || data;
  }

  /**
   * Find today's reusable transactional campaign FOR THIS LABEL, or null.
   * Only reuses a campaign whose name matches this label's prefix, so sends with a
   * different label never share a campaign. (Per-record message/caller overrides on
   * addRecord keep each record correct even when a campaign is reused.)
   */
  async function findTodaysCampaign(label) {
    const list = await listCampaigns({ created_date: localDayBoundary() });
    const prefix = campaignNamePrefix(label);
    const usable = list.filter(
      (c) => USABLE_STATUSES.includes(c.status) && String(c.name || '').startsWith(prefix)
    );
    if (usable.length <= 1) return usable[0] || null;
    // More than one usable campaign today for this label: pick the one whose target_date is closest to now.
    const t = Date.now();
    return usable.slice().sort(
      (a, b) => Math.abs(new Date(a.target_date).getTime() - t) - Math.abs(new Date(b.target_date).getTime() - t)
    )[0];
  }

  /** Reuse today's campaign for this label if present, else create one. Returns { id, name }. */
  async function findOrCreateTransactionalCampaign({ label, messageId, callerNumber, confirm } = {}) {
    const found = await findTodaysCampaign(label);
    if (found) return { id: found.id, name: found.name };
    const c = await createCampaign({ label, messageId, callerNumber, confirm });
    return { id: c.id, name: c.name };
  }

  /** Add one record to a specific campaign. Returns the created record. */
  async function addRecord(campaignId, {
    number, zip, messageId, callerNumber, voiceAppend, postbackUrl, targetDate, accountNumber, fields,
  } = {}) {
    if (!number) throw new Error('addRecord: number is required');
    // Start from arbitrary passthrough fields, then set protected fields LAST so a stray
    // key in `fields` can never clobber the real number or a voapps_* override.
    const attrs = { ...(fields || {}) };
    attrs.number = number;
    if (zip) attrs.voapps_zip_code = zip;
    if (messageId) attrs.voapps_message_id = messageId;
    if (callerNumber) attrs.voapps_caller_number = callerNumber;
    if (voiceAppend) attrs.voapps_voice_append = voiceAppend;
    if (postbackUrl) attrs.voapps_postback_url = postbackUrl;
    if (targetDate) attrs.voapps_target_date = targetDate;
    if (accountNumber) attrs.account_number = accountNumber; // echoed back in results for tie-back
    const data = await request('POST', `/campaigns/${campaignId}/records`, {
      urlencoded: { record_attributes: JSON.stringify(attrs) },
    });
    return (data && data.record) ? data.record : data;
  }

  /** Get one record (including its delivery result) by campaign + record id. */
  async function getRecord(campaignId, recordId) {
    const data = await request('GET', `/campaigns/${campaignId}/records/${recordId}`);
    return (data && data.record) || data;
  }

  /**
   * Per-record send: find-or-create today's transactional campaign for this label, then add the
   * record WITH its message/caller as per-record overrides - so even if an existing campaign is
   * reused, this record still goes out with the intended message and caller number.
   * messageId + callerNumber are required (also needed to create the campaign if none exists today).
   * Returns { record, campaign_id, campaign_name }.
   */
  async function sendVoicemail({
    number, zip, messageId, callerNumber, label, voiceAppend, postbackUrl, targetDate, accountNumber, fields, confirm,
  } = {}) {
    if (!number) throw new Error('sendVoicemail: number is required');
    if (!messageId || !callerNumber) throw new Error('sendVoicemail: messageId and callerNumber are required');
    let campaign = await findOrCreateTransactionalCampaign({ label, messageId, callerNumber, confirm });
    // Always carry messageId/callerNumber as per-record overrides (fixes wrong-message-on-reuse).
    const payload = { number, zip, messageId, callerNumber, voiceAppend, postbackUrl, targetDate, accountNumber, fields };
    try {
      const record = await addRecord(campaign.id, payload);
      return { record, campaign_id: campaign.id, campaign_name: campaign.name };
    } catch (err) {
      // If the reused campaign is no longer accepting records, create a fresh one and retry once.
      if (/no longer running|not running|not accepting|is (completed|canceled|cancelled|archived|closed)/i.test(err.message || '')) {
        const c = await createCampaign({ label, messageId, callerNumber, confirm });
        campaign = { id: c.id, name: c.name };
        const record = await addRecord(campaign.id, payload);
        return { record, campaign_id: campaign.id, campaign_name: campaign.name };
      }
      throw err;
    }
  }

  /**
   * Fetch a campaign's results export (the presigned S3 `export` URL from getCampaign).
   * Deliberately sends NO Authorization header: the VoApps token must not be forwarded to S3,
   * and the presigned URL is already authenticated and short-lived. Returns the raw CSV text.
   */
  async function fetchExport(exportUrl) {
    const u = new URL(exportUrl);
    if (u.protocol !== 'https:') throw new Error('fetchExport: export URL must be https');
    const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) }); // no auth header on purpose
    if (!res.ok) throw new Error(`fetchExport: HTTP ${res.status} fetching export`);
    return res.text();
  }

  return {
    accountId,
    timezone,
    request,
    createCampaign,
    listCampaigns,
    getCampaign,
    findTodaysCampaign,
    findOrCreateTransactionalCampaign,
    addRecord,
    getRecord,
    sendVoicemail,
    fetchExport,
  };
}

// ---------- postback (webhook) signature verification ----------

/**
 * Verify a VoApps postback HMAC signature (optional security enhancement; signing is
 * opt-in per organization).
 *
 * VoApps signs `${timestamp}.${destination}.${rawBody}` with HMAC-SHA256 and your
 * org signing secret, and sends:
 *   X-VoApps-Signature:   v1=<hex>
 *   X-VoApps-Timestamp:   <unix seconds>
 *   X-VoApps-Destination: <the postback URL it was sent to, exactly as given in the record>
 *
 * Pass the value of the X-VoApps-Destination header through verbatim as `destination`
 * (do not reconstruct it), and the EXACT raw request body (not a re-serialized object)
 * as rawBody. Returns true only if the signature matches and the timestamp is fresh.
 */
function verifyPostbackSignature({
  signingSecret, timestamp, destination, rawBody, signatureHeader, toleranceSeconds = 300,
}) {
  if (!signingSecret) throw new Error('verifyPostbackSignature: signingSecret is required');
  if (!signatureHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  const expected = 'v1=' + crypto.createHmac('sha256', signingSecret)
    .update(`${timestamp}.${destination}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  createClient,
  verifyPostbackSignature,
  recordsToCsv,
  campaignName,
  campaignNamePrefix,
  localizedIso,
  localDayBoundary,
  DEFAULT_BASE,
  DEFAULT_TZ,
  VOAPPS_DAY_TZ,
  VOAPPS_DAY_OFFSET,
  USABLE_STATUSES,
};
