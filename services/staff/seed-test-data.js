import bcrypt from 'bcryptjs';
import {randomUUID} from 'node:crypto';
import {pool} from '../../shared/db.js';
import {FIXED_POSITIONS} from '../schedule/positions.js';
import {registrationDeadline,sqlUtc,weekOf} from '../schedule/week.js';

const staff=pool('staff_db'),identity=pool('identity_db'),schedule=pool('schedule_db');
const branch='00000000-0000-0000-0000-000000000001';
const passwordHash=await bcrypt.hash('123',10);
const accounts=[];
try {
  await staff.execute('CREATE TABLE IF NOT EXISTS demo_seed_runs (name VARCHAR(60) PRIMARY KEY,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const [seeded]=await staff.execute('SELECT name FROM demo_seed_runs WHERE name=?',['restaurant-demo-v1']);
  if (seeded.length) {
    console.log('Dữ liệu mẫu đã có; giữ nguyên các thay đổi của người dùng.');
  } else {
  const [managers]=await identity.execute("SELECT id FROM accounts WHERE role='MANAGER' AND branch_id=? LIMIT 1",[branch]);
  if(managers.length) await identity.execute('UPDATE accounts SET email=?,password_hash=?,status=? WHERE id=?',['quanly@example.com',passwordHash,'ACTIVE',managers[0].id]);
  else await identity.execute('INSERT INTO accounts(id,email,password_hash,role,branch_id) VALUES(?,?,?,?,?)',[randomUUID(),'quanly@example.com',passwordHash,'MANAGER',branch]);
  for(const [prefix,position,count] of [['phucvu',FIXED_POSITIONS[0],5],['tiepnhan',FIXED_POSITIONS[1],2],['bep',FIXED_POSITIONS[2],10]]) {
    for(let serial=1;serial<=count;serial++) {
      const email=`${prefix}${serial}@example.com`;
      let [rows]=await staff.execute('SELECT id FROM employees WHERE email=?',[email]);
      const id=rows[0]?.id||randomUUID();
      if(!rows.length) await staff.execute('INSERT INTO employees(id,branch_id,position_id,full_name,date_of_birth,gender,citizen_id,phone,email,address,start_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[
        id,branch,position.id,`${position.name} ${serial}`,'2000-01-01','OTHER',`888${String(position.id.slice(-1))}${String(serial).padStart(8,'0')}`,`08${String(position.id.slice(-1))}${String(serial).padStart(7,'0')}`,email,'Chi nhánh 1','2026-01-01'
      ]);
      const [existing]=await identity.execute('SELECT id FROM accounts WHERE id=?',[id]);
      if(existing.length) await identity.execute('UPDATE accounts SET password_hash=?,status=? WHERE id=?',[passwordHash,'ACTIVE',id]);
      else await identity.execute('INSERT INTO accounts(id,email,password_hash,role,branch_id) VALUES(?,?,?,?,?)',[id,email,passwordHash,'EMPLOYEE',branch]);
      accounts.push({id,email,position:position.id});
    }
  }
  const monday=weekOf(new Date()),day=86400000,hour=3600000;
  const now=Date.now();
  let shifts=0,registrations=0;
  for(let offset=0;offset<14;offset++) {
    for(const [start,end] of [[8,12],[12,16],[16,22]]) {
      const begins=monday+offset*day+(start-7)*hour;
      if(begins<=now) continue;
      const startsAt=sqlUtc(begins);
      let [rows]=await schedule.execute('SELECT id FROM shifts WHERE branch_id=? AND starts_at=?',[branch,startsAt]);
      const shiftId=rows[0]?.id||randomUUID();
      if(!rows.length) {
        await schedule.execute('INSERT INTO shifts(id,branch_id,starts_at,ends_at,registration_deadline,required_count) VALUES(?,?,?,?,?,?)',[shiftId,branch,startsAt,sqlUtc(monday+offset*day+(end-7)*hour),sqlUtc(registrationDeadline(begins)),17]);
        for(const position of FIXED_POSITIONS) await schedule.execute('INSERT INTO shift_positions(shift_id,position_id,required_count) VALUES(?,?,?)',[shiftId,position.id,position.minimum]);
        shifts++;
      }
      for(const account of accounts.filter(item=>item.email.endsWith('1@example.com'))) {
        const [found]=await schedule.execute('SELECT id FROM registrations WHERE shift_id=? AND employee_id=?',[shiftId,account.id]);
        if(!found.length){await schedule.execute('INSERT INTO registrations(id,shift_id,employee_id,position_id) VALUES(?,?,?,?)',[randomUUID(),shiftId,account.id,account.position]);registrations++;}
      }
    }
  }
  await staff.execute('INSERT INTO demo_seed_runs(name) VALUES(?)',['restaurant-demo-v1']);
  console.log(`Đã chuẩn bị ${accounts.length} nhân viên, ${shifts} ca trong tuần hiện tại/tuần tới và ${registrations} đăng ký mẫu.`);
  }
} finally {await Promise.all([staff.end(),identity.end(),schedule.end()]);}
