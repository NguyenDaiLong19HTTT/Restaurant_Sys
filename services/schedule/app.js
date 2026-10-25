import {randomUUID} from 'node:crypto';
import {pool, one, transaction} from '../../shared/db.js';
import {app, auth, call, errors, fail, internal, manager, requiredText, route, staffUrl, validDatetime} from '../../shared/api.js';
import {FIXED_POSITIONS,defaultRequirements} from './positions.js';
import {migrateSchedule,fillShiftPositions} from './migrate.js';
import {canRegister,isNextWeekShift,registrationDeadline,sqlUtc,weekOf} from './week.js';

const db = pool('schedule_db');
const server = app();
server.get('/health/ready', route(async (_req,res) => { await db.query('SELECT 1'); res.json({ready:true}); }));
const nowSql = () => new Date().toISOString().slice(0,19).replace('T',' ');
async function shift(id) {
  const [rows] = await db.execute('SELECT * FROM shifts WHERE id=?', [id]);
  if (!rows.length) throw fail(404,'Ca làm việc không tồn tại');
  return rows[0];
}
function requirements(body,total) {
  if (body.positionRequirements === undefined) return defaultRequirements(total);
  if (!Array.isArray(body.positionRequirements) || body.positionRequirements.length !== FIXED_POSITIONS.length) throw fail(400,'Cần khai báo đủ ba vị trí cố định');
  const result=FIXED_POSITIONS.map(position=>{
    const matches=body.positionRequirements.filter(item=>item.positionId===position.id);
    if (matches.length!==1 || !Number.isSafeInteger(matches[0].requiredCount) || matches[0].requiredCount<position.minimum) throw fail(400,`Ca cần ít nhất ${position.minimum} nhân viên ${position.name}`);
    return {positionId:position.id,requiredCount:matches[0].requiredCount};
  });
  if (result.reduce((sum,item)=>sum+item.requiredCount,0)!==total) throw fail(400,'Tổng nhân sự theo vị trí phải bằng số nhân viên cần');
  return result;
}
async function registrationsForShift(shiftId) {
  const [rows] = await db.execute('SELECT * FROM registrations WHERE shift_id=? ORDER BY registered_at', [shiftId]);
  return Promise.all(rows.map(async row=>{
    const employee=await call(staffUrl(`/internal/employees/${row.employee_id}`));
    if (!row.position_id) await db.execute('UPDATE registrations SET position_id=? WHERE id=? AND position_id IS NULL', [employee.positionId,row.id]);
    return {...row,position_id:row.position_id||employee.positionId,employee_name:employee.fullName};
  }));
}

server.post('/branches/:branchId/shifts', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const startsAt = validDatetime(req.body.startsAt,'Giờ bắt đầu');
  const endsAt = validDatetime(req.body.endsAt,'Giờ kết thúc');
  if (!isNextWeekShift(`${startsAt.replace(' ','T')}Z`,`${endsAt.replace(' ','T')}Z`)) {
    throw fail(400,'Chỉ được tạo ca làm trong tuần tiếp theo (thứ Hai đến hết Chủ nhật, giờ Việt Nam)');
  }
  const deadline = sqlUtc(registrationDeadline(`${startsAt.replace(' ','T')}Z`));
  if (endsAt <= startsAt || deadline >= startsAt) throw fail(400,'Thời gian ca không hợp lệ');
  const count = req.body.requiredCount;
  if (!Number.isSafeInteger(count) || count < 17) throw fail(400,'Ca cần ít nhất 17 nhân viên');
  const positions=requirements(req.body,count);
  const id = randomUUID();
  await transaction(db, async connection=>{
    await connection.execute('INSERT INTO shifts(id,branch_id,starts_at,ends_at,registration_deadline,required_count) VALUES(?,?,?,?,?,?)', [id,req.params.branchId,startsAt,endsAt,deadline,count]);
    for (const position of positions) await connection.execute('INSERT INTO shift_positions(shift_id,position_id,required_count) VALUES(?,?,?)', [id,position.positionId,position.requiredCount]);
  });
  res.status(201).json({id});
}));

