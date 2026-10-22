'use strict';
/**
 * VoApps DirectDrop Voicemail - Direct Integration Kit
 * ----------------------------------------------------
 * A dependency-free Node.js (>=18) reference implementation of the same logic
 * the VoApps Zapier integration uses, so you can wire DirectDrop Voicemail into
 * your own application and skip Zapier's per-task costs at volume.
 *
 * Requires Node 18+ (uses global fetch, FormData, Blob, URL, URLSearchParams).
 * No `npm install` needed. CommonJS; see README.md for an ESM version.
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
 */

const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://directdropvoicemail.voapps.com/api/v1';
const DEFAULT_TZ = 'America/Los_Angeles';
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

/** "<label> | Transactional Campaign | <ts>", or "Transactional Campaign | <ts>" when label is empty. */
function campaignName(label, tz = DEFAULT_TZ) {
  const prefix = label ? `${label} | ` : '';
  return `${prefix}Transactional Campaign | ${localizedIso(tz)}`;
}

/** Local day-boundary string for the created_date filter, e.g. "2026-10-21 00:00:00 -07:00". */
function localDayBoundary(tz = DEFAULT_TZ, date = new Date()) {
  const localDate = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  return `${localDate} 00:00:00 ${tzOffset(tz, date)}`;
}

// ---------- CSV helper ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a VoApps bulk-import CSV from an array of record objects.
 * Recognized columns: number (required), voapps_zip_code, voapps_message_id,
 * voapps_caller_number, voapps_voice_append, voapps_postback_url, voapps_target_date.
 * Any other keys (e.g. account_number) are kept and echoed back in results.
 */
function recordsToCsv(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('recordsToCsv: records must be a non-empty array');
  }
  const columns = [];
  for (const r of records) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  if (!columns.includes('number')) throw new Error('recordsToCsv: every record needs a "number"');
  const header = columns.join(',');
  const rows = records.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...rows].join('\n');
}

// ---------- HTTP client ----------

function createClient({ apiKey, accountId, timezone = DEFAULT_TZ, baseUrl = DEFAULT_BASE } = {}) {
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
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      const err = new Error(`VoApps ${method} ${path} failed (HTTP ${res.status}). ${String(detail).slice(0, 300)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** Create a transactional campaign (optionally seeded with a CSV or an array of records). */
  async function createCampaign({ label, messageId, callerNumber, csv, records, targetDate, pace } = {}) {
    if (!messageId || !callerNumber) throw new Error('createCampaign: messageId and callerNumber are required');
    const form = new FormData();
    form.append('name', campaignName(label, timezone));
    form.append('message_id', String(messageId));
    form.append('caller_number', String(callerNumber)); // the phone number to display, NOT a caller-number id
    form.append('transactional', 'true');
    form.append('confirm', 'true');
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

  /** Find today's reusable transactional campaign, or null. */
  async function findTodaysCampaign() {
    const list = await listCampaigns({ created_date: localDayBoundary(timezone) });
    const usable = list.filter((c) => USABLE_STATUSES.includes(c.status));
    if (usable.length <= 1) return usable[0] || null;
    // More than one usable campaign today: pick the one whose target_date is closest to now.
    const t = Date.now();
    return usable.slice().sort(
      (a, b) => Math.abs(new Date(a.target_date).getTime() - t) - Math.abs(new Date(b.target_date).getTime() - t)
    )[0];
  }

  /** Reuse today's campaign if present, else create one. Returns { id, name }. */
  async function findOrCreateTransactionalCampaign({ label, messageId, callerNumber } = {}) {
    const found = await findTodaysCampaign();
    if (found) return { id: found.id, name: found.name };
    const c = await createCampaign({ label, messageId, callerNumber });
    return { id: c.id, name: c.name };
  }

  /** Add one record to a specific campaign. Returns the created record. */
  async function addRecord(campaignId, {
    number, zip, messageId, callerNumber, voiceAppend, postbackUrl, targetDate, accountNumber, fields,
  } = {}) {
    if (!number) throw new Error('addRecord: number is required');
    const attrs = { number };
    if (zip) attrs.voapps_zip_code = zip;
    if (messageId) attrs.voapps_message_id = messageId;
    if (callerNumber) attrs.voapps_caller_number = callerNumber;
    if (voiceAppend) attrs.voapps_voice_append = voiceAppend;
    if (postbackUrl) attrs.voapps_postback_url = postbackUrl;
    if (targetDate) attrs.voapps_target_date = targetDate;
    if (accountNumber) attrs.account_number = accountNumber; // echoed back in results for tie-back
    if (fields) Object.assign(attrs, fields);
    const data = await request('POST', `/campaigns/${campaignId}/records`, {
      urlencoded: { record_attributes: JSON.stringify(attrs) },
    });
    return (data && data.record) ? data.record : data;
  }

  /**
   * Per-record send: find-or-create today's transactional campaign, then add the record.
   * messageId + callerNumber are required (needed to create the campaign if none exists today).
   * Returns { record, campaign_id, campaign_name }.
   */
  async function sendVoicemail({
    number, zip, messageId, callerNumber, label, voiceAppend, postbackUrl, targetDate, accountNumber, fields,
  } = {}) {
    if (!number) throw new Error('sendVoicemail: number is required');
    if (!messageId || !callerNumber) throw new Error('sendVoicemail: messageId and callerNumber are required');
    let campaign = await findOrCreateTransactionalCampaign({ label, messageId, callerNumber });
    const payload = { number, zip, voiceAppend, postbackUrl, targetDate, accountNumber, fields };
    try {
      const record = await addRecord(campaign.id, payload);
      return { record, campaign_id: campaign.id, campaign_name: campaign.name };
    } catch (err) {
      // If the reused campaign is no longer accepting records, create a fresh one and retry once.
      if (/no longer running|not running|not accepting|is (completed|canceled|cancelled|archived|closed)/i.test(err.message || '')) {
        const c = await createCampaign({ label, messageId, callerNumber });
        campaign = { id: c.id, name: c.name };
        const record = await addRecord(campaign.id, payload);
        return { record, campaign_id: campaign.id, campaign_name: campaign.name };
      }
      throw err;
    }
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
    sendVoicemail,
  };
}

// ---------- postback (webhook) signature verification ----------

/**
 * Verify a VoApps postback HMAC signature (optional security enhancement).
 *
 * VoApps signs `${timestamp}.${destination}.${rawBody}` with HMAC-SHA256 and your
 * org signing secret, and sends:
 *   X-VoApps-Signature: v1=<hex>
 *   X-VoApps-Timestamp: <unix seconds>
 *   X-VoApps-Destination: <the destination phone number>
 *
 * Pass the EXACT raw request body (not a re-serialized object) as rawBody.
 * Returns true only if the signature matches and the timestamp is fresh.
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
  localizedIso,
  localDayBoundary,
  DEFAULT_BASE,
  DEFAULT_TZ,
  USABLE_STATUSES,
};
