import test from 'node:test';
import assert from 'node:assert/strict';
import {canRegister,isNextWeekShift,registrationDeadline,registrationPeriod} from '../services/schedule/week.js';

const nextMonday='2026-10-25T17:00:00Z';
const currentMonday='2026-10-18T17:00:00Z';

test('chỉ đăng ký tuần kế tiếp từ thứ Sáu 00:00 đến hết Chủ nhật giờ Việt Nam', () => {
  assert.equal(canRegister(nextMonday,new Date('2026-10-22T16:59:59Z')),false);
  assert.equal(canRegister(nextMonday,new Date('2026-10-22T17:00:00Z')),true);
  assert.equal(canRegister(nextMonday,new Date('2026-10-24T16:59:59Z')),true);
  assert.equal(canRegister(nextMonday,new Date('2026-10-24T17:00:00Z')),true);
  assert.equal(canRegister(nextMonday,new Date('2026-10-25T16:59:59Z')),true);
  assert.equal(canRegister(nextMonday,new Date('2026-10-25T17:00:00Z')),false);
  assert.equal(canRegister(currentMonday,new Date('2026-10-23T00:00:00Z')),false);
});

test('hạn duyệt đăng ký là thứ Hai 00:00 của tuần làm việc', () => {
  assert.equal(registrationDeadline(nextMonday).toISOString(),'2026-10-25T17:00:00.000Z');
  assert.equal(new Date(registrationPeriod(new Date('2026-10-23T00:00:00Z')).closesAt).toISOString(),'2026-10-25T17:00:00.000Z');
});

test('chỉ tạo ca có toàn bộ thời gian nằm trong tuần kế tiếp theo giờ Việt Nam', () => {
  const now=new Date('2026-10-23T10:00:00Z');
  assert.equal(isNextWeekShift('2026-10-25T17:00:00Z','2026-10-25T21:00:00Z',now),true);
  assert.equal(isNextWeekShift('2026-11-01T14:00:00Z','2026-11-01T17:00:00Z',now),true);
  assert.equal(isNextWeekShift('2026-10-25T16:59:59Z','2026-10-25T21:00:00Z',now),false);
  assert.equal(isNextWeekShift('2026-11-01T14:00:00Z','2026-11-01T17:00:01Z',now),false);
  assert.equal(isNextWeekShift('2026-10-25T17:00:00Z','2026-10-25T17:00:00Z',now),false);
});