server.get('/branches/:branchId/shifts', auth, route(async (req,res) => {
  if (req.actor.branchId !== req.params.branchId || !['QUAN_LY_CHI_NHANH','NHAN_VIEN_PHUC_VU','NHAN_VIEN_TIEP_NHAN'].includes(req.actor.role)) throw fail(403,'Không có quyền xem ca làm của chi nhánh này');
  const [rows] = await db.execute(`SELECT s.*, COALESCE(c.pending_count,0) AS pending_count,
    COALESCE(c.approved_count,0) AS approved_count, mine.status AS my_status, mine.rejection_reason AS my_rejection_reason
    FROM shifts s
    LEFT JOIN (SELECT shift_id,
      SUM(status='PENDING') AS pending_count,
      SUM(status='APPROVED') AS approved_count
      FROM registrations GROUP BY shift_id) c ON c.shift_id=s.id
    LEFT JOIN registrations mine ON mine.shift_id=s.id AND mine.employee_id=?
    WHERE s.branch_id=? ORDER BY s.starts_at`, [req.actor.id,req.params.branchId]);
  res.json(rows.map(row => ({...row,
    staffing_status: Number(row.approved_count) >= row.required_count && Number(row.pending_count) === 0
      ? 'COMPLETE'
      : row.registration_deadline <= nowSql() ? 'SHORTAGE' : canRegister(`${row.starts_at.replace(' ','T')}Z`) ? 'REGISTRATION_OPEN' : 'SCHEDULED',
    shortage_count: Math.max(0, row.required_count - Number(row.approved_count))
  })));
}));

server.post('/shifts/:shiftId/registrations', auth, route(async (req,res) => {
  if (!['NHAN_VIEN_PHUC_VU','NHAN_VIEN_TIEP_NHAN'].includes(req.actor.role)) throw fail(403,'Chỉ nhân viên được đăng ký ca');
  const selected = await shift(req.params.shiftId);
  if (selected.branch_id !== req.actor.branchId) throw fail(403,'Ca không thuộc chi nhánh của nhân viên');
  if (!canRegister(`${selected.starts_at.replace(' ','T')}Z`)) throw fail(409,'Chỉ được đăng ký ca tuần tiếp theo từ 00:00 thứ Sáu đến hết Chủ nhật (giờ Việt Nam)');
  const employee = await call(staffUrl(`/internal/employees/${req.actor.id}`));
  if (employee.status !== 'ACTIVE' || employee.branchId !== selected.branch_id) throw fail(403,'Nhân viên không hợp lệ');
  const [positions] = await db.execute('SELECT required_count FROM shift_positions WHERE shift_id=? AND position_id=?', [selected.id,employee.positionId]);
  if (!positions.length || positions[0].required_count===0) throw fail(409,'Ca này không cần vị trí việc làm của bạn');
  const id = randomUUID();
  await db.execute('INSERT INTO registrations(id,shift_id,employee_id,position_id) VALUES(?,?,?,?)', [id,selected.id,employee.id,employee.positionId]);
  res.status(201).json({id,status:'PENDING'});
}));

async function cancelApprovedRegistration(connection,selected,registration) {
  if (!registration || registration.status!=='APPROVED' || registration.source!=='EMPLOYEE') throw fail(409,'Chỉ hủy được đăng ký của nhân viên đã duyệt');
  if (selected.starts_at<=nowSql()) throw fail(409,'Không thể hủy khi ca đã bắt đầu');
  const [attendance]=await connection.execute('SELECT id FROM attendance WHERE shift_id=? AND employee_id=? LIMIT 1',[selected.id,registration.employee_id]);
  if (attendance.length) throw fail(409,'Ca đã có dữ liệu ngày công');
  await connection.execute('DELETE FROM registrations WHERE id=?',[registration.id]);
}

