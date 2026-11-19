/* Node.js 24.x. Parse only: no API requests, secrets, or CRM writes.
 * Inputs: delivery_status, delivery_status_code, voapps_record_id,
 * contact_id, phone_number, caller_number, message_id, voapps_timestamp.
 * Output definitions to add in HubSpot:
 * call_timestamp: String (UTC ISO 8601)
 * timestamp_source: String
 * result_summary: String
 * voapps_record_key: String
 * Blank timestamp fallback is action-start time, NOT webhook receipt time.
 * Present but malformed timestamps fail instead of silently changing the time.
 */
exports.main = async (event) => {
  const actionStartedAt = new Date().toISOString();
  const f = event.inputFields || {};
  const text = v => v == null ? '' : String(v).trim();
  const contactId = text(f.contact_id);
  const recordId = text(f.voapps_record_id);
  const status = text(f.delivery_status);
  const codeText = text(f.delivery_status_code);
  if (!/^\d+$/.test(contactId)) throw new Error('Missing or invalid contact_id.');
  if (!/^\d+$/.test(recordId)) throw new Error('Missing or invalid voapps_record_id.');
  if (!/^\d+$/.test(codeText) || !status) throw new Error('Missing delivery status or numeric result code.');

  const raw = text(f.voapps_timestamp);
  let timestamp = actionStartedAt;
  let source = 'action_start_fallback';
  if (raw) {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(UTC|Z|[+-]\d{2}:\d{2})$/);
    if (!m) throw new Error('Unexpected VoApps timestamp format; expected explicit UTC or offset.');
    const [, y, mo, d, h, mi, s, zone] = m;
    const year = Number(y), month = Number(mo), day = Number(d);
    const hour = Number(h), minute = Number(mi), second = Number(s);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
      throw new Error('Invalid calendar date or clock time in VoApps timestamp.');
    }
    const offset = zone === 'UTC' || zone === 'Z' ? 'Z' : zone;
    if (offset !== 'Z' && (Number(offset.slice(1,3)) > 14 || Number(offset.slice(4,6)) > 59 || (Number(offset.slice(1,3)) === 14 && Number(offset.slice(4,6)) !== 0))) {
      throw new Error('Invalid timezone offset in VoApps timestamp.');
    }
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
    if (!Number.isFinite(ms)) throw new Error('Unable to parse VoApps timestamp.');
    timestamp = new Date(ms).toISOString();
    source = 'voapps_timestamp';
  }

  const summary = [
    `VoApps DirectDrop Voicemail result: ${status} (${codeText})`,
    `VoApps record: ${recordId}`,
    `Contact reference: ${contactId}`,
    `Destination: ${text(f.phone_number) || 'Not supplied'}`,
    `Caller number: ${text(f.caller_number) || 'Not supplied'}`,
    `Message: ${text(f.message_id) || 'Not supplied'}`,
    `Activity time (UTC): ${timestamp}`,
    `Time source: ${source === 'voapps_timestamp' ? 'VoApps result timestamp' : 'Action-start fallback; not webhook receipt time'}`,
    `Original VoApps timestamp: ${raw || 'Not supplied'}`
  ].join('\n');

  return { outputFields: {
    call_timestamp: timestamp,
    timestamp_source: source,
    result_summary: summary,
    voapps_record_key: recordId
  }};
};
