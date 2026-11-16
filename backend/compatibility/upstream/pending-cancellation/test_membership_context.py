import importlib.util
import os
from pathlib import Path
import sys
import traceback
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

reader=load('isolated_membership_context',ROOT/'membership_context.py')
prepare=load('isolated_membership_prepare',ROOT/'prepare_membership_reader.py')
class Rejected(Exception): pass
falcon=SimpleNamespace(HTTPForbidden=Rejected,HTTPServiceUnavailable=Rejected)
class Response:
    def __init__(self):self.headers={}
    def set_header(self,key,value):self.headers[key]=value
class MembershipContextTests(unittest.TestCase):
    def scope(self):return SimpleNamespace(context={reader.PRIVATE_CONTEXT:{'subject':'9007199254740993','loaded':True}})
    def fixture(self,member=True,revision=9007199254740993,user_patch=None):
        calls=[]
        def fetch(_session,statement,params,to_dict):
            self.assertTrue(to_dict);self.assertIn('FOR SHARE',statement);calls.append((statement,params))
            if 'FROM users' in statement:return {'id':9007199254740993,'email':'synthetic@example.test','status':1,'is_block':0,'is_disabled':None,**(user_patch or {})}
            if 'membership_versions' in statement:return None if revision is None else {'revision':revision}
            if 'user_eav' in statement:return {'entity':'synthetic@example.test'} if member else None
            raise AssertionError('Unexpected membership SQL')
        return fetch,calls
    def test_verified_overlay_and_no_direct_cache_calls(self):
        manifest=prepare.build();self.assertFalse(manifest['enabled']);self.assertEqual(len(manifest['candidateSha256']),2)
    def test_nonprivate_request_keeps_literal_existing_reader(self):
        calls=[]
        result=reader.fresh_membership_token(SimpleNamespace(context={}),Response(),object(),7,'synthetic@example.test',lambda *args:calls.append(args) or 'original',lambda *_:self.fail('No private SQL'),falcon)
        self.assertEqual(result,'original');self.assertEqual(len(calls),1)
    def test_private_current_boolean_and_exact_large_revision_never_call_cache(self):
        with patch.dict(os.environ,{'POS_MEMBERSHIP_FRESH_READER_CONTRACT':reader.CONTRACT}):
            for present in (False,True):
                req=self.scope();resp=Response();fetch,calls=self.fixture(present)
                result=reader.fresh_membership_token(req,resp,object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No cached private membership'),fetch,falcon)
                self.assertEqual(result,present);self.assertEqual(len(calls),3);self.assertEqual(resp.headers['X-POS-Membership-Revision'],'9007199254740993');self.assertEqual(resp.headers['Cache-Control'],'private, no-store')
                self.assertTrue(all('synthetic@example.test' not in statement for statement,_ in calls))
    def test_unconfigured_or_wrong_subject_reject_before_sql(self):
        for configured,loaded,subject in [(False,True,'9007199254740993'),(True,False,'9007199254740993'),(True,True,'7')]:
            req=self.scope();req.context[reader.PRIVATE_CONTEXT].update(loaded=loaded,subject=subject)
            with patch.dict(os.environ,{'POS_MEMBERSHIP_FRESH_READER_CONTRACT':reader.CONTRACT if configured else ''}):
                with self.assertRaises(Rejected):reader.fresh_membership_token(req,Response(),object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No fallback'),lambda *_args,**_kwargs:self.fail('No SQL'),falcon)
    def test_revoked_or_changed_customer_never_receives_membership_context(self):
        for fields in ({'status':0},{'is_block':1},{'is_disabled':1},{'is_disabled':'0'},{'email':'changed@example.test'}):
            with patch.dict(os.environ,{'POS_MEMBERSHIP_FRESH_READER_CONTRACT':reader.CONTRACT}):
                fetch,calls=self.fixture(user_patch=fields);resp=Response()
                with self.assertRaises(Rejected):reader.fresh_membership_token(self.scope(),resp,object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No cache'),fetch,falcon)
                self.assertEqual(len(calls),1);self.assertEqual(resp.headers,{})
    def test_bad_revision_and_sql_error_do_not_fall_back(self):
        with patch.dict(os.environ,{'POS_MEMBERSHIP_FRESH_READER_CONTRACT':reader.CONTRACT}):
            for revision in (-1,'0',True,18446744073709551616):
                fetch,_=self.fixture(revision=revision)
                with self.assertRaises(Rejected):reader.fresh_membership_token(self.scope(),Response(),object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No cache'),fetch,falcon)
            def broken(*_args,**_kwargs):raise RuntimeError('private SQL/body canary')
            try:
                reader.fresh_membership_token(self.scope(),Response(),object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No cache'),broken,falcon)
            except Rejected as error:
                # Check while the traceback is live: assertRaises clears it.
                rendered = traceback.format_exc()
                self.assertTrue(error.__suppress_context__)
                self.assertNotIn('canary',str(error))
                self.assertNotIn('private SQL/body canary',rendered)
                self.assertNotIn('RuntimeError',rendered)
            else:
                self.fail('SQL failure must reject private membership context')
    def test_factory_context_uses_same_fresh_scope_without_response_or_cache(self):
        with patch.dict(os.environ,{'POS_MEMBERSHIP_FRESH_READER_CONTRACT':reader.CONTRACT}):
            req=self.scope();fetch,calls=self.fixture(revision=None)
            self.assertTrue(reader.fresh_membership_from_context(req.context,object(),9007199254740993,'synthetic@example.test',lambda *_:self.fail('No cache'),fetch,falcon));self.assertEqual(req.context[reader.PRIVATE_CONTEXT]['membership_revision'],'0');self.assertEqual(len(calls),3)

if __name__=='__main__':unittest.main()
