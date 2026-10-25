import mysql from 'mysql2/promise';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {secret} from '../../../packages/http.mjs';
export const json=value=>typeof value==='string'?JSON.parse(value):value;
export function database(){
 if(process.env.DB_NAME!=='payment_db')throw new Error('Payment service must own payment_db');
 return mysql.createPool({host:process.env.DB_HOST,user:'payment_app',password:secret('PAYMENT_DB_PASSWORD_FILE'),database:'payment_db',charset:'utf8mb4',timezone:'Z',connectionLimit:12});
}
export async function migrate(pool){
 const c=await pool.getConnection();
 try{
  const [[lock]]=await c.query("SELECT GET_LOCK('payment_migration',30) AS acquired");if(lock.acquired!==1)throw new Error('Migration lock unavailable');
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(id VARCHAR(100) PRIMARY KEY,checksum CHAR(64) NOT NULL)');
  for(const id of ['001-payment','002-provider-ip-worker','003-table-checkout']){
   const sql=await readFile(new URL(`../migrations/${id}.sql`,import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
   const [[old]]=await c.execute('SELECT checksum FROM schema_migrations WHERE id=?',[id]);
   if(old&&old.checksum!==hash)throw new Error('Applied payment migration changed');
   if(!old){
    // MySQL DDL commits implicitly. Check individual additions so a partially applied migration can be retried safely.
    for(const s of sql.split(';').map(s=>s.trim()).filter(Boolean)){
     if(id!=='001-payment'){
      const column=s.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i),index=s.match(/^CREATE INDEX (\w+) ON (\w+)/i);
      if(column){const[[exists]]=await c.execute('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',[column[1],column[2]]);if(exists.n)continue;}
      if(index){const[[exists]]=await c.execute('SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?',[index[2],index[1]]);if(exists.n)continue;}
     }
     await c.query(s);
    }
    await c.execute('INSERT INTO schema_migrations VALUES (?,?)',[id,hash]);
   }
  }
  if(process.env.SEED_VOUCHERS==='true'){for(const [code,kind,value,cap] of [['GIAM10','PERCENT',1000,30000],['GIAM20K','FIXED',20000,20000]])await c.execute('INSERT IGNORE INTO vouchers(code,kind,value,max_discount_vnd,min_total_vnd,max_uses,expires_at) VALUES (?,?,?,?,?,?,?)',[code,kind,value,cap,100000,10000,'2099-12-31 23:59:59']);}
  if(process.env.ORDER_ADAPTER==='demo'){
   if(process.env.NODE_ENV==='production')throw new Error('Demo order adapter forbidden in production');
   const [[seed]]=await c.execute('SELECT id FROM schema_migrations WHERE id=?',['demo-v1']);
   if(!seed){
    await c.beginTransaction();
    for(let n=1;n<=6;n++)await c.execute('INSERT IGNORE INTO demo_orders(id,branch_id,code,items) VALUES (?,?,?,?)',[`demo-order-${n}`,'demo-branch-a',`DEMO-${String(n).padStart(3,'0')}`,JSON.stringify([{dishId:'11111111-1111-4111-8111-111111111111',dishNameSnapshot:'Phở bò đặc biệt',unitPriceVnd:85000,quantity:2},{dishId:'33333333-3333-4333-8333-333333333333',dishNameSnapshot:'Trà đào cam sả',unitPriceVnd:39000,quantity:2}])]);
    for(const [code,kind,value,cap] of [['GIAM10','PERCENT',1000,30000],['GIAM20K','FIXED',20000,20000]])await c.execute('INSERT IGNORE INTO vouchers(code,kind,value,max_discount_vnd,min_total_vnd,max_uses,expires_at) VALUES (?,?,?,?,?,?,?)',[code,kind,value,cap,100000,10000,'2099-12-31 23:59:59']);
    await c.execute('INSERT INTO schema_migrations VALUES (?,?)',['demo-v1','demo-v1']);await c.commit();
   }
   const[[tableSeed]]=await c.execute('SELECT id FROM schema_migrations WHERE id=?',['demo-tables-v1']);
   if(!tableSeed){
    await c.beginTransaction();
    for(let n=1;n<=4;n++)await c.execute('INSERT IGNORE INTO demo_tables(id,branch_id,name,occupancy) VALUES (?,?,?,?)',[`demo-table-${n}`,'demo-branch-a',`Bàn ${n}`,n===3?'OCCUPIED':'AVAILABLE']);
    for(const[suffix,items]of [['a',[{dishNameSnapshot:'Phở bò đặc biệt',unitPriceVnd:85000,quantity:2},{dishNameSnapshot:'Trà đào cam sả',unitPriceVnd:39000,quantity:2}]],['b',[{dishNameSnapshot:'Gỏi cuốn tôm thịt',unitPriceVnd:55000,quantity:1}]]])await c.execute('INSERT IGNORE INTO demo_orders(id,branch_id,code,items,table_id) VALUES (?,?,?,?,?)',[`demo-table3-order-${suffix}`,'demo-branch-a',`BAN3-${suffix.toUpperCase()}`,JSON.stringify(items),'demo-table-3']);
    await c.execute('INSERT INTO schema_migrations VALUES (?,?)',['demo-tables-v1','demo-tables-v1']);await c.commit();
   }
  }
 }catch(e){await c.rollback();throw e;}finally{await c.query("SELECT RELEASE_LOCK('payment_migration')");c.release();}
}
export async function transaction(pool,fn){const c=await pool.getConnection();try{await c.beginTransaction();const result=await fn(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}
