"""
VoApps DirectDrop Voicemail - postback HMAC signature verification (Python).

VoApps signs `{timestamp}.{destination}.{raw_body}` with HMAC-SHA256 and your org
signing secret, and sends these headers with each postback:
    X-VoApps-Signature:   v1=<hex>
    X-VoApps-Timestamp:   <unix seconds>
    X-VoApps-Destination: <the postback URL it was sent to, as given in the record>

Pass the X-VoApps-Destination header value through verbatim as `destination` (it is
the postback URL, not a phone number, and is part of the signed string). Pass the EXACT
raw request body you received (bytes or str) as raw_body - do not re-serialize a parsed
object, or the bytes (and the signature) will not match.

No third-party dependencies; standard library only.
"""

import hashlib
import hmac
import time


def verify_postback_signature(
    signing_secret,
    timestamp,
    destination,
    raw_body,
    signature_header,
    tolerance_seconds=300,
):
    if not signing_secret:
        raise ValueError("signing_secret is required")
    if not signature_header:
        return False

    try:
        age = abs(time.time() - float(timestamp))
    except (TypeError, ValueError):
        return False
    if age > tolerance_seconds:
        return False

    if isinstance(raw_body, bytes):
        raw_body = raw_body.decode("utf-8")
    signed = f"{timestamp}.{destination}.{raw_body}".encode("utf-8")
    mac = hmac.new(signing_secret.encode("utf-8"), signed, hashlib.sha256)
    expected = "v1=" + mac.hexdigest()

    # Constant-time comparison.
    return hmac.compare_digest(expected, signature_header)


# ---- Flask example ----------------------------------------------------------
#
# import os
# from flask import Flask, request, abort
#
# app = Flask(__name__)
# SIGNING_SECRET = os.environ["VOAPPS_SIGNING_SECRET"]
#
# @app.post("/voapps/postback")
# def postback():
#     raw = request.get_data()  # exact bytes, before any JSON parsing
#     ok = verify_postback_signature(
#         SIGNING_SECRET,
#         request.headers.get("X-VoApps-Timestamp"),
#         request.headers.get("X-VoApps-Destination"),
#         raw,
#         request.headers.get("X-VoApps-Signature"),
#     )
#     if not ok:
#         abort(401)
#     result = request.get_json()
#     record = result.get("record", result)
#     # record["delivery_status_code"]: 200 delivered, 300 expired, 400-410 failed, ...
#     # record["account_number"] is your tie-back reference.
#     # TODO: update your CRM here.
#     return ("ok", 200)  # respond 200 within ~5s or VoApps retries
