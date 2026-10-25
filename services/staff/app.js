import {randomBytes, randomUUID} from 'node:crypto';
import {pool, one, transaction} from '../../shared/db.js';
import {app, auth, call, errors, fail, identityUrl, internal, manager, requiredText, route, scheduleUrl, validDate} from '../../shared/api.js';

const db = pool('staff_db');
const server = app();
server.get('/health/ready', route(async (_req,res) => { await db.query('SELECT 1'); res.json({ready:true}); }));
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(body, create) {
  const fields = {};
  for (const [key, label, max] of [['fullName','Họ tên',150],['phone','Số điện thoại',15],['email','Email',255],['address','Địa chỉ',255],['positionId','Vị trí',36]]) {
    if (create || body[key] !== undefined) fields[key] = requiredText(body[key],label,max);
  }
  if (create || body.dateOfBirth !== undefined) fields.dateOfBirth = validDate(body.dateOfBirth,'Ngày sinh');
  if (create || body.startDate !== undefined) fields.startDate = validDate(body.startDate,'Ngày bắt đầu');
  if (create || body.gender !== undefined) {
    if (!['MALE','FEMALE','OTHER'].includes(body.gender)) throw fail(400,'Giới tính không hợp lệ');
    fields.gender = body.gender;
  }
  if (create) fields.citizenId = requiredText(body.citizenId,'CCCD',12);
  if (fields.citizenId && !/^\d{12}$/.test(fields.citizenId)) throw fail(400,'CCCD phải gồm 12 chữ số');
  if (fields.phone && !/^0\d{9,10}$/.test(fields.phone)) throw fail(400,'Số điện thoại không hợp lệ');
  if (fields.email && !emailPattern.test(fields.email)) throw fail(400,'Email không hợp lệ');
  if (fields.email) fields.email = fields.email.toLowerCase();
  if (fields.dateOfBirth) {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(new Date()).map(part=>[part.type,Number(part.value)]));
    const today=new Date(parts.year,parts.month-1,parts.day);
    const year = Number(fields.dateOfBirth.slice(0,4));
    if (year < today.getFullYear()-100) throw fail(400,'Năm sinh không hợp lý (tối đa 100 tuổi)');
    const adult = new Date(today.getFullYear()-18,today.getMonth(),today.getDate());
    if (new Date(`${fields.dateOfBirth}T00:00:00`) > adult) throw fail(400,'Nhân viên chưa đủ 18 tuổi;');
  }
  return fields;
}
async function checkPosition(positionId) {
  const [rows] = await db.execute('SELECT id FROM positions WHERE id=?', [positionId]);
  if (!rows.length) throw fail(400,'Vị trí việc làm không tồn tại');
}
async function duplicate(fields, excludeId = '') {
  for (const [key,column,label] of [['citizenId','citizen_id','CCCD'],['phone','phone','Số điện thoại'],['email','email','Email']]) {
    if (fields[key] === undefined) continue;
    const [rows] = await db.execute(`SELECT id FROM employees WHERE ${column}=? AND id<>?`, [fields[key],excludeId]);
    if (rows.length) throw fail(409,`${label} đã được sử dụng`);
  }
}
async function employee(id) {
  const [rows] = await db.execute('SELECT * FROM employees WHERE id=?', [id]);
  if (!rows.length) throw fail(404,'Không tìm thấy nhân viên');
  return rows[0];
}

