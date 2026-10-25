import {createHash} from 'node:crypto';

export function orderSnapshotHash(order){
 const items=order.items.map(i=>({id:i.id||i.dishId||null,name:i.dishNameSnapshot,quantity:i.quantity,unitPriceVnd:i.unitPriceVnd}));
 return createHash('sha256').update(JSON.stringify({id:order.id,branchId:order.branchId,tableId:order.tableId||null,version:order.version,status:order.status,items})).digest('hex');
}
