import {randomUUID} from 'node:crypto';
import {pool} from '../../shared/db.js';
import {FIXED_POSITIONS} from './positions.js';
import {registrationDeadline} from './week.js';

const BRANCH_ID = '00000000-0000-0000-0000-000000000001';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const db = pool('schedule_db');

function vietnamToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function sqlUtc(value) {
  return new Date(value).toISOString().slice(0,19).replace('T',' ');
}

const anchor = process.argv[2] || vietnamToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || Number.isNaN(Date.parse(`${anchor}T00:00:00Z`))) {
  console.error('Ngày phải có dạng YYYY-MM-DD');
  process.exit(1);
}

const date = new Date(`${anchor}T00:00:00Z`);
const monday = date.getTime() - ((date.getUTCDay()+6)%7)*DAY;
const slots = [[8,12],[12,16],[16,22]];
const connection = await db.getConnection();
try {
  await connection.beginTransaction();
  const [old] = await connection.execute('SELECT id FROM shifts WHERE branch_id=? FOR UPDATE', [BRANCH_ID]);
  for (const {id} of old) {
    await connection.execute('DELETE FROM attendance WHERE shift_id=?', [id]);
    await connection.execute('DELETE FROM registrations WHERE shift_id=?', [id]);
    await connection.execute('DELETE FROM staff_requests WHERE shift_id=?', [id]);
    await connection.execute('DELETE FROM shift_positions WHERE shift_id=?', [id]);
    await connection.execute('DELETE FROM shifts WHERE id=?', [id]);
  }
  for (let day=0; day<14; day++) {
    for (const [startHour,endHour] of slots) {
      const start = monday + day*DAY + (startHour-7)*HOUR;
      const end = monday + day*DAY + (endHour-7)*HOUR;
      const id = randomUUID();
      const total=FIXED_POSITIONS.reduce((sum,position)=>sum+position.minimum,0);
      await connection.execute(
        'INSERT INTO shifts(id,branch_id,starts_at,ends_at,registration_deadline,required_count) VALUES(?,?,?,?,?,?)',
        [id,BRANCH_ID,sqlUtc(start),sqlUtc(end),sqlUtc(registrationDeadline(start)),total]
      );
      for (const position of FIXED_POSITIONS) {
        await connection.execute(
          'INSERT INTO shift_positions(shift_id,position_id,required_count) VALUES(?,?,?)',
          [id,position.id,position.minimum]
        );
      }
    }
  }
  await connection.commit();
  console.log(`Đã xóa ${old.length} ca cũ và tạo 42 ca cho tuần hiện tại, tuần kế tiếp.`);
} catch (error) {
  await connection.rollback();
  console.error(error);
  process.exitCode = 1;
} finally {
  connection.release();
  await db.end();
}
