import { expect,test } from 'vitest';
import { testDatabase } from '../helpers/database.js';
test('migrations enforce tenant RLS and prevent foreign-tenant writes',async()=>{
 const db=await testDatabase();try {
 const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
 await db.system.query("insert into organizations(id,name) values($1,'A'),($2,'B')",[a,b]);
 await db.tenant(a,async sql=>{await sql.query("insert into connections(organization_id,name,connector_id) values($1,'Private CRM','demo-crm')",[a]);});
 expect((await db.tenant(b,sql=>sql.query('select * from connections'))).rows).toHaveLength(0);
 await expect(db.tenant(b,sql=>sql.query("insert into connections(organization_id,name,connector_id) values($1,'Forbidden','demo-crm')",[a]))).rejects.toThrow(/row-level security/);
 }finally{await db.close();}
});
