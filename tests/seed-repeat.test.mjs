import test from 'node:test';
import fs from 'node:fs';
const stack=JSON.parse(fs.readFileSync('.local/stack.json','utf8'));
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const services=['identity','menu','reservation','order','staff','schedule','inventory','payment'];
const compose=(...args)=>execFileSync('docker',['compose','--project-name',stack.project,'--env-file','.local/compose.env','-f','compose.yaml',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
function snapshot(){return Object.fromEntries(services.map(s=>[s,JSON.parse(compose('exec','-T',s+'-service','node','tests/seed-snapshot.mjs'))]));}
test('demo seed twice preserves every existing domain row, user edits and paid orders',{timeout:180000},()=>{
 const before=snapshot();
 for(let n=0;n<2;n++){
  execFileSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/seed.ps1'],{stdio:['ignore','pipe','pipe']});
  assert.deepEqual(snapshot(),before,'Seed must not duplicate or overwrite existing database rows');
 }
});
