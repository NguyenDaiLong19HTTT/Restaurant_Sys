import {FIXED_POSITIONS,defaultRequirements} from './positions.js';
import {registrationDeadline,sqlUtc} from './week.js';

export async function migrateSchedule(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS shift_positions (
    shift_id CHAR(36) NOT NULL,
    position_id CHAR(36) NOT NULL,
    required_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (shift_id,position_id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    CHECK (required_count >= 0)
  )`);
  const [columns] = await db.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registrations' AND COLUMN_NAME='position_id'`);
  if (!columns.length) await db.execute('ALTER TABLE registrations ADD COLUMN position_id CHAR(36) NULL AFTER employee_id');
  const [sourceColumns] = await db.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registrations' AND COLUMN_NAME='source'`);
  if (!sourceColumns.length) await db.execute("ALTER TABLE registrations ADD COLUMN source ENUM('EMPLOYEE','MANAGER') NOT NULL DEFAULT 'EMPLOYEE' AFTER position_id");
  const [reasonColumns] = await db.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registrations' AND COLUMN_NAME='rejection_reason'`);
  if (!reasonColumns.length) await db.execute('ALTER TABLE registrations ADD COLUMN rejection_reason VARCHAR(500) NULL AFTER reviewed_by');
  const [upcoming] = await db.execute('SELECT id,starts_at,registration_deadline FROM shifts WHERE starts_at > UTC_TIMESTAMP()');
  for (const shift of upcoming) {
    const deadline=sqlUtc(registrationDeadline(`${shift.starts_at.replace(' ','T')}Z`));
    if (shift.registration_deadline !== deadline) await db.execute('UPDATE shifts SET registration_deadline=? WHERE id=?',[deadline,shift.id]);
  }
}

export async function fillShiftPositions(db) {
  const [shifts] = await db.execute('SELECT id,required_count FROM shifts');
  for (const shift of shifts) {
    const [existing]=await db.execute('SELECT COUNT(*) AS total FROM shift_positions WHERE shift_id=?',[shift.id]);
    if(existing[0].total===FIXED_POSITIONS.length) continue;
    const requirements=shift.required_count>=17?defaultRequirements(shift.required_count):FIXED_POSITIONS.map((position,index)=>({positionId:position.id,requiredCount:Math.floor(shift.required_count/3)+(index<shift.required_count%3?1:0)}));
    for (let index=0;index<FIXED_POSITIONS.length;index++) {
      await db.execute('INSERT IGNORE INTO shift_positions(shift_id,position_id,required_count) VALUES(?,?,?)',
        [shift.id,FIXED_POSITIONS[index].id,requirements[index].requiredCount]);
    }
  }
}
