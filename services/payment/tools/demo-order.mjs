import {randomUUID} from 'node:crypto';
import {database} from '../src/db.mjs';
if(process.env.ORDER_ADAPTER!=='demo'||process.env.NODE_ENV==='production')throw new Error('Demo order creation is development only');
const p=database(),id=`demo-${randomUUID()}`;
try{await p.execute('INSERT INTO demo_orders(id,branch_id,code,items,table_id) VALUES (?,?,?,?,?)',[id,'demo-branch-a',`DEMO-${id.slice(-8).toUpperCase()}`,JSON.stringify([{dishNameSnapshot:'Phở bò đặc biệt',unitPriceVnd:85000,quantity:2},{dishNameSnapshot:'Trà đào cam sả',unitPriceVnd:39000,quantity:2}]),'demo-table-3']);await p.execute("UPDATE demo_tables SET occupancy='OCCUPIED' WHERE id='demo-table-3'");console.log(JSON.stringify({id,tableId:'demo-table-3'}));}finally{await p.end();}