server.get('/branches',auth,route(async(req,res)=>{const branches=await call(process.env.BRANCH_BASE_URL+'/internal/v1/branches');res.json(branches.data.filter(b=>req.actor.role==='CHU_CHUOI'||b.id===req.actor.branchId));}));
server.get('/positions', auth, route(async (_req,res) => {
  const [rows] = await db.execute('SELECT * FROM positions'); res.json(rows);
}));
server.get('/branches/:branchId/employees', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const [rows] = await db.execute('SELECT e.*,p.name AS position_name FROM employees e JOIN positions p ON p.id=e.position_id WHERE e.branch_id=? ORDER BY e.created_at DESC', [req.params.branchId]);
  res.json(rows);
}));
server.get('/branches/:branchId/employees/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const record = await employee(req.params.id);
  if (record.branch_id !== req.params.branchId) throw fail(404,'Không tìm thấy nhân viên trong chi nhánh');
  res.json(record);
}));
server.get('/branches/:branchId/employees/validate/field', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const {field,value,excludeId=''}=req.query;
  if (!['citizenId','phone','email','dateOfBirth'].includes(field)) throw fail(400,'Trường kiểm tra không hợp lệ');
  const fields=validate({[field]:value},false);
  if (field==='citizenId') {
    fields.citizenId=requiredText(value,'CCCD',12);
    if (!/^\d{12}$/.test(fields.citizenId)) throw fail(400,'CCCD phải gồm 12 chữ số');
  }
  await duplicate(fields,excludeId);
  res.json({valid:true});
}));
server.get('/branches/:branchId/employees/:id/blockers', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const current=await employee(req.params.id);
  if (current.branch_id!==req.params.branchId) throw fail(404,'Không tìm thấy nhân viên trong chi nhánh');
  res.json(await call(scheduleUrl(`/internal/employees/${current.id}/blockers`)));
}));

server.post('/branches/:branchId/employees', auth, route(async (req,res) => {
  const branchId = req.params.branchId;
  manager(req,branchId);
  const fields = validate(req.body,true);
  await checkPosition(fields.positionId);
  await duplicate(fields);
  const branches = await call(process.env.BRANCH_BASE_URL+'/internal/v1/branches/'+encodeURIComponent(branchId));
  if (branches.data?.status!=='ACTIVE') throw fail(404,'Chi nhánh không tồn tại');
  const id = randomUUID();
  const password=req.body.initialPassword;if(typeof password!=='string'||password.length<12||password.length>128)throw fail(400,'Mật khẩu tạm cần từ 12 đến 128 ký tự');
  await db.execute('INSERT INTO employees(id,branch_id,position_id,full_name,date_of_birth,gender,citizen_id,phone,email,address,start_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id,branchId,fields.positionId,fields.fullName,fields.dateOfBirth,fields.gender,fields.citizenId,fields.phone,fields.email,fields.address,fields.startDate]);
  try {
    await call(identityUrl('/internal/v1/staff-accounts'),{method:'POST',body:JSON.stringify({id,email:fields.email,password,branchId,role:fields.positionId==='10000000-0000-0000-0000-000000000002'?'NHAN_VIEN_TIEP_NHAN':'NHAN_VIEN_PHUC_VU'})});
  } catch (error) {
    await call(identityUrl(`/internal/v1/staff-accounts/${id}`),{method:'DELETE'}).catch(compensation => console.error('Account compensation failed',id,compensation));
    await db.execute('DELETE FROM employees WHERE id=?', [id]);
    throw error;
  }
  res.status(201).json({id,branchId,username:fields.email});
}));

server.patch('/branches/:branchId/employees/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  const current = await employee(req.params.id);
  if (current.branch_id !== req.params.branchId) throw fail(404,'Không tìm thấy nhân viên trong chi nhánh');
  if (current.status !== 'ACTIVE') throw fail(409,'Tài khoản nhân viên không hoạt động');
  const account = await call(identityUrl(`/internal/v1/staff-accounts/${current.id}`));
  if (account.status !== 'ACTIVE') throw fail(409,'Tài khoản nhân viên không hoạt động');
  if (req.body.confirm !== true) throw fail(400,'Cần xác nhận cập nhật');
  const allowed = new Set(['confirm','fullName','dateOfBirth','phone','email','address','positionId']);
  if (Object.keys(req.body).some(key => !allowed.has(key))) throw fail(400,'Có trường không được phép cập nhật');
  const fields = validate(req.body,false);
  if (!Object.keys(fields).length) throw fail(400,'Không có thay đổi');
  if (fields.positionId) await checkPosition(fields.positionId);
  await duplicate(fields,req.params.id);
  const map = {fullName:'full_name',dateOfBirth:'date_of_birth',phone:'phone',email:'email',address:'address',positionId:'position_id'};
  const entries = Object.entries(fields).filter(([key]) => map[key]);
  if (!entries.length) throw fail(400,'Trường này không được phép cập nhật');
  if (fields.email || fields.positionId) await call(identityUrl(`/internal/v1/staff-accounts/${current.id}`),{method:'PATCH',body:JSON.stringify({email:fields.email||current.email,role:fields.positionId?(fields.positionId==='10000000-0000-0000-0000-000000000002'?'NHAN_VIEN_TIEP_NHAN':'NHAN_VIEN_PHUC_VU'):account.role})});
  try {
    await db.execute(`UPDATE employees SET ${entries.map(([key])=>`${map[key]}=?`).join(',')} WHERE id=?`, [...entries.map(([,value])=>value),current.id]);
  } catch (error) {
    if (fields.email || fields.positionId) await call(identityUrl(`/internal/v1/staff-accounts/${current.id}`),{method:'PATCH',body:JSON.stringify({email:current.email,role:account.role})}).catch(compensation => console.error('Email compensation failed',current.id,compensation));
    throw error;
  }
  res.json({message:'Cập nhật thông tin nhân viên thành công'});
}));