server.delete('/shifts/:shiftId/registrations/me', auth, route(async (req,res) => {
  if (!['NHAN_VIEN_PHUC_VU','NHAN_VIEN_TIEP_NHAN'].includes(req.actor.role)) throw fail(403,'Chỉ nhân viên được hủy đăng ký của mình');
  await transaction(db,async connection=>{
    const [shifts]=await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[req.params.shiftId]);
    const selected=one(shifts);
    if (!selected) throw fail(404,'Ca làm việc không tồn tại');
    if (selected.branch_id!==req.actor.branchId) throw fail(403,'Ca không thuộc chi nhánh của nhân viên');
    const [registrations]=await connection.execute('SELECT * FROM registrations WHERE shift_id=? AND employee_id=? FOR UPDATE',[selected.id,req.actor.id]);
    const registration=one(registrations);
    if (!registration || registration.status!=='PENDING') throw fail(409,'Chỉ có thể hủy đăng ký đang chờ duyệt; ca đã duyệt không thể hủy');
    await connection.execute('DELETE FROM registrations WHERE id=?',[registration.id]);
  });
  res.json({message:'Đã hủy đăng ký ca'});
}));

server.delete('/branches/:branchId/shifts/:shiftId/registrations/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  await transaction(db,async connection=>{
    const [shifts]=await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[req.params.shiftId]);
    const selected=one(shifts);
    if (!selected || selected.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
    const [registrations]=await connection.execute('SELECT * FROM registrations WHERE id=? AND shift_id=? FOR UPDATE',[req.params.id,selected.id]);
    const registration=one(registrations);
    if (registration?.status==='PENDING') await connection.execute('DELETE FROM registrations WHERE id=?',[registration.id]);
    else await cancelApprovedRegistration(connection,selected,registration);
  });
  res.json({message:'Đã hủy đăng ký ca'});
}));

server.get('/branches/:branchId/shifts/:shiftId/registrations', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const selected = await shift(req.params.shiftId);
  if (selected.branch_id !== req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
  res.json(await registrationsForShift(selected.id));
}));

server.get('/branches/:branchId/registrations', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const [rows]=await db.execute(`SELECT r.*,s.starts_at,s.ends_at FROM registrations r
    JOIN shifts s ON s.id=r.shift_id WHERE s.branch_id=? ORDER BY s.starts_at,r.registered_at`,[req.params.branchId]);
  res.json(await Promise.all(rows.map(async row=>{
    const employee=await call(staffUrl(`/internal/employees/${row.employee_id}`));
    return {...row,employee_name:employee.fullName,position_id:row.position_id||employee.positionId};
  })));
}));

server.get('/branches/:branchId/shifts/:shiftId/staffing', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const selected=await shift(req.params.shiftId);
  if(selected.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
  const [requirements]=await db.execute('SELECT position_id,required_count FROM shift_positions WHERE shift_id=?', [selected.id]);
  const registrations=await registrationsForShift(selected.id);
  res.json({shift:selected,positions:FIXED_POSITIONS.map(position=>{
    const assigned=registrations.filter(row=>row.position_id===position.id);
    return {positionId:position.id,name:position.name,requiredCount:requirements.find(row=>row.position_id===position.id)?.required_count||0,approvedCount:assigned.filter(row=>row.status==='APPROVED').length,pendingCount:assigned.filter(row=>row.status==='PENDING').length,registrations:assigned};
  })});
}));

