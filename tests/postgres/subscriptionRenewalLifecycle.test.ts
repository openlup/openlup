import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool,type PoolClient } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { assertPortableCreationStatements } from '../../scripts/reviewed-platform-forward.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable,runPostgresContainer,waitForPostgresTcpReady,type PostgresContainer } from '../helpers/postgresContainer.js';
import { registerAdapterCases } from './subscriptionRenewalAdapterCases.js';
import { registerCommandCases } from './subscriptionCommandLifecycleCases.js';
import { registerRetryCases } from './subscriptionRetryLifecycleCases.js';
import { registerAlignmentRollbackCases } from './subscriptionAlignmentRollbackCases.js';
const manifest=JSON.parse(readFileSync('config/platform-migration-manifest.json','utf8'));
const units:{file:string;sha256:string}[]=[manifest.baseline,...manifest.forward];
const probeFiles=['db/platform/migrations/20261022160000_subscription_retry_lifecycle.sql',
 'db/platform/migrations/20261024170000_subscription_command_lifecycle.sql'];
const probeIndexes=probeFiles.map(file=>units.findIndex(u=>u.file===file));
const index=probeIndexes[0];
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
async function snapshot(db:Pool|PoolClient) {
 // PostgreSQL records SQL-file byte offsets in default-expression ASTs.
 // Normalize only those offsets; retain the full AST and deparsed defaults.
 const procs=(await db.query(`SELECT p.oid,(to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object(
  'proargdefaults',regexp_replace(p.proargdefaults::text,':location -?[0-9]+',':location -1','g'),
  'arguments',pg_get_function_arguments(p.oid)) attributes,p.prosrc FROM pg_proc p ORDER BY p.oid`)).rows;
 const relations=(await db.query(`SELECT c.oid,c.relowner,c.relacl::text,c.reloptions,c.relkind,c.relname,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid) attributes
 FROM pg_class c ORDER BY c.oid`)).rows;
 const types=(await db.query(`SELECT oid,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') definition FROM pg_type t ORDER BY oid`)).rows;
 const triggers=(await db.query(`SELECT oid,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') definition FROM pg_trigger t WHERE NOT tgisinternal ORDER BY oid`)).rows;
 return {procs,relations,types,triggers};
}
const names=[['subscription_retry_read','subscription_retry_candidates','subscription_retry_apply_failure','subscription_retry_open_case',
 'subscription_retry_authorize_recovery','subscription_retry_schedule_recovery','subscription_retry_prepare','subscription_retry_record_recovery','subscription_retry_note_row_outcome'],['subscription_command_preview','subscription_command_apply']];
