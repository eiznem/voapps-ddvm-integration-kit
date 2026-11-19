/* Temporary Node.js 24.x helper. Running Test creates ONE [TEST] queued call
 * on the established test contact. Never calls VoApps. No webhook is posted.
 * Secret: HUBSPOT_DDVM_TOKEN. No inputs.
 * String outputs: reservation_status, hubspot_call_id, send_reference.
 * Uses a synthetic campaign identifier; do not use this helper in production.
 * Repeat executions reuse the exact unique reference and do not create another call.
 */
const axios = require('axios');
// Test-only values: your VoApps account ID and approved test contact's Record ID.
// The campaign part (9000000000002) is synthetic, so it never collides with a real send.
const ACCOUNT_ID = 'YOUR_ACCOUNT_ID';
const CONTACT = 'YOUR_TEST_CONTACT_RECORD_ID';
const SEND_REFERENCE = `${ACCOUNT_ID}:9000000000002:${CONTACT}`;
exports.main = async () => {
  if (!/^\d+$/.test(ACCOUNT_ID) || !/^\d+$/.test(CONTACT))
    throw new Error('Configure ACCOUNT_ID and CONTACT. No call created.');
  const token = process.env.HUBSPOT_DDVM_TOKEN;
  if (!token) throw new Error('Attach HUBSPOT_DDVM_TOKEN.');
  const api = axios.create({baseURL:'https://api.hubapi.com',
    headers:{Authorization:`Bearer ${token}`},timeout:3000});
  const finish = (status,id) => ({outputFields:{reservation_status:status,
    hubspot_call_id:String(id),send_reference:SEND_REFERENCE}});
  async function find() {
    try { return (await api.get(`/crm/v3/objects/calls/${encodeURIComponent(SEND_REFERENCE)}`,
      {params:{idProperty:'voapps_send_reference',properties:'voapps_send_reference',associations:'contacts'}})).data; }
    catch(e) { if(e.response?.status===404) return null;
      throw new Error(`Reservation lookup failed (HTTP ${e.response?.status || 'network'}). Stop.`); }
  }
  function existing(found) {
    if (!(found.associations?.contacts?.results || []).some(c=>String(c.id)===CONTACT))
      throw new Error('Existing reservation has an unexpected contact. No changes made.');
    return finish('already_reserved',found.id);
  }
  const prior = await find();
  if (prior) return existing(prior);
  let data;
  try { data = await Promise.all([
    api.get('/crm/v3/properties/calls/voapps_send_reference'),
    api.get('/crm/v3/properties/calls/hs_activity_type'),
    api.get(`/crm/v3/objects/contacts/${CONTACT}`,{params:{properties:'hubspot_owner_id'}})
  ]); } catch(e) { throw new Error(`Preflight failed (HTTP ${e.response?.status || 'network'}). No call created.`); }
  const schema=data[0].data;
  if(schema.hasUniqueValue!==true || schema.type!=='string' || schema.archived)
    throw new Error('VoApps Send Reference must be active unique text.');
  const types=(data[1].data.options || []).filter(o=>!o.hidden && o.label==='VoApps DirectDrop Voicemail');
  if(types.length!==1) throw new Error('Expected exactly one VoApps DirectDrop Voicemail call type.');
  const properties={voapps_send_reference:SEND_REFERENCE,hs_timestamp:new Date().toISOString(),
    hs_call_title:'[TEST] DDVM submission reservation',hs_call_status:'QUEUED',
    hs_call_direction:'OUTBOUND',hs_activity_type:types[0].value,
    hs_call_body:'SYNTHETIC RESERVATION TEST. No VoApps request or voicemail was sent.',
    hs_call_to_number:'+15555550123',hs_call_from_number:'+15555550100'};
  const owner=data[2].data.properties?.hubspot_owner_id;
  if(owner) properties.hubspot_owner_id=owner;
  try {
    const created=(await api.post('/crm/v3/objects/calls',{properties,
      associations:[{to:{id:CONTACT},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:194}]}]})).data;
    if(!created.id) throw new Error('Missing call ID.');
    return finish('reserved',created.id);
  } catch(e) {
    const found=await find();
    if(found) return existing(found);
    throw new Error(`Reservation creation unresolved/rejected (HTTP ${e.response?.status || 'network'}). Stop and reconcile the same reference; never change it to bypass an error.`);
  }
};
