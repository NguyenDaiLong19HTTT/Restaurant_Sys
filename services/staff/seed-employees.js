import {randomUUID} from 'node:crypto';
import {pool} from '../../shared/db.js';
import {call,identityUrl} from '../../shared/api.js';

const db=pool('staff_db');
const positions=[
  {id:'10000000-0000-0000-0000-000000000001',name:'Phục vụ',minimum:5},
  {id:'10000000-0000-0000-0000-000000000002',name:'Tiếp nhận',minimum:2},
  {id:'10000000-0000-0000-0000-000000000003',name:'Bếp',minimum:10}
];
const password=process.env.DEMO_EMPLOYEE_PASSWORD || 'ChangeDemoEmployee123!';
const names=['Nguyễn Minh Anh','Trần Hoàng Bảo','Lê Gia Hân','Phạm Đức Huy','Võ Thanh Trúc','Đặng Quốc Bảo','Bùi Ngọc Hà','Hoàng Gia Linh','Đỗ Minh Khang','Ngô Thảo Vy','Phan Tuấn Kiệt','Vũ Phương Nhi','Hồ Nhật Nam','Đinh Khánh Ly','Lý Hải Đăng','Mai Ngọc Mai','Tạ Quang Huy'];
let created=0;
try {
  for(let branch=1;branch<=3;branch++) {
    const branchId=`00000000-0000-0000-0000-${String(branch).padStart(12,'0')}`;
    for(let position=0;position<positions.length;position++) {
      const role=positions[position];
      const [rows]=await db.execute('SELECT COUNT(*) AS total FROM employees WHERE branch_id=? AND position_id=? AND status=?',[branchId,role.id,'ACTIVE']);
      let missing=Math.max(0,role.minimum-rows[0].total);
      for(let serial=1;missing>0;serial++) {
        const email=`seed.b${branch}.p${position+1}.${serial}@example.com`;
        const [existing]=await db.execute('SELECT id FROM employees WHERE email=?',[email]);
        if(existing.length) continue;
        const id=randomUUID();
        await call(identityUrl('/internal/accounts'),{method:'POST',body:JSON.stringify({id,email,password,branchId})});
        try {
          await db.execute('INSERT INTO employees(id,branch_id,position_id,full_name,date_of_birth,gender,citizen_id,phone,email,address,start_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[
            id,branchId,role.id,names[(created+serial-1)%names.length],'2000-01-01',serial%2?'FEMALE':'MALE',
            `900${branch}${position+1}${String(serial).padStart(7,'0')}`,
            `09${branch}${position+1}${String(serial).padStart(6,'0')}`,email,`Chi nhánh ${branch}`,'2026-10-23'
          ]);
        } catch(error) {
          await call(identityUrl(`/internal/accounts/${id}`),{method:'DELETE'}).catch(()=>{});
          throw error;
        }
        missing--;created++;
      }
    }
  }
  console.log(`Đã thêm ${created} nhân viên mẫu; mỗi chi nhánh có ít nhất 5 Phục vụ, 2 Tiếp nhận và 10 Bếp.`);
} catch(error) {
  console.error(error);
  process.exitCode=1;
} finally {
  await db.end();
}
