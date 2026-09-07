#!/usr/bin/env python3
"""Offline-first capsule inspector and restricted MCP input tool. No network.

No dispatch/enroll/download/upload call is implemented against an incompatible
server. Preflight always blocks the verified @2 contract. This is intentional,
not a simulated successful connection. The reviewer command is generated only.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parent
EXPECTED_MODEL = 'claude-opus-5'
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_READ = 32768
MAX_TOTAL_READ = 512 * 1024
KNOWN_INPUTS = {
    'candidate': ('Gaussian_L1_Evaluation_v0_1_0_CANDIDATE.zip', 5931, 'b07e0a124a748a8c3cd3c7e308816a2b8aacbe033968d8aa296d78d9103cdf4e'),
    'owner_evaluator': ('Gaussian_L1_Evaluation_v0_1_0_OWNER_EVALUATOR.zip', 4615537, 'ac71b2f9e3a2528a91b681bbf0048f5b57c5ba062583e599f9e4eba30ba8658f'),
}

class Rejected(ValueError):
    pass

def sha(data):
    return hashlib.sha256(data).hexdigest()

def safe_member(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or '\x00' in name or p.is_absolute() or '..' in p.parts or ':' in name:
        raise Rejected('UNSAFE_ARCHIVE_PATH')
    return name

def zip_members(data, budget=None, depth=0):
    if budget is None:
        budget = [0]
    if depth > 2 or len(data) > MAX_ARCHIVE:
        raise Rejected('ARCHIVE_LIMIT')
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist()) > 256:
            raise Rejected('MEMBER_COUNT_LIMIT')
        for item in z.infolist():
            safe_member(item.filename)
            if stat.S_ISLNK(item.external_attr >> 16):
                raise Rejected('SYMLINK_DENIED')
            if item.is_dir():
                continue
            if item.filename in result:
                raise Rejected('DUPLICATE_MEMBER')
            budget[0] += item.file_size
            if budget[0] > MAX_EXPANDED:
                raise Rejected('EXPANSION_LIMIT')
            blob = z.read(item)  # CRC is checked by zipfile; no extraction or execution.
            result[item.filename] = blob
    return result

def manifest_check(members, prefix=''):
    raw = members[prefix + 'manifest.json']
    detached = members[prefix + 'manifest.sha256'].decode().split()[0]
    if sha(raw) != detached:
        raise Rejected('MANIFEST_DETACHED_HASH_MISMATCH')
    manifest = json.loads(raw)
    paths = set()
    for entry in manifest['files']:
        path = safe_member(entry['path'])
        if path in paths or path in ('manifest.json', 'manifest.sha256'):
            raise Rejected('INVALID_MANIFEST_MEMBERSHIP')
        paths.add(path)
        blob = members[prefix + path]
        if len(blob) != entry['bytes'] or sha(blob) != entry['sha256']:
            raise Rejected('MEMBER_HASH_MISMATCH')
    actual = {n[len(prefix):] for n in members if n.startswith(prefix)} - {'manifest.json', 'manifest.sha256'}
    if paths != actual:
        raise Rejected('UNMANIFESTED_MEMBER')
    return sha(raw)

class Inputs:
    def __init__(self, directory):
        directory = Path(directory).resolve(strict=True)
        self.data = {}
        self.budget = [0]
        self.total_read = 0
        self.inventory = []
        for role, (filename, size, digest) in KNOWN_INPUTS.items():
            path = directory / filename
            if path.is_symlink() or path.resolve().parent != directory:
                raise Rejected('INPUT_PATH_DENIED')
            if path.stat().st_size != size:
                raise Rejected('INPUT_SIZE_MISMATCH')
            blob = path.read_bytes()
            if sha(blob) != digest:
                raise Rejected('INPUT_HASH_MISMATCH')
            members = zip_members(blob, self.budget)
            prefix = '' if role == 'candidate' else 'Gaussian_L1_Evaluation_v0_1_0/'
            mh = manifest_check(members, prefix)
            for name, body in members.items():
                self.data[f'{role}/{name}'] = body
                if name.endswith('.zip'):
                    # Expose nested source files for bounded selective reading, never execute them.
                    for child, child_body in zip_members(body, self.budget, 1).items():
                        self.data[f'{role}/{name}!/{child}'] = child_body
            self.inventory.append({'role': role, 'bytes': size, 'sha256': digest, 'manifest_sha256': mh, 'outer_members': len(members)})

    def call(self, name, args):
        if name == 'list_inputs':
            if args:
                raise Rejected('UNEXPECTED_ARGUMENT')
            return [{'id': key, 'bytes': len(blob), 'sha256': sha(blob), 'text': not key.endswith('.zip')} for key, blob in sorted(self.data.items())]
        if name != 'read_input' or set(args) - {'id', 'offset', 'length'}:
            raise Rejected('TOOL_NOT_ALLOWED')
        key = args.get('id')
        if key not in self.data or key.endswith('.zip'):
            raise Rejected('INPUT_NOT_ALLOWED')
        offset, length = args.get('offset', 0), args.get('length', MAX_READ)
        if type(offset) is not int or type(length) is not int or offset < 0 or not 1 <= length <= MAX_READ:
            raise Rejected('READ_RANGE_INVALID')
        blob = self.data[key]
        if offset > len(blob):
            raise Rejected('READ_RANGE_INVALID')
        chunk = blob[offset:offset + length]
        if self.total_read + len(chunk) > MAX_TOTAL_READ:
            raise Rejected('TOTAL_READ_LIMIT')
        # UTF-8 bytes are returned with explicit lossless hex on a split code point.
        self.total_read += len(chunk)
        try:
            text, encoding = chunk.decode('utf-8'), 'utf-8'
        except UnicodeDecodeError:
            text, encoding = chunk.hex(), 'hex'
        return {'id': key, 'source_sha256': sha(blob), 'offset': offset, 'bytes': len(chunk), 'total_bytes': len(blob), 'next_offset': offset + len(chunk) if offset + len(chunk) < len(blob) else None, 'encoding': encoding, 'content': text}

def provider_receipt(messages, github_run_id):
    """Consume structured provider messages, never model-authored identity prose."""
    inits = [m for m in messages if m.get('type') == 'system' and m.get('subtype') == 'init']
    results = [m for m in messages if m.get('type') == 'result']
    if len(inits) != 1 or len(results) != 1:
        raise Rejected('PROVIDER_RECEIPT_INCOMPLETE')
    init, result = inits[0], results[0]
    if not init.get('session_id') or init['session_id'] != result.get('session_id'):
        raise Rejected('PROVIDER_SESSION_MISMATCH')
    if init.get('model') != EXPECTED_MODEL or set(result.get('modelUsage', {})) != {EXPECTED_MODEL}:
        raise Rejected('UNAPPROVED_MODEL_SUBSTITUTION')
    observed = {m.get('message', {}).get('model') for m in messages if m.get('type') == 'assistant'} - {None}
    if observed != {EXPECTED_MODEL}:
        raise Rejected('ACTUAL_MODEL_EVIDENCE_INCOMPLETE_OR_MISMATCH')
    if not str(github_run_id).isdigit() or result.get('is_error') or result.get('subtype') != 'success':
        raise Rejected('PROVIDER_RUN_NOT_SUCCESSFUL')
    if type(result.get('num_turns')) is not int or not 1 <= result['num_turns'] <= 12:
        raise Rejected('TURN_LIMIT')
    return {'github_run_id': str(github_run_id), 'provider_session_id': init['session_id'], 'actual_model_id': EXPECTED_MODEL, 'provider_result_type': result['subtype'], 'num_turns': result['num_turns'], 'usage': result['modelUsage'], 'proves_subscription_billing': False}

def invocation_state(attempt_record, provider_confirmation=None, transport_error=False):
    if provider_confirmation is not None:
        if not attempt_record:
            raise Rejected('CONFIRMATION_WITHOUT_ATTEMPT')
        return 'INVOCATION_CONFIRMED'
    if attempt_record:
        return 'ATTEMPTED_OUTCOME_UNKNOWN'
    if transport_error:
        raise Rejected('TRANSPORT_ERROR_WITHOUT_ATTEMPT_RECORD')
    return 'NO_INVOCATION_ATTEMPTED'

def conditional_retry(evidence):
    required = ('immutable_source', 'no_accepted_receipt', 'exact_no_commit_readback', 'unchanged_hashes', 'no_conflict', 'retry_eligibility', 'no_platform_gate', 'provider_confirms_no_invocation')
    return evidence.get('retries_used') == 0 and all(evidence.get(k) is True for k in required)

def command(claude_binary, mcp_config, schema_path):
    return [str(claude_binary), '--restricted', '--bare', '-p', '--model', EXPECTED_MODEL,
            '--tools', '', '--strict-mcp-config', '--mcp-config', str(mcp_config),
            '--allowedTools', 'mcp__capsule__list_inputs,mcp__capsule__read_input',
            '--permission-prompts', 'none', '--max-turns', '12', '--no-session-persistence',
            '--no-chrome', '--disable-slash-commands', '--output-format', 'stream-json',
            '--verbose', '--json-schema', Path(schema_path).read_text()]

def preflight():
    # A config edit cannot overcome a known incompatible deployed server.
    return {'launch_allowed': False, 'invocation_state': 'NO_INVOCATION_ATTEMPTED',
            'blockers': ['ORDINARY_REVIEWER_BINDING_UNAVAILABLE', 'CAPSULE_ONLY_SERVER_READ_SCOPE_UNAVAILABLE',
                         'UNPREDICTABLE_RESULT_COMMITMENT_UNSUPPORTED', 'INPUT_ARTIFACT_IDS_UNAVAILABLE',
                         'PRIVATE_SUBSCRIPTION_AND_INCLUDED_CAPACITY_UNVERIFIED', 'PREINSTALLED_RESTRICTED_RUNTIME_UNVERIFIED'],
            'note': 'Resolve compatibility with owner-approved source changes and exact deployed readback; changing readiness.json is insufficient.'}

def mcp(inputs):
    tools = [
        {'name': 'list_inputs', 'description': 'List exact verified capsule members; no outside paths.', 'inputSchema': {'type':'object','properties':{},'additionalProperties':False}},
        {'name': 'read_input', 'description': 'Read a bounded byte slice of one verified capsule text member.', 'inputSchema': {'type':'object','properties':{'id':{'type':'string'},'offset':{'type':'integer','minimum':0},'length':{'type':'integer','minimum':1,'maximum':MAX_READ}},'required':['id'],'additionalProperties':False}}
    ]
    while True:
        raw = sys.stdin.buffer.readline(65537)
        if not raw:
            return
        if len(raw) > 65536:
            raise Rejected('MCP_REQUEST_LIMIT')
        request = json.loads(raw)
        if 'id' not in request:
            continue
        try:
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'capsule','version':'1.0.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools':tools}
            elif method == 'tools/call':
                p = request['params']
                value = inputs.call(p['name'], p.get('arguments', {}))
                result = {'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}]}
            else:
                raise Rejected('METHOD_NOT_ALLOWED')
            response = {'jsonrpc':'2.0','id':request['id'],'result':result}
        except (Rejected, KeyError, TypeError, ValueError):
            response = {'jsonrpc':'2.0','id':request['id'],'error':{'code':-32602,'message':'CAPSULE_REQUEST_REJECTED'}}
        sys.stdout.write(json.dumps(response,ensure_ascii=False)+'\n');sys.stdout.flush()

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['preflight','inspect','serve']);p.add_argument('--inputs');a=p.parse_args()
    if a.mode == 'preflight':
        print(json.dumps(preflight()));return 78
    if not a.inputs:
        raise Rejected('INPUT_DIRECTORY_REQUIRED')
    inputs=Inputs(a.inputs)
    if a.mode=='inspect':
        print(json.dumps({'input_verification':inputs.inventory,'expanded_bytes':inputs.budget[0],'network_calls':0,'packaged_code_executed':False,'model_runs':0}))
    else:
        mcp(inputs)
    return 0

if __name__=='__main__':
    try:
        sys.exit(main())
    except Exception:
        # Do not echo input contents, tool arguments, private paths or secrets.
        print('CAPSULE_OPERATION_REJECTED',file=sys.stderr);sys.exit(1)
