// Runs inside one domain container, using only its own schema/user.
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import {createHash} from 'node:crypto';
const c=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:fs.readFileSync(process.env.DB_PASSWORD_FILE,'utf8').trim(),database:process.env.DB_NAME});
try {
 const [tables]=await c.execute("SELECT table_name name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name");
 const result={};
 for(const {name} of tables){
  if(!/^[a-zA-Z0-9_]+$/.test(name))throw Error('Invalid table identifier');
  const [rows]=await c.query('SELECT * FROM '+name);
  result[name]={count:rows.length,hash:createHash('sha256').update(rows.map(r=>JSON.stringify(r)).sort().join('\n')).digest('hex')};
 }
 console.log(JSON.stringify(result));
} finally {await c.end();}
