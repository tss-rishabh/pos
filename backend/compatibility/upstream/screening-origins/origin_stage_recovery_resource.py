"""Authenticated source recovery receipt resource; no provider/source dispatch."""
from origin_contracts import UUID, canonical, fail
from origin_stage_recovery import StageRecoveryIssuer, REASONS


class StageRecoveryResource:
    """POST exact {recoveryId,reason}; GET exact ?recoveryId=UUID.

    Mount at /screening-origins/{command_id}/stage-recovery beneath the original
    source middleware. The issuer independently validates current customer JWT,
    native staff session/grant or the genuine original CSK API key.
    """
    def __init__(self, owner, system_owner=None):
        self.issuer = StageRecoveryIssuer(owner, system_owner)

    def respond(self, resp, value):
        resp.set_header('Cache-Control', 'private, no-store')
        resp.text = canonical(value)
        if value.get('missing') is True:
            resp.status = '404 Not Found'

    def on_post(self, req, resp, command_id):
        body = req.context.get('data')
        if (dict(req.params) or not isinstance(body, dict) or set(body) != {'recoveryId', 'reason'}
                or not isinstance(body['recoveryId'], str) or not UUID.fullmatch(body['recoveryId'])
                or not isinstance(body['reason'], str) or body['reason'] not in REASONS):
            fail('SCREENING_ORIGIN_REQUEST_INVALID')
        self.respond(resp, self.issuer.issue(req, command_id, body['recoveryId'], body['reason']))

    def on_get(self, req, resp, command_id):
        params = dict(req.params)
        if set(params) != {'recoveryId'} or not isinstance(params['recoveryId'], str) or not UUID.fullmatch(params['recoveryId']):
            fail('SCREENING_ORIGIN_REQUEST_INVALID')
        self.respond(resp, self.issuer.read(req, command_id, params['recoveryId']))
