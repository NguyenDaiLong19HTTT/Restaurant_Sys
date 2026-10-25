export const FIXED_POSITIONS = [
  {id:'10000000-0000-0000-0000-000000000001',name:'Phục vụ',minimum:5},
  {id:'10000000-0000-0000-0000-000000000002',name:'Tiếp nhận',minimum:2},
  {id:'10000000-0000-0000-0000-000000000003',name:'Bếp',minimum:10}
];

export function defaultRequirements(total) {
  const minimum=FIXED_POSITIONS.reduce((sum,position)=>sum+position.minimum,0);
  if(total<minimum) throw new Error(`Ca cần ít nhất ${minimum} nhân viên`);
  return FIXED_POSITIONS.map((position,index)=>({positionId:position.id,requiredCount:position.minimum+(index===0?total-minimum:0)}));
}
