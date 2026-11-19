/* ONE-TIME HUBSPOT CUSTOM CODE SETUP HELPER - Node.js 24.x
 * Draft: not installed, not live-tested. READ-ONLY against HubSpot.
 * Attach a HubSpot service key as secret HUBSPOT_DDVM_TOKEN (not the VoApps key).
 * Add optional String inputs: result_catalog_json, outcome_choices_json,
 * campaign_label, call_type, account_id, message_id, caller_number, postback_url.
 * Add String outputs: setup_config_json, available_outcomes_json, setup_issues_json;
 * add Boolean output: ready_for_logging_config.
 *
 * First run: omit JSON inputs to discover existing outcomes and missing mappings.
 * Create any missing custom outcomes and the call type in HubSpot's UI, then rerun.
 * The documented public outcome API lists outcomes; this helper DOES NOT invent a
 * create-outcome/type endpoint or try to grant permissions to its own token.
 *
 * result_catalog_json: authoritative COMPLETE list of {code,label} from VoApps.
 * The defaults contain the user's 19 terminal results; 100/101 are interim.
 * outcome_choices_json: object mapping result codes to existing outcome IDs OR
 * exact labels, e.g. {"200":"Left voicemail","401":"VoApps - Not wireless"}.
 * Review every mapping: never automatically classify an unsuccessful result as
 * Connected or Left voicemail. Unknown codes must be flagged by the runtime.
 *
 * Configuration output contains NO token. Persist it explicitly in the sending
 * and receiver actions; workflow output from this one-time run is not durable
 * shared configuration. This code does not install or modify those actions.
 *
 * For this helper and contact-linked runtime logging, start with the dedicated
 * key's crm.objects.contacts.read and crm.objects.contacts.write scopes.
 * No automation, export, sensitive-data or schema-write scopes are used here.
 * A successful read probe does NOT establish write permission; perform an
 * approved controlled call-creation test separately.
 */
const axios = require('axios');
// Complete terminal-result catalog supplied by the user; 100/101 are interim.
const VERIFIED_EXAMPLES = [
  ['200','Successfully delivered'], ['300','Expired'], ['301','Canceled'],
  ['400','Unsuccessful delivery attempt'], ['401','Not a wireless number'],
  ['402','Duplicate number'], ['403','Not a valid US number'], ['404','Undeliverable'],
  ['405','Not in service'], ['406','Voicemail not setup'], ['407','Voicemail full'],
  ['408','Invalid caller number'], ['409','Invalid message id'], ['410','Prohibited self call'],
  ['500','Restricted'], ['501','Restricted for frequency'],
  ['502','Restricted geographical region'], ['503','Restricted individual number'],
  ['504','Restricted WebRecon']
].map(([code,label])=>({code,label}));
const text = v => v == null ? '' : String(v).trim();
function jsonInput(value, fallback, name) {
  if (!text(value)) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${name} must be valid JSON.`); }
}
exports.main = async event => {
  const f = event.inputFields || {};
  const token = process.env.HUBSPOT_DDVM_TOKEN;
  if (!token) throw new Error('Attach the HubSpot service key as HUBSPOT_DDVM_TOKEN.');
  const api = axios.create({baseURL:'https://api.hubapi.com',
    headers:{Authorization:`Bearer ${token}`},timeout:5000});
  let rawOutcomes;
  try { rawOutcomes = (await api.get('/calling/v1/dispositions')).data; }
  catch(e) {
    // Never print axios's request config: it contains Authorization.
    throw new Error(`Outcome discovery failed (HTTP ${e.response?.status || 'network'}). Check the HubSpot key and endpoint access; do not add unrelated scopes.`);
  }
  if (!Array.isArray(rawOutcomes)) throw new Error('Unexpected outcome response; expected an array.');
  const outcomes = rawOutcomes.map(o=>({id:text(o.id),label:text(o.label)})).filter(o=>o.id && o.label);
  const suppliedFullCatalog = true; // User-supplied terminal catalog is embedded below.
  const catalog = jsonInput(f.result_catalog_json, VERIFIED_EXAMPLES, 'result_catalog_json');
  const choices = jsonInput(f.outcome_choices_json, Object.fromEntries(VERIFIED_EXAMPLES.map(o=>[o.code,o.label])), 'outcome_choices_json');
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Result catalog must be a nonempty array.');
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new Error('Outcome choices must be an object keyed by result code.');
  const issues = [];
  if (!suppliedFullCatalog) issues.push('Only 3 verified example codes are seeded. Supply the complete authoritative VoApps result catalog before production.');
  const seen = new Set(), mappings = {};
  for (const item of catalog) {
    const code = text(item.code), label = text(item.label);
    if (!/^\d+$/.test(code) || !label || seen.has(code)) throw new Error('Each result must have a unique numeric code and nonempty label.');
    seen.add(code);
    const wanted = text(choices[code]);
    // Only an explicit choice resolves a mapping; similar labels are not consent.
    const matches = wanted ? outcomes.filter(o=>o.id === wanted || o.label === wanted) : [];
    if (matches.length !== 1) {
      issues.push(`Map ${code} (${label}) to exactly one existing outcome ID or exact label. Create any missing outcome in HubSpot first.`);
      continue;
    }
    mappings[code] = {voapps_label:label, outcome_id:matches[0].id, outcome_label:matches[0].label};
  }
  const type = text(f.call_type) || 'VoApps DirectDrop Voicemail';
  issues.push('Confirm the selected call type exists in HubSpot: ' + type + '. This helper cannot create or verify its availability.');
  const label = text(f.campaign_label) || 'DDVM Integration Test';
  if (!label) issues.push('Enter a descriptive campaign_label, for example DPD 90+.');
  const config = {
    version:2, call_direction:'OUTBOUND', call_type:type,
    interim_results:{'100':'Pending','101':'Running'},
    interim_handling:'do_not_log_completed_call',
    voapps:{account_id:text(f.account_id),message_id:text(f.message_id),
      caller_number:text(f.caller_number),campaign_label:label,
      postback_url:text(f.postback_url)},
    number_selection:{preferred:'mobilephone',fallback:'phone',outgoing_key:'phone_number',missing:'stop'},
    contact_reference:{outgoing_key:'account_number',source:'HubSpot Contact Record ID'},
    timestamp:{preferred:'voapps_timestamp',blank_fallback:'action_start',invalid:'fail'},
    result_mappings:mappings,unknown_result:'flag_for_review_no_guessed_outcome',
    submission_note:{after:'accepted_by_voapps',include:['campaign_id','campaign_name','voapps_record_id']},
    deduplication:{key_components:['voapps_account_id','voapps_record_id'],implemented:false},
    setup_only:true
  };
  // Safe read-only probe; no call is created and no contact is changed.
  try { await api.get('/crm/v3/objects/calls',{params:{limit:1,properties:'hs_object_id'}}); }
  catch(e) { issues.push(`Call-read probe failed (HTTP ${e.response?.status || 'network'}); resolve before runtime deployment.`); }
  issues.push('Runtime call writer and durable duplicate-postback protection still need implementation and controlled testing.');
  issues.push('VoApps account/caller/message values are seeded or provided, not fetched or validated. Dynamic account/message selection is not implemented in this helper.');
  return {outputFields:{
    setup_config_json:JSON.stringify(config),
    available_outcomes_json:JSON.stringify(outcomes),
    setup_issues_json:JSON.stringify(issues),
    ready_for_logging_config:suppliedFullCatalog && Object.keys(mappings).length===catalog.length && Boolean(label)
  }};
};