server.get('/branches/:branchId/shifts/:shiftId/detail', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const selected = await shift(req.params.shiftId);
  if (selected.branch_id !== req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
  const [positions] = await db.execute(`SELECT sp.position_id,sp.required_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.shift_id=sp.shift_id AND r.position_id=sp.position_id AND r.status='APPROVED') AS approved_count
    FROM shift_positions sp WHERE sp.shift_id=?`, [selected.id]);
  const [requests] = await db.execute('SELECT id,position_id,quantity,note,status,created_at FROM staff_requests WHERE shift_id=? ORDER BY created_at DESC', [selected.id]);
  const [assigned] = await db.execute("SELECT id,employee_id,position_id FROM registrations WHERE shift_id=? AND source='MANAGER' AND status='APPROVED'",[selected.id]);
  const [unavailable] = await db.execute(`SELECT DISTINCT r.employee_id FROM registrations r JOIN shifts s ON s.id=r.shift_id
    WHERE r.status='APPROVED' AND r.shift_id<>? AND s.branch_id=? AND s.starts_at<? AND s.ends_at>?`,
    [selected.id,selected.branch_id,selected.ends_at,selected.starts_at]);
  const assignedEmployees=await Promise.all(assigned.map(async item=>{
    const employee=await call(staffUrl(`/internal/employees/${item.employee_id}`));
    return {id:item.id,employeeId:item.employee_id,positionId:item.position_id,employeeName:employee.fullName};
  }));
  const shortage = positions.reduce((sum,row)=>sum+Math.max(0,row.required_count-row.approved_count),0);
  res.json({shift:selected,positions,requests,assignedEmployees,unavailableEmployeeIds:unavailable.map(row=>row.employee_id),shortage,
    status:shortage===0?'COMPLETE':selected.registration_deadline<=nowSql()?'SHORTAGE':canRegister(`${selected.starts_at.replace(' ','T')}Z`)?'REGISTRATION_OPEN':'SCHEDULED',
    registrationsAvailable:true});
}));

function assignmentAllowed(selected,removing=false) {
  const startWeek=weekOf(`${selected.starts_at.replace(' ','T')}Z`);
  const currentWeek=weekOf(new Date());
  if ((removing?![currentWeek,currentWeek+7*86400000].includes(startWeek):startWeek!==currentWeek+7*86400000) || selected.ends_at<=nowSql()) {
    throw fail(409,removing?'Chỉ được hủy phân công của ca chưa kết thúc':'Chỉ được gán nhân viên cho ca tuần tới');
  }
}

async function insertAssignment(connection,selected,employee,actorId) {
  const [existing]=await connection.execute('SELECT id FROM registrations WHERE shift_id=? AND employee_id=?',[selected.id,employee.id]);
  if(existing.length) throw fail(409,'Nhân viên đã đăng ký hoặc được gán cho ca này');
  const [overlap]=await connection.execute(`SELECT r.id FROM registrations r JOIN shifts s ON s.id=r.shift_id
    WHERE r.employee_id=? AND r.status='APPROVED' AND s.starts_at<? AND s.ends_at>? LIMIT 1`,
    [employee.id,selected.ends_at,selected.starts_at]);
  if(overlap.length) throw fail(409,'Nhân viên đã có ca được duyệt trùng giờ');
  const [positions]=await connection.execute('SELECT required_count FROM shift_positions WHERE shift_id=? AND position_id=?',[selected.id,employee.positionId]);
  if(!positions.length || positions[0].required_count===0) throw fail(409,'Ca không cần vị trí của nhân viên này');
  const [counts]=await connection.execute("SELECT COUNT(*) AS total FROM registrations WHERE shift_id=? AND position_id=? AND status='APPROVED'",[selected.id,employee.positionId]);
  if(counts[0].total>=positions[0].required_count) throw fail(409,'Vị trí này đã đủ nhân viên');
  const id=randomUUID();
  await connection.execute("INSERT INTO registrations(id,shift_id,employee_id,position_id,source,status,reviewed_at,reviewed_by) VALUES(?,?,?,?, 'MANAGER','APPROVED',UTC_TIMESTAMP(),?)",[id,selected.id,employee.id,employee.positionId,actorId]);
  return {id,employeeId:employee.id,positionId:employee.positionId,status:'APPROVED'};
}

server.post('/branches/:branchId/shifts/:shiftId/assignments', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const employeeId=requiredText(req.body.employeeId,'Nhân viên',36);
  const employee=await call(staffUrl(`/internal/employees/${employeeId}`));
  if(employee.status!=='ACTIVE' || employee.branchId!==req.params.branchId) throw fail(403,'Nhân viên không hoạt động hoặc không thuộc chi nhánh');
  const connection=await db.getConnection();
  const lockName=`assign:${employeeId}`;
  let acquired=false;
  try {
    const [locks]=await connection.execute('SELECT GET_LOCK(?,5) AS acquired',[lockName]);
    if(locks[0].acquired!==1) throw fail(409,'Đang cập nhật lịch của nhân viên, vui lòng thử lại');
    acquired=true;
    await connection.beginTransaction();
    const [shifts]=await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[req.params.shiftId]);
    const selected=one(shifts);
    if(!selected || selected.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
    assignmentAllowed(selected);
    const assignment=await insertAssignment(connection,selected,employee,req.actor.id);
    await connection.commit();
    res.status(201).json(assignment);
  } catch(error) {
    await connection.rollback();
    throw error;
  } finally {
    if(acquired) await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]);
    connection.release();
  }
}));

