/* Node.js 24.x. Manual replay of a captured VoApps result.
 * Calls HubSpot only. Does not call VoApps or send voicemail.
 * The live receiver may create a real [TEST] call activity.
 * Keep receiver TEST_MODE=true and its test-contact restriction enabled.
 * No secrets or input properties required.
 * Optional String outputs: replay_status, replay_details.
 * HTTP acceptance alone does not prove receiver workflow completion.
 * No automatic retries: inspect receiver history after a timeout.
 */
const axios = require('axios');
// Test-only values. Use your own receiver URL and approved test contact; keep the URL private.
const RECEIVER_URL = 'YOUR_HUBSPOT_WEBHOOK_URL';
const TEST_CONTACT_ID = 'YOUR_TEST_CONTACT_RECORD_ID';
exports.main = async () => {
  if (!/^https:\/\//.test(RECEIVER_URL) || !/^\d+$/.test(TEST_CONTACT_ID))
    throw new Error('Configure RECEIVER_URL and TEST_CONTACT_ID. Nothing posted.');
  const payload = {
    record: {
      id: 1000000001,
      number: null,
      delivery_status: 'Duplicate number',
      delivery_status_code: 402,
      voapps_timestamp: '',
      original_fields: {
        phone_number: '+15555550123',
        account_number: TEST_CONTACT_ID,
        voapps_message_id: 'YOUR_MESSAGE_ID',
        voapps_caller_number: '+15555550100',
        voapps_postback_url: RECEIVER_URL,
        voapps_zip_code: '10001',
        message_name: 'Test Message',
        message_duration_seconds: '12.9',
        campaign_id: '1000001',
        campaign_name: 'DDVM Integration Test | Transactional Campaign 11/18/2026 000000000000'
      }
    }
  };
  // Reconstructed from the captured result and accepted submission metadata.
  // Optional duplicate_hash is deliberately omitted; it is not an identity key.
  try {
    const response = await axios.post(
      RECEIVER_URL,
      payload,
      {headers: {'Content-Type':'application/json'}, timeout:10000, validateStatus:()=>true}
    );
    return {outputFields:{
      replay_status: response.status >= 200 && response.status < 300 ? 'http_accepted_check_receiver' : 'http_rejected',
      replay_details: JSON.stringify({http_status:response.status, voapps_record_id:String(payload.record.id),
        instruction:'Check the live receiver Run History. Do not resubmit voicemail.'})
    }};
  } catch (_) {
    throw new Error('Replay response unavailable. Check receiver Run History before retrying; acceptance is unknown.');
  }
};
