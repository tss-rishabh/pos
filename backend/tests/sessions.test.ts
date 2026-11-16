import {describe,expect,it} from 'vitest';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {memorySessions} from '../src/auth/sessions.js';

describe('revocable server sessions',()=>{
  it('revokes stolen-cookie replay on logout and checks actor/secret binding',async()=>{
    const app=await buildApp(readConfig({NODE_ENV:'test',DEMO_MODE:'true',SESSION_SECRET:'revocation-test-fixture-'.repeat(3)}));
    try{
      const response=await app.inject({method:'POST',url:'/api/v1/auth/demo-sessions',headers:{origin:'http://localhost:5173'}});
      const cookie=response.cookies[0]!.name+'='+response.cookies[0]!.value;
      expect((await app.inject({url:'/api/v1/stores',headers:{cookie}})).statusCode).toBe(200);
      expect((await app.inject({method:'DELETE',url:'/api/v1/auth/sessions/current',headers:{cookie,origin:'http://localhost:5173'}})).statusCode).toBe(204);
      expect((await app.inject({url:'/api/v1/stores',headers:{cookie}})).statusCode).toBe(401);
    }finally{await app.close();}
    const service=memorySessions(),credential=await service.create('1');
    expect(await service.valid('1',credential)).toBe(true);expect(await service.valid('2',credential)).toBe(false);
    expect(await service.valid('1',{...credential,secret:'x'.repeat(43)})).toBe(false);
  });
});