server.post('/branches/:branchId/shifts/:shiftId/assignments/bulk', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const ids=req.body.employeeIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>36)||new Set(ids).size!==ids.length) throw fail(400,'Chọn từ 1 đến 100 nhân viên không trùng nhau');
  const employees=await Promise.all([...ids].sort().map(id=>call(staffUrl(`/internal/employees/${id}`))));
  if(employees.some(employee=>employee.status!=='ACTIVE'||employee.branchId!==req.params.branchId)) throw fail(403,'Nhân viên không hoạt động hoặc không thuộc chi nhánh');
  const connection=await db.getConnection();
  const acquired=[];
  try {
    for(const employee of employees) {
      const lockName=`assign:${employee.id}`;
      const [locks]=await connection.execute('SELECT GET_LOCK(?,5) AS acquired',[lockName]);
      if(locks[0].acquired!==1) throw fail(409,'Đang cập nhật lịch của nhân viên, vui lòng thử lại');
      acquired.push(lockName);
    }
    await connection.beginTransaction();
    const [shifts]=await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[req.params.shiftId]);
    const selected=one(shifts);
    if(!selected||selected.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
    assignmentAllowed(selected);
    const assignments=[];
    for(const employee of employees) assignments.push(await insertAssignment(connection,selected,employee,req.actor.id));
    await connection.commit();
    res.status(201).json({assignments});
  }catch(error){await connection.rollback();throw error;}
  finally{for(const lockName of acquired.reverse()) await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]);connection.release();}
}));

server.delete('/branches/:branchId/shifts/:shiftId/assignments/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  await transaction(db,async connection=>{
    const [shifts]=await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[req.params.shiftId]);
    const selected=one(shifts);
    if(!selected || selected.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
    assignmentAllowed(selected,true);
    const [rows]=await connection.execute('SELECT * FROM registrations WHERE id=? AND shift_id=? FOR UPDATE',[req.params.id,selected.id]);
    const assigned=one(rows);
    if(!assigned || assigned.source!=='MANAGER' || assigned.status!=='APPROVED') throw fail(404,'Không tìm thấy phân công trực tiếp');
    const [attendance]=await connection.execute('SELECT id FROM attendance WHERE shift_id=? AND employee_id=? LIMIT 1',[selected.id,assigned.employee_id]);
    if(attendance.length) throw fail(409,'Ca đã có dữ liệu ngày công, không thể bỏ gán');
    await connection.execute('DELETE FROM registrations WHERE id=?',[assigned.id]);
  });
  res.json({message:'Đã bỏ gán nhân viên'});
}));

function reviewDecision(body) {
  if (!['APPROVED','REJECTED'].includes(body.decision)) throw fail(400,'Quyết định phải là APPROVED hoặc REJECTED');
  return {decision:body.decision,reason:body.decision==='REJECTED'?requiredText(body.reason,'Lý do từ chối',500):null};
}

