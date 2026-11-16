import {expect,it} from 'vitest';
import {boundedJson} from '../src/domain/http-json.js';

it('preserves arbitrary-size integer tokens and enforces streaming size bounds',async()=>{
  expect(await boundedJson(new Response('{"id":9007199254740993,"ordinary":17,"price":19.99}'))).toEqual({id:'9007199254740993',ordinary:17,price:19.99});
  await expect(boundedJson(new Response('"'+'x'.repeat(100)+'"'),20)).rejects.toMatchObject({code:'INVALID_UPSTREAM_RESPONSE'});
  await expect(boundedJson(new Response('not JSON'))).rejects.toMatchObject({code:'INVALID_UPSTREAM_RESPONSE'});
});
