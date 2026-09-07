"""Synthetic parser fixtures only. No provider calls or evaluation questions."""
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
import adapter as a

def zipped(entries):
    f=io.BytesIO()
    with zipfile.ZipFile(f,'w') as z:
        for name,data in entries:z.writestr(name,data)
    return f.getvalue()

def messages(model='claude-opus-5'):
    return [{'type':'system','subtype':'init','session_id':'fixture-only','model':model},
            {'type':'assistant','message':{'model':model}},
            {'type':'result','subtype':'success','session_id':'fixture-only','is_error':False,'num_turns':3,'modelUsage':{model:{'inputTokens':1}}}]

class AdapterTests(unittest.TestCase):
    def test_known_server_always_blocks(self):
        self.assertFalse(a.preflight()['launch_allowed'])
    def test_no_attempt(self):
        self.assertEqual(a.invocation_state(None),'NO_INVOCATION_ATTEMPTED')
    def test_ambiguous_attempt_stays_unknown(self):
        self.assertEqual(a.invocation_state({'intent':'fixture'},transport_error=True),'ATTEMPTED_OUTCOME_UNKNOWN')
    def test_confirmation_requires_attempt(self):
        with self.assertRaises(a.Rejected):a.invocation_state(None,{'run_id':'1'})
    def test_confirmed_is_separate(self):
        self.assertEqual(a.invocation_state({'intent':'fixture'},{'run_id':'1'}),'INVOCATION_CONFIRMED')
    def test_empty_receipt_not_no_commit_proof(self):
        self.assertFalse(a.conditional_retry({'no_accepted_receipt':True,'retries_used':0}))
    def test_reconciled_single_retry_only(self):
        e={k:True for k in ('immutable_source','no_accepted_receipt','exact_no_commit_readback','unchanged_hashes','no_conflict','retry_eligibility','no_platform_gate','provider_confirms_no_invocation')};e['retries_used']=0
        self.assertTrue(a.conditional_retry(e));e['retries_used']=1;self.assertFalse(a.conditional_retry(e))
    def test_actual_provider_fields_required(self):
        r=a.provider_receipt(messages(), '123');self.assertEqual(r['actual_model_id'],a.EXPECTED_MODEL);self.assertFalse(r['proves_subscription_billing'])
    def test_alias_is_not_exact_model(self):
        with self.assertRaises(a.Rejected):a.provider_receipt(messages('opus'),'123')
    def test_midrun_substitution_rejected(self):
        m=messages();m[1]['message']['model']='claude-sonnet-5'
        with self.assertRaises(a.Rejected):a.provider_receipt(m,'123')
    def test_narrative_is_not_provider_receipt(self):
        with self.assertRaises(a.Rejected):a.provider_receipt([{'model':'claude-opus-5','text':'I am Opus 5'}],'123')
    def test_failed_provider_result_rejected(self):
        m=messages();m[-1]['is_error']=True
        with self.assertRaises(a.Rejected):a.provider_receipt(m,'123')
    def test_traversal_rejected(self):
        with self.assertRaises(a.Rejected):a.zip_members(zipped([('../secret','fixture')]))
    def test_duplicate_rejected(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            b=zipped([('x','fixture'),('x','fixture')])
        with self.assertRaises(a.Rejected):a.zip_members(b)
    def test_symlink_rejected(self):
        f=io.BytesIO()
        with zipfile.ZipFile(f,'w') as z:
            i=zipfile.ZipInfo('link');i.external_attr=(stat.S_IFLNK | 0o777)<<16;z.writestr(i,'fixture')
        with self.assertRaises(a.Rejected):a.zip_members(f.getvalue())
    def test_hash_tampering_rejected(self):
        m={'files':[{'path':'x','bytes':1,'sha256':a.sha(b'x')}]};raw=json.dumps(m).encode()
        with self.assertRaises(a.Rejected):a.manifest_check({'manifest.json':raw,'manifest.sha256':a.sha(raw).encode(),'x':b'y'})
    def test_tool_path_and_limit(self):
        i=object.__new__(a.Inputs);i.data={'candidate/x':b'fixture'};i.total_read=0
        with self.assertRaises(a.Rejected):i.call('read_input',{'id':'../../secret'})
        with self.assertRaises(a.Rejected):i.call('Bash',{})
        with self.assertRaises(a.Rejected):i.call('read_input',{'id':'candidate/x','length':32769})
        self.assertEqual(i.call('read_input',{'id':'candidate/x','length':3})['next_offset'],3)
    def test_total_budget(self):
        i=object.__new__(a.Inputs);i.data={'candidate/x':b'fixture'};i.total_read=a.MAX_TOTAL_READ
        with self.assertRaises(a.Rejected):i.call('read_input',{'id':'candidate/x'})
    def test_command_has_no_broad_tools_or_fallback(self):
        c=a.command('/pinned/claude','/private/mcp.json',Path(__file__).with_name('result.schema.json'))
        self.assertEqual(c[c.index('--tools')+1],'');self.assertIn('--restricted',c);self.assertNotIn('--fallback-model',c);self.assertNotIn('--dangerously-skip-permissions',c)
    def test_finite_turns(self):
        m=messages();m[-1]['num_turns']=13
        with self.assertRaises(a.Rejected):a.provider_receipt(m,'123')

if __name__=='__main__':unittest.main()