const tables=[['subscription_retry_obligations','subscription_retry_receipts','subscription_retry_recovery_authorizations'],['subscription_command_receipts']];
let container:PostgresContainer|undefined,pool:Pool;
const h={get pool(){return pool;}};
const checked:string[]=[];
let prefixLedger:unknown[]=[];
const runner=()=>createPostgresMigrationRunner({connectionString:container!.connectionString},{poolFactory:()=>pool});
beforeAll(async()=>{
 if(!await dockerAvailable()) throw Error('M10 requires real PostgreSQL');
 container=await runPostgresContainer({name:`m10-p2-shared-${process.pid}`,password:'synthetic-conformance'});
 if(!await waitForPostgresTcpReady(container.connectionString)) throw Error('M10 PG unavailable');
 pool=new Pool({connectionString:container.connectionString});
 const db=await pool.connect(),query=db.query.bind(db);
 // Observe the runner's actual SQL boundary. A savepoint exercises rollback of
 // each M10 forward; interleaved and later units run without probing. The full baseline/prefix
 // is installed only once. Restore
 // the connection before any behavior/concurrency fixture uses the pool.
 db.query=(async(sql:string,values?:unknown[])=>{
  const n=probeIndexes.findIndex(i=>i>=0 && readFileSync(units[i].file,'utf8')===sql);
  if(n<0) return query(sql,values);
  const unitIndex=probeIndexes[n],u=units[unitIndex],bytes=readFileSync(u.file);
  if(n===0 && prefixLedger.length===0) {
   prefixLedger=(await query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
   // Stop before new DDL, leaving an installed exact prefix. The second
   // invocation must validate that ledger and upgrade N1 and N2.
   throw Error('m10_exact_prefix_boundary');
  }
  expect(sha(bytes)).toBe(u.sha256);
  expect(readFileSync(`packages/platform/sql/${u.file.split('/').at(-1)}`)).toEqual(bytes);
  assertPortableCreationStatements(bytes,units.slice(0,unitIndex).map(p=>readFileSync(p.file)));
  const before=await snapshot(db);
  await query('SAVEPOINT creation_probe');
  await query(sql);
  const after=await snapshot(db);
  for(const kind of ['procs','relations','types','triggers'] as const) {
   const current=new Map(after[kind].map(r=>[r.oid,r]));
   for(const row of before[kind]) {
    const actual=current.get(row.oid);
    expect(actual,`${u.file}: ${kind} ${row.oid}`).toEqual(row);
   }
  }
  const old=new Set(before.procs.map(r=>r.oid)),addedIds=after.procs.filter(r=>!old.has(r.oid)).map(r=>r.oid);
  const added=(await query('SELECT oid,proname,prosecdef,proconfig FROM pg_proc WHERE oid=ANY($1::oid[])',[addedIds])).rows;
  expect(added.map(p=>p.proname).sort()).toEqual([...names[n]].sort());
  for(const p of added) {
   expect(p.prosecdef).toBe(false);expect(p.proconfig).toEqual(['search_path=pg_catalog']);
   const acl=(await query(`SELECT x.* FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
    WHERE p.oid=$1 AND x.privilege_type='EXECUTE' AND (x.grantee=0 OR x.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated')))`,[p.oid])).rows;
   expect(acl).toEqual([]);
  }
  const oldRelations=new Set(before.relations.map(r=>r.oid));
  const addedRelations=after.relations.filter(r=>!oldRelations.has(r.oid));
  expect(addedRelations.filter(r=>r.relkind==='r').map(r=>r.relname).sort()).toEqual([...tables[n]].sort());
  expect(addedRelations.filter(r=>!['r','i','t'].includes(r.relkind))).toEqual([]);
  await query('ROLLBACK TO creation_probe');
  expect(await snapshot(db)).toEqual(before);
  await query('RELEASE SAVEPOINT creation_probe');
  checked.push(u.file);
  return query(sql,values);
 }) as typeof db.query;
 db.release();
 try {
  expect(index).toBeGreaterThan(0);
  expect(probeIndexes[1]).toBeGreaterThan(index);
  expect(probeIndexes.map(i=>units[i].file)).toEqual(probeFiles);
  await expect(runner().apply()).rejects.toThrow('m10_exact_prefix_boundary');
  expect(prefixLedger).toHaveLength(index);
  expect((await runner().apply()).applied).toEqual(units.slice(index).map(u=>u.file));
 }
 finally{db.query=query;}
},postgresSetupTimeoutMs);
afterAll(async()=>{await closePostgres(container, pool);}, postgresTeardownTimeoutMs);
it('upgrades the exact prefix, preserves old catalogs, closes N1/N2 ACLs, rolls back and replays the runner',async()=>{
 expect(checked).toEqual(probeFiles);
 expect((await pool.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows.slice(0,index)).toEqual(prefixLedger);
 expect(await runner().apply()).toEqual({applied:[]});expect((await runner().status()).pending).toEqual([]);
});
describe('N1 retry lifecycle',()=>registerRetryCases(h));
describe('P1 rollback branches',()=>registerAlignmentRollbackCases(h));
describe('selected P2 adapters',()=>registerAdapterCases(h));

describe('N2 command lifecycle',()=>registerCommandCases(h));
