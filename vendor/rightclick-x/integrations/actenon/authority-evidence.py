"""Read-only optional adapter. Cryptographic verification belongs to Actenon.

The operator pins the public key bytes, issuer and resource origin. No network,
grant store, issuer secret, effect execution or runtime import is available here.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import re
from pathlib import Path
import sys
from urllib.parse import urlsplit

from actenon.models import PartyRef
from actenon.receipts import OutcomeAttestationService
from actenon.proof.canonical import canonicalize_bytes
from actenon_permit.boundary.proofs import Ed25519PublicKeyVerifier


def read(path, maximum):
    with Path(path).open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("evidence input exceeds profile")
    return data


def transport_links(path):
    """The operator owns this journal. Native signatures do NOT sign context."""
    if not path:
        return {}
    data = read(path, 4 * 1024 * 1024)
    if data and not data.endswith(b"\n"):
        raise ValueError("incomplete transport log")
    links = {}
    requests = set()
    lines = data.splitlines()
    if len(lines) > 1000:
        raise ValueError("transport log exceeds profile")
    for line in lines:
        if len(line) > 128 * 1024:
            raise ValueError("oversized transport record")
        row = json.loads(line)
        context = row["context"]
        if row["version"] != 1 or set(context) != {"runtimeId", "runId", "capabilityId", "requestId"}:
            raise ValueError("unsupported transport context")
        if any(not isinstance(v, str) or not v or len(v) > 512 or re.search(r"[\x00-\x1f\x7f]", v) for v in context.values()):
            raise ValueError("invalid transport context")
        if any(not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", context[k]) for k in ("runtimeId", "requestId")):
            raise ValueError("invalid transport identity")
        request = (context["runtimeId"], context["requestId"])
        if request in requests:
            raise ValueError("duplicate transport request")
        requests.add(request)
        wire = row["wire"]
        if set(wire) != {"method", "url", "body", "headers"} or not isinstance(wire["headers"], dict):
            raise ValueError("unsupported wire")
        refs = row["artifacts"]
        if not isinstance(refs, list) or not 1 <= len(refs) <= 2:
            raise ValueError("unsupported artifact references")
        if len({ref["nativeRequestId"] for ref in refs}) != 1:
            raise ValueError("one response cannot name different gate attempts")
        for ref in refs:
            digest = ref["artifactDigest"]
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or digest in links:
                raise ValueError("ambiguous artifact association")
            if not isinstance(ref["nativeRequestId"], str) or not 1 <= len(ref["nativeRequestId"]) <= 160:
                raise ValueError("invalid gate request reference")
            links[digest] = (context, wire, ref["nativeRequestId"])
    return links


def project(args):
    key_bytes = read(args.public_key, 4096)
    if hashlib.sha256(key_bytes).hexdigest() != args.trust_anchor:
        raise ValueError("operator trust anchor changed")
    key = json.loads(key_bytes)
    if set(key) - {"kty", "crv", "kid", "alg", "x", "use", "key_ops"} or key.get("kty") != "OKP" or key.get("crv") != "Ed25519":
        raise ValueError("unsupported public key profile")
    verifier = Ed25519PublicKeyVerifier([key])
    service = OutcomeAttestationService(signer=verifier, issuer=PartyRef(type="service", id=args.issuer))
    origin = urlsplit(args.origin)
    if origin.scheme not in ("https", "http") or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise ValueError("expected one operator-pinned origin")
    data = read(args.attestations, 4 * 1024 * 1024)
    if data and not data.endswith(b"\n"):
        raise ValueError("incomplete evidence record")
    records = []
    seen = set()
    links = transport_links(args.transport_links)
    # Historical bounded suffix. Omission/reordering is not cryptographically
    # detectable from standalone attestations; never claim a complete journal.
    for line in data.splitlines()[-100:]:
        if len(line) > 128 * 1024:
            raise ValueError("oversized attestation")
        attestation = json.loads(line)
        payload = attestation["unsigned_payload"]
        kind = payload["artifact_type"]
        if kind not in ("receipt", "refusal") or payload["issuer"] != {"type": "service", "id": args.issuer}:
            raise ValueError("unexpected attestation issuer or kind")
        verified = getattr(service, f"verify_{kind}_attestation")(attestation, verifier=verifier)
        artifact = verified if isinstance(verified, dict) else verified.to_dict()
        target = artifact["target"]["resource_id"]
        actual = urlsplit(target)
        if actual.scheme != origin.scheme or actual.netloc != origin.netloc or actual.username or actual.password:
            raise ValueError("attested target is outside the pinned boundary")
        digest = payload["artifact_digest"]["value"]
        if digest in seen:
            raise ValueError("duplicate attestation")
        seen.add(digest)
        action_hash = artifact.get("correlation", {}).get("action_hash")
        outcome = "refused" if kind == "refusal" else artifact["outcome"] if artifact.get("outcome") in ("executed", "refused") else "unresolved"
        record = {"artifactType": kind, "artifactDigest": digest,
            "actionDigest": action_hash["value"] if action_hash and action_hash.get("algorithm") == "sha-256" else None,
            "targetDigest": hashlib.sha256(canonicalize_bytes(artifact["target"])).hexdigest(),
            "principal": artifact["subject"]["id"], "operation": artifact["action"]["capability"],
            "outcome": outcome, "reason": artifact.get("reason_code"),
            "occurredAt": artifact["refused_at"] if kind == "refusal" else artifact["occurred_at"]}
        if digest in links:
            context, wire, native_request = links[digest]
            # Check actual signed request, not a proof template (which may have
            # been refused for disagreeing with the actual request).
            if artifact.get("correlation", {}).get("request_id") != native_request or \
                    artifact["target"] != {"resource_type": "tool", "resource_id": wire["url"]} or \
                    artifact["action"] != {"name": "http." + wire["method"].lower(),
                        "capability": "http." + wire["method"].lower(),
                        "parameters": {k: wire[k] for k in ("method", "body", "headers")}}:
                raise ValueError("native artifact does not match transport response")
            record["runtimeLink"] = {**context, "kind": "operator-correlated"}
        records.append(record)
    return {"version": 1, "verifiedAt": datetime.now(timezone.utc).isoformat(), "records": records}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ["attestations", "public-key", "trust-anchor", "origin", "issuer"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--transport-links")
    try:
        print(json.dumps(project(parser.parse_args())))
    except Exception:
        # No raw signed body, credential detail or filesystem error in UI logs.
        print("native authority evidence unavailable", file=sys.stderr)
        sys.exit(1)
