import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),name=process.argv[2];
if(process.env.NODE_ENV==='production')throw Error('Demo seed is prohibited in production');
for(const [key,value] of Object.entries(process.env))if(key.endsWith('_FILE')&&!['JWT_PUBLIC_KEY_FILE','JWT_PRIVATE_KEY_FILE','VNPAY_CONFIG_FILE'].includes(key))process.env[key.slice(0,-5)]=fs.readFileSync(value,'utf8').trim();
process.env.SEED_DEMO='true';process.env.SEED_DEMO_DATA='true';process.env.SEED_VOUCHERS='true';
try {
 if(['menu','payment'].includes(name)){const m=await import('../services/'+name+'/src/db.mjs'),pool=m.database();try{await m.migrate(pool);}finally{await pool.end();}}
 else if(['reservation','inventory'].includes(name))await require('../services/'+name+'/src/migrate.js').runMigrations();
 else {
  await (await import('./service-migrate.mjs')).run(name);
  if(name==='identity')await (await import('./identity-seed.mjs')).seed();
  if(name==='staff'){
   const c=await require('mysql2/promise').createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:'staff_db',multipleStatements:true});
   try{await c.query(fs.readFileSync('services/staff/seeds/001-local.sql','utf8'));}finally{await c.end();}
  }
 }
 console.log('Seed complete: '+name+' (existing records preserved)');process.exit(0);
}catch{console.error('Seed failed: '+name+'; inspect migration/configuration, no credentials printed');process.exit(1);}
