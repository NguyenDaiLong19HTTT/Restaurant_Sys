import {calculate} from './pricing.mjs';
import {orderSnapshotHash} from '../../../packages/order-snapshot.mjs';
export function snapshotHash(order){calculate(order.items);return orderSnapshotHash(order);}