async function reviewOne(connection,branchId,shiftId,id,actorId,decision,reason) {
  const [shifts] = await connection.execute('SELECT * FROM shifts WHERE id=? FOR UPDATE',[shiftId]);
  const selected=one(shifts);
  if (!selected || selected.branch_id!==branchId) throw fail(404,'Ca không thuộc chi nhánh');
  if (weekOf(`${selected.starts_at.replace(' ','T')}Z`)!==weekOf(new Date())+7*86400000) throw fail(409,'Chỉ được duyệt hoặc từ chối đăng ký của ca tuần tới');
  const [registrations]=await connection.execute('SELECT * FROM registrations WHERE id=? AND shift_id=? FOR UPDATE',[id,shiftId]);
  const registration=one(registrations);
  if (!registration) throw fail(404,'Đăng ký ca không tồn tại');
  if (registration.status!=='PENDING') throw fail(409,'Đăng ký đã được xử lý');
  if (decision==='APPROVED') {
    const [overlap]=await connection.execute(`SELECT r.id FROM registrations r JOIN shifts s ON s.id=r.shift_id
      WHERE r.employee_id=? AND r.status='APPROVED' AND r.id<>? AND s.starts_at<? AND s.ends_at>? LIMIT 1`,
      [registration.employee_id,registration.id,selected.ends_at,selected.starts_at]);
    if(overlap.length) throw fail(409,'Nhân viên đã có ca được duyệt trùng giờ');
    const [counts]=await connection.execute('SELECT COUNT(*) AS total FROM registrations WHERE shift_id=? AND status=?',[shiftId,'APPROVED']);
    if(counts[0].total>=selected.required_count) throw fail(409,'Ca đã đủ nhân viên');
    const [positions]=await connection.execute('SELECT required_count FROM shift_positions WHERE shift_id=? AND position_id=?',[shiftId,registration.position_id]);
    if(!positions.length || positions[0].required_count===0) throw fail(409,'Ca không có chỉ tiêu cho vị trí này');
    const [positionCounts]=await connection.execute('SELECT COUNT(*) AS total FROM registrations WHERE shift_id=? AND position_id=? AND status=?',[shiftId,registration.position_id,'APPROVED']);
    if(positionCounts[0].total>=positions[0].required_count) throw fail(409,'Vị trí này đã đủ nhân viên');
  }
  await connection.execute('UPDATE registrations SET status=?,reviewed_at=UTC_TIMESTAMP(),reviewed_by=?,rejection_reason=? WHERE id=?',[decision,actorId,reason,id]);
  return {id,status:decision,branchId};
}

server.patch('/branches/:branchId/shifts/:shiftId/registrations/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const {decision,reason}=reviewDecision(req.body);
  const candidate=await shift(req.params.shiftId);
  if(candidate.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
  await registrationsForShift(req.params.shiftId);
  res.json(await transaction(db,connection=>reviewOne(connection,req.params.branchId,req.params.shiftId,req.params.id,req.actor.id,decision,reason)));
}));

server.post('/branches/:branchId/registrations/bulk-review', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const {decision,reason}=reviewDecision(req.body);
  const items=req.body.items;
  if(!Array.isArray(items) || items.length<1 || items.length>100 || items.some(item=>!item || typeof item.id!=='string' || typeof item.shiftId!=='string')) throw fail(400,'Chọn từ 1 đến 100 đăng ký hợp lệ');
  if(new Set(items.map(item=>item.id)).size!==items.length) throw fail(400,'Danh sách đăng ký bị trùng');
  const sorted=[...items].sort((a,b)=>a.shiftId.localeCompare(b.shiftId)||a.id.localeCompare(b.id));
  for(const shiftId of new Set(sorted.map(item=>item.shiftId))) {
    const candidate=await shift(shiftId);
    if(candidate.branch_id!==req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
    await registrationsForShift(shiftId);
  }
  const results=await transaction(db,async connection=>{
    const reviewed=[];
    for(const item of sorted) reviewed.push(await reviewOne(connection,req.params.branchId,item.shiftId,item.id,req.actor.id,decision,reason));
    return reviewed;
  });
  res.json({reviewed:results});
}));