server.delete('/branches/:branchId/employees/:id', auth, route(async (req,res) => {
  manager(req,req.params.branchId);
  if (req.body?.confirm !== true) throw fail(400,'Cần xác nhận ngừng hoạt động');
  const current = await employee(req.params.id);
  if (current.branch_id !== req.params.branchId) throw fail(404,'Không tìm thấy nhân viên trong chi nhánh');
  if (current.status !== 'ACTIVE') throw fail(409,'Nhân viên đã ngừng hoạt động');
  const blockers = await call(scheduleUrl(`/internal/employees/${current.id}/blockers`));
  const describe = row => `${new Date(row.starts_at).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}–${new Date(row.ends_at).toLocaleTimeString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})} (ca ${row.shift_id})`;
  if (blockers.openAttendance) throw fail(409,`Ngày công chưa hoàn tất: ${blockers.attendance.map(describe).join('; ')}. Hãy hoàn tất ngày công trước khi xóa.`);
  if (blockers.unfinishedShift) throw fail(409,`Ca làm chưa hoàn tất: ${blockers.shifts.map(describe).join('; ')}. Hãy xử lý ca trước khi xóa.`);
  if (blockers.pendingRegistration) throw fail(409,`Đăng ký ca đang chờ duyệt: ${blockers.pending.map(describe).join('; ')}. Hãy xử lý đăng ký trước khi xóa.`);
  await call(identityUrl(`/internal/v1/staff-accounts/${current.id}`),{method:'PATCH',body:JSON.stringify({status:'INACTIVE'})});
  await db.execute('UPDATE employees SET status=? WHERE id=?', ['INACTIVE',current.id]);
  res.json({message:'Ngừng hoạt động tài khoản nhân viên thành công'});
}));

server.get('/internal/employees/:id', internal, route(async (req,res) => {
  const record = await employee(req.params.id);
  res.json({id:record.id,branchId:record.branch_id,positionId:record.position_id,fullName:record.full_name,status:record.status});
}));
server.get('/internal/positions/:id', internal, route(async (req,res) => {
  await checkPosition(req.params.id); res.json({id:req.params.id});
}));

errors(server);
if (process.env.NODE_ENV !== 'test') {
  // Repair position labels inserted by older MySQL clients with the wrong charset.
  const positions = [
    ['10000000-0000-0000-0000-000000000001', 'Phục vụ'],
    ['10000000-0000-0000-0000-000000000002', 'Tiếp nhận'],
    ['10000000-0000-0000-0000-000000000003', 'Bếp']
  ];
  try {
    for (const [id, name] of positions) await db.execute('UPDATE positions SET name=? WHERE id=? AND name<>?', [name, id, name]);
    server.listen(Number(process.env.PORT||3000), () => console.log('staff :3002'));
  } catch (error) {
    console.error('Cannot prepare staff positions', error);
    process.exitCode = 1;
  }
}
export default server;
