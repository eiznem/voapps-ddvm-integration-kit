/* Node.js 24.x. Reservation-aware sender, reconstructed from tested revisions.
 * Secrets: VOAPPS_API_KEY and HUBSPOT_DDVM_TOKEN.
 * DRY_RUN=true previews only. False permits campaign/reservation creation and a real VoApps POST.
 * Inputs: mobilephone, phone_number, reference, voapps_zip_code; optional campaign_label.
 * String outputs: send_status, send_details, campaign_id, campaign_name,
 * voapps_record_id, submission_note_body.
 * Saved campaign is validated directly; fallback discovery is bounded by UTC creation dates.
 * A unique call reservation permits only its creator to submit the contact to that campaign.
 * No automatic POST retries or automatic release of unresolved reservations.
 * Create note separately ONLY for send_status=accepted.
 * Fixed selections are revalidated with fresh lists; no interactive setup UI is implemented.
 * Preserve the paired reservation-aware receiver and deployment restrictions.
 */
const axios = require('axios');
const DRY_RUN = true;
const crypto = require('crypto');
const DEFAULT_CAMPAIGN_LABEL = 'DDVM Integration Test';
// Saved per-use-case configuration, retained across workflow executions.
// After discovery selects a replacement, deliberately save its ID here.
// Outputs do NOT automatically persist changes back into this configuration.
// Leave id '' until a campaign has been selected; discovery then runs.
const SAVED_CAMPAIGN = {
  id: '', account_id: 'YOUR_ACCOUNT_ID', message_id: 'YOUR_MESSAGE_ID',
  caller_number: '+15555550100', label: 'DDVM Integration Test'
};
const html = v => text(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Configure for this use case. Placeholders fail validation until replaced.
const ACCOUNT_ID = 'YOUR_ACCOUNT_ID';
const MESSAGE_ID = 'YOUR_MESSAGE_ID';
const CALLER_NUMBER = '+15555550100';          // must be an active caller number in the account
const POSTBACK_URL = 'YOUR_HUBSPOT_WEBHOOK_URL';  // the receiver's generated webhook URL; keep it private
const text = value => value == null ? '' : String(value).trim();
function usPhone(value) {
  const raw = text(value);
  if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Unsupported phone format; correct the record before sending.');
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (!/^1\d{10}$/.test(digits)) throw new Error('Phone must be a US-format number with country code 1.');
  return '+' + digits;
}
exports.main = async event => {
  const started = Date.now();
  const key = process.env.VOAPPS_API_KEY;
  if (!key) throw new Error('Attach VOAPPS_API_KEY.');
  if (!/^\d+$/.test(ACCOUNT_ID) || !/^\d+$/.test(MESSAGE_ID) || !/^https:\/\//.test(POSTBACK_URL))
    throw new Error('Configure ACCOUNT_ID, MESSAGE_ID, CALLER_NUMBER and POSTBACK_URL. Nothing submitted.');
  const f = event.inputFields || {};
  const source = text(f.mobilephone) ? 'mobilephone' : 'phone_number';
  const rawPhone = text(f[source]);
  if (!rawPhone) throw new Error('Both Mobile Phone Number and Phone Number are blank. Nothing submitted.');
  const phone = usPhone(rawPhone);
  const reference = text(f.reference);
  if (!/^\d+$/.test(reference)) throw new Error('A numeric Contact Record ID is required. Nothing submitted.');
  const api = axios.create({baseURL:'https://directdropvoicemail.voapps.com/api/v1',
    headers:{Authorization:`Token token=${key}`},timeout:5000});
  let responses;
  try {
    responses = await Promise.all([
      api.get('/accounts'),
      api.get(`/accounts/${ACCOUNT_ID}/messages`),
      api.get(`/accounts/${ACCOUNT_ID}/caller_numbers`)
    ]);
  } catch (e) {
    throw new Error(`VoApps metadata lookup failed (HTTP ${e.response?.status || 'network'}). Nothing submitted.`);
  }
  const [a,m,c] = responses.map(r=>r.data);
  if (!Array.isArray(a.accounts) || !Array.isArray(m.messages) || !Array.isArray(c.caller_numbers))
    throw new Error('Unexpected metadata response. Nothing submitted.');
  if (!a.accounts.some(x=>String(x.id)===ACCOUNT_ID))
    throw new Error('Configured account is not in the current visible account list. Reselect it.');
  const message = m.messages.find(x=>String(x.id)===MESSAGE_ID);
  if (!message) throw new Error('Configured message is not in the current active list. Reselect it.');
  const caller = c.caller_numbers.find(x=>usPhone(x.number)===usPhone(CALLER_NUMBER));
  if (!caller) throw new Error('Configured caller number is not in the current active list. Reselect it.');
  const duration = Number(message.duration);
  if (!text(message.name) || !text(message.duration) || !Number.isFinite(duration) || duration <= 0)
    throw new Error('Message name or positive duration is missing/invalid. Nothing submitted.');
  const attrs = {
    phone_number:phone, account_number:reference,
    voapps_message_id:MESSAGE_ID, voapps_caller_number:usPhone(caller.number),
    voapps_postback_url:POSTBACK_URL,
    message_name:text(message.name), message_duration_seconds:String(duration)
  };
  if (text(f.voapps_zip_code)) attrs.voapps_zip_code=text(f.voapps_zip_code);
  /* A stable per-day, per-configuration name avoids accidental campaign creation
   * on each record. Campaign-name uniqueness does NOT make record POST idempotent.
   */
  const account = a.accounts.find(x=>String(x.id)===ACCOUNT_ID);
  if (!text(account.timezone)) throw new Error('Account timezone missing. Nothing submitted.');
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-US',{timeZone:account.timezone,year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(now);
  const part = type => dateParts.find(p=>p.type===type).value;
  const label = text(f.campaign_label) || DEFAULT_CAMPAIGN_LABEL;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([label,ACCOUNT_ID,MESSAGE_ID,usPhone(caller.number)]))
    .digest('hex').slice(0,12);
  let campaignName = `${label} | Transactional Campaign ${part('month')}/${part('day')}/${part('year')} ${fingerprint}`;
  // Bounded discovery by campaign creation date (UTC), not target/run date.
  // Campaigns created before this window are not covered by this lookup.
  const dateStart = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0,10);
  // End at the next UTC midnight: a date-only created_date_end means midnight at the
  // START of that date, so ending on today's date would miss campaigns created today.
  const dateEnd = new Date(now.getTime() + 86400000).toISOString().slice(0,10);
  function budget() {
    const left = 17500 - (Date.now()-started);
    if (left < 2000) throw new Error('Execution budget exhausted. Stop and inspect VoApps before any retry.');
    return Math.min(4000,left);
  }
  const discovery = {date_start:dateStart,date_end:dateEnd,pages:0,scanned:0,candidates:[],list_samples:[]};
  async function findCampaign() {
    const eligible = [];
    const seen = new Set();
    for (let page=1; ; page++) {
      const result = (await api.get(`/accounts/${ACCOUNT_ID}/campaigns`,{timeout:budget(),
        params:{created_date_start:dateStart,created_date_end:dateEnd,filter:'all',page}})).data;
      if (!Array.isArray(result.campaigns)) throw new Error('Unexpected campaign list.');
      discovery.pages++;
      discovery.scanned += result.campaigns.length;
      for (const listed of result.campaigns) {
        const id = text(listed.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const sample = {id,name:text(listed.name),status:text(listed.status),keys:Object.keys(listed)};
        if (discovery.list_samples.length<5) discovery.list_samples.push(sample);
        if (!text(listed.name).startsWith(`${label} | Transactional Campaign `)) continue;
        // Verify details instead of assuming list fields equal the detail response.
        const detail = (await api.get(`/accounts/${ACCOUNT_ID}/campaigns/${id}`,{timeout:budget()})).data.campaign;
        if (!detail || text(detail.id)!==id) throw new Error('Invalid campaign detail response.');
        let normalizedCaller = '';
        try { normalizedCaller = usPhone(detail.caller_number); } catch (_) {}
        const checks = {
          name_matches:text(detail.name).endsWith(` ${fingerprint}`),
          open:['running','pending'].includes(text(detail.status)),
          message_matches:text(detail.message_id)===MESSAGE_ID,
          caller_matches:normalizedCaller===usPhone(CALLER_NUMBER)
        };
        discovery.candidates.push({id,name:text(detail.name),status:text(detail.status),
          message_id:text(detail.message_id),caller_number:normalizedCaller,checks});
        if (Object.values(checks).every(Boolean)) eligible.push(detail);
      }
      if (eligible.length>1) throw new Error('Multiple eligible campaigns. Stop for review.');
      if (result.campaigns.length<25) return eligible[0] || null;
    }
  }
  let campaign;
  try {
    const savedMatches = SAVED_CAMPAIGN.id &&
      SAVED_CAMPAIGN.account_id === ACCOUNT_ID &&
      SAVED_CAMPAIGN.message_id === MESSAGE_ID &&
      usPhone(SAVED_CAMPAIGN.caller_number) === usPhone(CALLER_NUMBER) &&
      SAVED_CAMPAIGN.label === label;
    discovery.selection_source = 'bounded_discovery';
    if (savedMatches) {
      let detail;
      try {
        detail = (await api.get(`/accounts/${ACCOUNT_ID}/campaigns/${SAVED_CAMPAIGN.id}`,
          {timeout:budget()})).data.campaign;
      } catch (e) {
        // Only a definite missing campaign permits discovery. Authentication,
        // rate-limit and ambiguous failures stop without creating replacements.
        if (e.response?.status !== 404) throw e;
      }
      if (detail) {
        if (text(detail.id) !== SAVED_CAMPAIGN.id)
          throw new Error('Saved campaign detail response is invalid.');
        let normalizedCaller = '';
        try { normalizedCaller = usPhone(detail.caller_number); } catch (_) {}
        const checks = {
          name_matches:text(detail.name).startsWith(`${label} | Transactional Campaign `) &&
            text(detail.name).endsWith(` ${fingerprint}`),
          open:['running','pending'].includes(text(detail.status)),
          message_matches:text(detail.message_id)===MESSAGE_ID,
          caller_matches:normalizedCaller===usPhone(CALLER_NUMBER)
        };
        discovery.saved_campaign_check = {id:text(detail.id),status:text(detail.status),checks};
        if (!checks.name_matches || !checks.message_matches || !checks.caller_matches)
          throw new Error('Saved campaign configuration changed. Review before selecting a replacement.');
        if (checks.open) {
          campaign = detail;
          discovery.selection_source = 'saved_campaign_direct_validation';
        }
      }
    }
    if (!campaign) {
      campaign = await findCampaign();
      discovery.configuration_save_required = Boolean(campaign);
      discovery.selected_campaign_id = text(campaign?.id);
    }
  }
  catch(e) {
    // Preserve diagnostic context without logging authentication or request config.
    return {outputFields:{send_status:'discovery_review_required',campaign_id:'',campaign_name:campaignName,
      voapps_record_id:'',submission_note_body:'',send_details:JSON.stringify({mode:'read_only',
        discovery,http_status:e.response?.status || null,
        reason:e.response ? 'Campaign API lookup failed.' : e.message,
        instruction:'No campaign or record created. Review discovery before retrying.'})}};
  }
  if (campaign && (!['running','pending'].includes(campaign.status)
      || text(campaign.message_id)!==MESSAGE_ID || usPhone(campaign.caller_number)!==usPhone(CALLER_NUMBER))) {
    throw new Error('Matching campaign is not running/pending or has different defaults. Stop for review.');
  }
  if (campaign) campaignName = text(campaign.name); // Preserve the reused campaign's original name/date.
  // Reservation preflight is read-only, including when DRY_RUN is true.
  const hubspotToken = process.env.HUBSPOT_DDVM_TOKEN;
  if (!hubspotToken) throw new Error('Attach HUBSPOT_DDVM_TOKEN to the sender.');
  const hub = axios.create({baseURL:'https://api.hubapi.com',
    headers:{Authorization:`Bearer ${hubspotToken}`},timeout:2500});
  const reservationSchemas = await Promise.all([
    hub.get('/crm/v3/properties/calls/voapps_send_reference'),
    hub.get('/crm/v3/properties/calls/voapps_submission_reference'),
    hub.get('/crm/v3/properties/calls/hs_activity_type'),
    hub.get(`/crm/v3/objects/contacts/${reference}`,{params:{properties:'hubspot_owner_id'}})
  ]).catch(()=>{throw new Error('HubSpot reservation preflight failed. Check token and call properties; nothing submitted.');});
  for (const index of [0,1]) {
    const schema = reservationSchemas[index].data;
    if (schema.type !== 'string' || schema.hasUniqueValue !== true || schema.archived)
      throw new Error('Both VoApps call reference properties must be active unique text fields.');
  }
  const callTypes = (reservationSchemas[2].data.options || []).filter(o=>!o.hidden && o.label==='VoApps DirectDrop Voicemail');
  if (callTypes.length!==1) throw new Error('Expected exactly one VoApps DirectDrop Voicemail call type.');
  const contactOwner = text(reservationSchemas[3].data.properties?.hubspot_owner_id);
  const plannedSendKey = campaign ? `${ACCOUNT_ID}:${campaign.id}:${reference}` : '';
  if (DRY_RUN) return {outputFields:{send_status:'dry_run_ready',
    campaign_id:text(campaign?.id),campaign_name:campaignName,voapps_record_id:'',submission_note_body:'',
    send_details:JSON.stringify({mode:'read_only',phone_source:source,proposed_record_attributes:attrs,
      campaign_plan:campaign ? 'reuse_existing' : 'create_named_transactional',
      campaign_name:campaignName,campaign_id:text(campaign?.id),timezone:account.timezone,discovery,
      reservation_preview:{send_reference:plannedSendKey || 'determined_after_campaign_creation',unique_properties_verified:true,call_type_verified:true,owner_assignment:contactOwner ? 'contact_owner' : 'unassigned'},
      warnings:['Read-only preview. No campaign, reservation, record or note created. Use the paired reservation-aware receiver; broader failure/concurrency tests remain outstanding.']})}};
  // Matching reservation-aware receiver must be installed before enabling writes.
  if (!campaign) {
    try {
      const created=await api.post(`/accounts/${ACCOUNT_ID}/campaigns`,new URLSearchParams({
        name:campaignName,message_id:MESSAGE_ID,caller_number:usPhone(caller.number),
        transactional:'true',confirm:'true'
      }).toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:budget()});
      campaign=created.data.campaign;
    } catch(e) {
      // A concurrent campaign create or timed-out create may have succeeded.
      // Resolve the SAME name; never generate a new name as an error workaround.
      campaign=await findCampaign();
      if (campaign) campaignName = text(campaign.name);
      if (!campaign) throw new Error('Campaign creation unresolved. Stop and inspect VoApps; no record POST attempted.');
      if (!['running','pending'].includes(campaign.status) || text(campaign.message_id)!==MESSAGE_ID
          || usPhone(campaign.caller_number)!==usPhone(CALLER_NUMBER))
        throw new Error('Recovered campaign is not eligible. No record POST attempted.');
    }
  }
  if (!/^\d+$/.test(text(campaign?.id)) || campaign.name!==campaignName)
    throw new Error('Campaign response missing expected ID/name. No record POST attempted.');
  // Atomic unique-key reservation: only the execution that creates this call may POST to VoApps.
  // Existing reservations always stop a send, including ambiguous failures. Never auto-release.
  const sendKey = `${ACCOUNT_ID}:${campaign.id}:${reference}`;
  async function findReservation() {
    try { return (await hub.get(`/crm/v3/objects/calls/${encodeURIComponent(sendKey)}`,
      {params:{idProperty:'voapps_send_reference',properties:'voapps_send_reference,voapps_submission_reference'}})).data; }
    catch(e) { if(e.response?.status===404) return null;
      throw new Error('Reservation lookup unresolved. Nothing submitted; do not retry automatically.'); }
  }
  function reserved(found) {
    return {outputFields:{send_status:'reserved_no_resend_review_required',campaign_id:text(campaign.id),
      campaign_name:campaignName,voapps_record_id:'',submission_note_body:'',
      send_details:JSON.stringify({hubspot_call_id:text(found.id),send_reference:sendKey,
        instruction:'Existing reservation found. No VoApps POST attempted. Reconcile acceptance before any manual retry.'})}};
  }
  const priorReservation = await findReservation();
  if(priorReservation) return reserved(priorReservation);
  const reservationProperties = {
    voapps_send_reference:sendKey,hs_timestamp:new Date().toISOString(),hs_call_status:'QUEUED',
    hs_call_direction:'OUTBOUND',hs_activity_type:text(callTypes[0].value),
    hs_call_title:'DirectDrop Voicemail - submission reserved',hs_call_to_number:phone,
    hs_call_from_number:usPhone(caller.number),
    hs_call_body:`Submission reserved before VoApps POST. Acceptance not yet established.<br>Send reference: ${html(sendKey)}`
  };
  if(contactOwner) reservationProperties.hubspot_owner_id=contactOwner;
  let reservation;
  try {
    reservation=(await hub.post('/crm/v3/objects/calls',{properties:reservationProperties,
      associations:[{to:{id:reference},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:194}]}]})).data;
    if(!/^\d+$/.test(text(reservation.id))) throw new Error('Missing reservation ID.');
  } catch(e) {
    const existing=await findReservation();
    if(existing) return reserved(existing);
    throw new Error('Reservation creation unresolved or rejected. No VoApps POST attempted. Stop for review.');
  }
  attrs.hubspot_call_id=text(reservation.id);
  attrs.voapps_send_reference=sendKey;
  attrs.campaign_id=text(campaign.id);
  attrs.campaign_name=campaignName;
  try {
    const response=await api.post(`/accounts/${ACCOUNT_ID}/campaigns/${campaign.id}/records`,
      new URLSearchParams({record_attributes:JSON.stringify(attrs)}).toString(),
      {headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:budget()});
    const recordId=text(response.data?.record?.id);
    if (!/^\d+$/.test(recordId)) throw new Error('Record response lacks ID; reconcile before retrying.');
    // Attach the VoApps reference without touching status/body: a fast postback may already have finalized the call.
    let reservationReferenceSaved = false;
    try {
      await hub.patch(`/crm/v3/objects/calls/${reservation.id}`,{properties:{
        voapps_submission_reference:`${ACCOUNT_ID}:${recordId}`}});
      reservationReferenceSaved = true;
    } catch (_) { /* Do not resend: VoApps already accepted this record. Receiver can reconcile via echoed call ID. */ }
    const note=[
      'DirectDrop Voicemail submission accepted by VoApps - not confirmation of delivery.',
      `Phone: ${phone}`,`Campaign: ${campaignName}`,`Campaign ID: ${campaign.id}`,
      `VoApps record ID: ${recordId}`,`Message: ${attrs.message_name} (ID ${MESSAGE_ID})`,
      `Submitted at: ${new Date().toISOString()}`
    ].map(html).join('<br>');
    return {outputFields:{send_status:'accepted',campaign_id:text(campaign.id),campaign_name:campaignName,
      voapps_record_id:recordId,submission_note_body:note,
      send_details:JSON.stringify({http_status:response.status,phone_source:source,
        message_name:attrs.message_name,message_duration_seconds:duration,submission_note_created:false,
        hubspot_call_id:text(reservation.id),send_reference:sendKey,reservation_reference_saved:reservationReferenceSaved})}};
  } catch(e) {
    const status=e.response?.status;
    return {outputFields:{campaign_id:text(campaign.id),campaign_name:campaignName,
      voapps_record_id:'',submission_note_body:'',
      send_status:!status || status>=500 ? 'acceptance_unknown_review_required':'request_rejected_review_required',
      send_details:JSON.stringify({http_status:status || null,
        instruction:'Stop this record for review. Check VoApps before retrying. Do not automatically resend.',
        submission_note_created:false})}};
  }
};
