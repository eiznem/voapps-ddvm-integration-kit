/* Log DDVM - Node.js 24.x. Reservation-aware result logger.
 * Secret: HUBSPOT_DDVM_TOKEN. Never sends a voicemail.
 * DRY_RUN=true previews; false permits CRM writes.
 * TEST_MODE labels activities. With reservation fields it uses the real account:record
 * reference to match the sender; without reservation fields it uses a test-prefixed key.
 * Validates reservation send reference and contact association before updating that call.
 * Retains the legacy no-reservation create path; review its production use.
 * Call duration only for 200; message duration remains in details for all terminal results.
 * Contact-owner assignment; no creator or caller-name override.
 * Sequential reserved-call update and duplicate handling were tested; failure/concurrency
 * scenarios remain to be validated. Do not delete unique-reference tracking calls.
 */
const axios = require('axios');
const DRY_RUN = true;
const TEST_MODE = true;
const REFERENCE_PROPERTY = 'voapps_submission_reference';
const ACCOUNT_ID = 'YOUR_ACCOUNT_ID';  // same VoApps account as the sender
const CALL_TYPE = 'VoApps DirectDrop Voicemail';
const RESULTS = {
  '200':'Successfully delivered','300':'Expired','301':'Canceled',
  '400':'Unsuccessful delivery attempt','401':'Not a wireless number',
  '402':'Duplicate number','403':'Not a valid US number','404':'Undeliverable',
  '405':'Not in service','406':'Voicemail not setup','407':'Voicemail full',
  '408':'Invalid caller number','409':'Invalid message id',
  '410':'Prohibited self call','500':'Restricted','501':'Restricted for frequency',
  '502':'Restricted geographical region','503':'Restricted individual number',
  '504':'Restricted WebRecon'
};
const text = v => v == null ? '' : String(v).trim();
const escapeHtml = value => text(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finish = (status, details, callId = '') => ({outputFields:{
  logging_status:status, hubspot_call_id:text(callId), logging_details:JSON.stringify(details)
}});
function normalizePhone(value) {
  const raw = text(value), digits = raw.replace(/\D/g,'');
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  // Preserve other original representations for unsuccessful/invalid-number results.
  return raw;
}
exports.main = async event => {
  if (!/^\d+$/.test(ACCOUNT_ID)) throw new Error('Configure ACCOUNT_ID. No call created.');
  const f = event.inputFields || {};
  const code = text(f.delivery_status_code);
  if (code === '100' || code === '101') {
    return finish('interim_result_skipped',{code,reason:'No completed call for Pending or Running.'});
  }
  if (!RESULTS[code]) return finish('review_required',{code,reason:'Unknown result code; no outcome guessed.'});
  const contactId = text(f.contact_id), recordId = text(f.voapps_record_id);
  if (!/^\d+$/.test(contactId) || !/^\d+$/.test(recordId)) {
    throw new Error('Contact ID and VoApps record ID must both be present numeric identifiers.');
  }
  const timestamp = text(f.call_timestamp), source = text(f.timestamp_source);
  // Parser returns ISO UTC. Do not introduce a second, later fallback here.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error('Map call_timestamp to the validated UTC output from Result Parser.');
  }
  if (!['voapps_timestamp','action_start_fallback'].includes(source)) {
    throw new Error('Map timestamp_source to Result Parser; unexpected timestamp source.');
  }
  const phone = normalizePhone(f.phone_number), caller = normalizePhone(f.caller_number);
  if (!phone || !caller) throw new Error('Destination and caller number are required.');
  const token = process.env.HUBSPOT_DDVM_TOKEN;
  if (!token) throw new Error('Attach HUBSPOT_DDVM_TOKEN.');
  const api = axios.create({baseURL:'https://api.hubapi.com',headers:{Authorization:`Bearer ${token}`},timeout:2500});
  let outcomes;
  try { outcomes = (await api.get('/calling/v1/dispositions')).data; }
  catch (e) { throw new Error(`Outcome lookup failed (HTTP ${e.response?.status || 'network'}). No call created.`); }
  if (!Array.isArray(outcomes)) throw new Error('Unexpected outcome response. No call created.');
  const matches = outcomes.filter(o => text(o.label) === RESULTS[code]);
  if (matches.length !== 1 || !text(matches[0].id)) {
    return finish('review_required',{code,reason:'Expected exactly one outcome with the exact VoApps result label.'});
  }
  // Read the target first to catch incorrect references without changing records.
  let contact;
  try { contact = (await api.get(`/crm/v3/objects/contacts/${contactId}`,{params:{properties:'hs_object_id,hubspot_owner_id'}})).data; }
  catch (e) { throw new Error(`Contact validation failed (HTTP ${e.response?.status || 'network'}). No call created.`); }
  // Read-only checks: fail closed if unique enforcement or call type is unavailable.
  let referenceSchema, typeSchema;
  try {
    const responses = await Promise.all([
      api.get(`/crm/v3/properties/calls/${REFERENCE_PROPERTY}`),
      api.get('/crm/v3/properties/calls/hs_activity_type')
    ]);
    referenceSchema = responses[0].data;
    typeSchema = responses[1].data;
  } catch(e) {
    throw new Error(`Call property validation failed (HTTP ${e.response?.status || 'network'}). No call created. Check property access before changing scopes.`);
  }
  if (referenceSchema.hasUniqueValue !== true || referenceSchema.type !== 'string' || referenceSchema.archived) {
    throw new Error('Submission reference must be an active unique text call property. No call created.');
  }
  const typeMatches = (typeSchema.options || []).filter(o => !o.hidden && text(o.label) === CALL_TYPE);
  if (typeMatches.length !== 1) throw new Error('Expected exactly one configured call type matching VoApps DirectDrop Voicemail. No call created.');
  const messageName = text(f.message_name);
  const durationText = text(f.message_duration_seconds);
  const durationSeconds = Number(durationText);
  if (!messageName || !durationText || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Message name and positive message_duration_seconds are required. No call created.');
  }
  const callStatus = ['200','400','405','406','407'].includes(code) ? 'COMPLETED'
    : ['408','409','410'].includes(code) ? 'FAILED' : 'CANCELED';
  // Validate the selected status against the live portal property before writing.
  let statusSchema;
  try { statusSchema = (await api.get('/crm/v3/properties/calls/hs_call_status')).data; }
  catch(e) { throw new Error(`Call status validation failed (HTTP ${e.response?.status || 'network'}). No call created.`); }
  if (!(statusSchema.options || []).some(o=>!o.hidden && o.value===callStatus)) {
    throw new Error('Mapped call status is not available in the portal. No call created.');
  }
  const ownerId = text(contact.properties?.hubspot_owner_id);
  const reservedCallId = text(f.hubspot_call_id);
  const sendReference = text(f.voapps_send_reference);
  const hasReservation = Boolean(reservedCallId || sendReference);
  if (hasReservation && (!/^\d+$/.test(reservedCallId) ||
      !(sendReference.split(':').length===3 && sendReference.split(':')[0]===ACCOUNT_ID && /^\d+$/.test(sendReference.split(':')[1]) && sendReference.split(':')[2]===contactId))) {
    throw new Error('Reservation call ID and account:campaign:contact reference must both be valid.');
  }
  // A reservation uses the production record reference, including during a labeled
  // test, because the sender also stores that reference after acceptance.
  const recordKey = `${!hasReservation && TEST_MODE ? 'test:' : ''}${ACCOUNT_ID}:${recordId}`;
  let reservedCall;
  if (hasReservation) {
    try {
      reservedCall = (await api.get(`/crm/v3/objects/calls/${reservedCallId}`,{params:{
        properties:`voapps_send_reference,${REFERENCE_PROPERTY},hs_call_disposition,hs_call_status`,
        associations:'contacts'}})).data;
    } catch (_) { throw new Error('Cannot validate reserved call. No replacement call will be created.'); }
    const linked = reservedCall.associations?.contacts?.results || [];
    if (text(reservedCall.properties?.voapps_send_reference)!==sendReference ||
        !linked.some(c=>text(c.id)===contactId))
      throw new Error('Reserved call does not match send reference/contact. No changes made.');
    const existingReference = text(reservedCall.properties?.[REFERENCE_PROPERTY]);
    if (existingReference && existingReference!==recordKey)
      throw new Error('Reservation is already linked to a different VoApps record. Stop for review.');
    const existingOutcome = text(reservedCall.properties?.hs_call_disposition);
    if (existingOutcome && existingOutcome!==text(matches[0].id))
      return finish('review_required',{reason:'Reserved call already has a different terminal outcome; no changes made.'},reservedCall.id);
  }
  const lines = [
    `VoApps result: ${RESULTS[code]} (${code})`,
    `VoApps account: ${ACCOUNT_ID}`,
    `VoApps record ID: ${recordId}`,
    `VoApps message ID: ${text(f.message_id)}`,
    `VoApps message name: ${messageName}`,
    `Message duration (seconds): ${durationSeconds}`,
    `Timestamp source: ${source}`,
    `Submission reference: ${recordKey}`,
    text(f.result_summary)
  ].filter(Boolean);
  const body = {
    properties:{
      hs_timestamp:timestamp,
      hs_call_direction:'OUTBOUND',
      hs_activity_type:text(typeMatches[0].value),
      [REFERENCE_PROPERTY]:recordKey,
      hs_call_title:`${TEST_MODE ? '[TEST] ' : ''}DirectDrop Voicemail - ${RESULTS[code]}`,
      hs_call_body:(TEST_MODE ? ['SYNTHETIC INTEGRATION TEST - not evidence of actual delivery.', ...lines] : lines).map(escapeHtml).join('<br>'),
      hs_call_to_number:phone,
      hs_call_from_number:caller,
      hs_call_disposition:text(matches[0].id)
    },
    associations:[{to:{id:contactId},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:194}]}]
  };
  body.properties.hs_call_status = callStatus;
  if (ownerId) body.properties.hubspot_owner_id = ownerId;
  if (code === '200') body.properties.hs_call_duration = String(Math.round(durationSeconds * 1000));
  // Message duration is stored separately from call duration in call details for
  // every terminal result; non-delivered calls omit hs_call_duration.
  if (DRY_RUN) return finish('dry_run_ready',{
    mode:'read_only',test_mode:TEST_MODE,proposed_request:body,voapps_record_key:recordKey,
    unique_property_verified:true,call_type_verified:true,
    owner_assignment:ownerId ? 'contact_owner' : 'unassigned',
    warnings:['Read-only preview. No CRM records changed. Verified reservations are updated when writes are enabled; repeated matching terminal results are skipped.']
  });
  if (hasReservation) {
    const completed = text(reservedCall.properties?.[REFERENCE_PROPERTY])===recordKey &&
      text(reservedCall.properties?.hs_call_disposition)===text(matches[0].id) &&
      text(reservedCall.properties?.hs_call_status)===callStatus;
    if (completed) return finish('already_logged',{voapps_record_key:recordKey,reservation:true,test_mode:TEST_MODE},reservedCall.id);
    // Only update the verified reservation. Never create a replacement on failure.
    // Repeating this deterministic PATCH is safe; uniqueness still protects record references.
    const properties = {...body.properties};
    properties.hs_call_duration = code==='200' ? String(Math.round(durationSeconds*1000)) : '';
    try {
      await api.patch(`/crm/v3/objects/calls/${reservedCall.id}`,{properties});
      return finish('updated_reserved_call',{voapps_record_key:recordKey,reservation:true,test_mode:TEST_MODE},reservedCall.id);
    } catch(e) {
      throw new Error(`Reserved-call update unresolved/rejected (HTTP ${e.response?.status || 'network'}). Reconcile this same call; do not create another or resend voicemail.`);
    }
  }
  async function existingCall() {
    try {
      return (await api.get(`/crm/v3/objects/calls/${encodeURIComponent(recordKey)}`, {
        params:{idProperty:REFERENCE_PROPERTY,properties:`${REFERENCE_PROPERTY},hs_call_disposition`,associations:'contacts'}
      })).data;
    } catch(e) {
      if (e.response?.status === 404) return null;
      throw new Error(`Submission reconciliation failed (HTTP ${e.response?.status || 'network'}). Do not blindly recreate the call.`);
    }
  }
  function reconcile(found) {
    const contacts = found.associations?.contacts?.results || [];
    if (!contacts.some(c=>text(c.id)===contactId) || text(found.properties?.hs_call_disposition)!==text(matches[0].id)) {
      return finish('review_required',{reason:'Existing submission reference has a different outcome or lacks the expected contact association. No changes made.',voapps_record_key:recordKey},found.id);
    }
    return finish('already_logged',{voapps_record_key:recordKey,test_mode:TEST_MODE},found.id);
  }
  const prior = await existingCall();
  if (prior) return reconcile(prior);
  try {
    const created = (await api.post('/crm/v3/objects/calls',body)).data;
    if (!created.id) throw new Error('Missing call ID');
    return finish('created',{voapps_record_key:recordKey,test_mode:TEST_MODE},created.id);
  } catch(e) {
    // Another writer may have won the unique-value race; a timed-out write may
    // also have succeeded. Check by exact unique key, never by search indexing.
    const found = await existingCall();
    if (found) return reconcile(found);
    const status = e.response?.status;
    if (!status || status >= 500 || status === 409) {
      throw new Error(`Call creation is unresolved (HTTP ${status || 'network'}). Reconcile using the same submission reference; do not change the reference or blindly create another call.`);
    }
    throw new Error(`Call creation rejected (HTTP ${status}). No matching call found. Review permissions, validation, or rate limits; credentials are omitted from logs.`);
  }
};