server.post('/branches/:branchId/shifts/:shiftId/staff-requests', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const selected = await shift(req.params.shiftId);
  if (selected.branch_id !== req.params.branchId) throw fail(404,'Ca không thuộc chi nhánh');
  if (selected.ends_at <= nowSql()) throw fail(409,'Ca làm việc đã kết thúc');
  if (weekOf(`${selected.starts_at.replace(' ','T')}Z`) !== weekOf(new Date())) throw fail(409,'Chỉ được gửi yêu cầu bổ sung cho ca thuộc tuần hiện tại');
  const quantities = req.body.positionQuantities === undefined
    ? [{positionId:requiredText(req.body.positionId,'Vị trí việc làm',36),quantity:req.body.quantity}]
    : req.body.positionQuantities;
  if (!Array.isArray(quantities) || !quantities.length || quantities.length>FIXED_POSITIONS.length ||
      quantities.some(item=>!FIXED_POSITIONS.some(position=>position.id===item.positionId) || !Number.isSafeInteger(item.quantity) || item.quantity<0) ||
      new Set(quantities.map(item=>item.positionId)).size!==quantities.length ||
      !quantities.some(item=>item.quantity>0) || quantities.some(item=>item.quantity>5)) throw fail(400,'Mỗi vị trí chỉ được yêu cầu bổ sung từ 1 đến 5 nhân viên');
  const note = req.body.note == null ? null : String(req.body.note).trim();
  if (note?.length > 2000) throw fail(400,'Ghi chú quá dài');
  const ids = [];
  await transaction(db, async connection => {
    const [locked]=await connection.execute('SELECT id FROM shifts WHERE id=? FOR UPDATE',[selected.id]);
    if (!locked.length) throw fail(404,'Ca làm việc không tồn tại');
    for (const item of quantities.filter(value=>value.quantity>0)) {
      const [existing]=await connection.execute('SELECT id FROM staff_requests WHERE shift_id=? AND position_id=? LIMIT 1',[selected.id,item.positionId]);
      if (existing.length) throw fail(409,`Vị trí ${FIXED_POSITIONS.find(position=>position.id===item.positionId).name} đã được yêu cầu bổ sung cho ca này`);
      const id=randomUUID();
      await connection.execute('INSERT INTO staff_requests(id,shift_id,branch_id,position_id,quantity,note,requested_by) VALUES(?,?,?,?,?,?,?)', [id,selected.id,selected.branch_id,item.positionId,item.quantity,note,req.actor.id]);
      ids.push(id);
    }
  });
  res.status(201).json({id:ids[0],ids,status:'PENDING',message:'Gửi yêu cầu bổ sung nhân viên thành công'});
}));

server.get('/branches/:branchId/staff-requests', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const [rows] = await db.execute('SELECT * FROM staff_requests WHERE branch_id=? ORDER BY created_at DESC', [req.params.branchId]);
  res.json(rows);
}));

server.get('/owner/staff-requests', auth, route(async (req,res) => {
  if (req.actor.role !== 'CHU_CHUOI') throw fail(403,'Chỉ chủ chuỗi được xem toàn bộ yêu cầu');
  const [rows] = await db.execute('SELECT * FROM staff_requests ORDER BY created_at DESC');
  res.json(rows);
}));

server.get('/internal/employees/:id/blockers', internal, route(async (req,res) => {
  const id = req.params.id;
  const [attendance] = await db.execute("SELECT a.id,a.status,s.starts_at,s.ends_at FROM attendance a JOIN shifts s ON s.id=a.shift_id WHERE a.employee_id=? AND a.status='OPEN' ORDER BY s.starts_at", [id]);
  const [shifts] = await db.execute("SELECT r.id,r.shift_id,s.starts_at,s.ends_at FROM registrations r JOIN shifts s ON s.id=r.shift_id WHERE r.employee_id=? AND r.status='APPROVED' AND s.ends_at>UTC_TIMESTAMP() ORDER BY s.starts_at", [id]);
  const [pending] = await db.execute("SELECT r.id,r.shift_id,s.starts_at,s.ends_at FROM registrations r JOIN shifts s ON s.id=r.shift_id WHERE r.employee_id=? AND r.status='PENDING' ORDER BY s.starts_at", [id]);
  res.json({openAttendance:!!attendance.length,unfinishedShift:!!shifts.length,pendingRegistration:!!pending.length,attendance,shifts,pending});
}));

errors(server);
if (process.env.NODE_ENV !== 'test') migrateSchedule(db).then(async () => {
  await fillShiftPositions(db);
  server.listen(Number(process.env.PORT||3000), () => console.log('schedule :3003'));
}).catch(error => {console.error(error);process.exit(1);});
export default server;
