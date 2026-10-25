// Portable verification: only resources belonging to this checkout.
import fs from 'node:fs';
const cfg=JSON.parse(fs.readFileSync('.local/stack.json','utf8'));
// API liveness is verified through the checkout-specific port, not a second project.
const r=await fetch('http://127.0.0.1:'+cfg.webPort+'/dang-nhap');
if(!r.ok)throw Error('Web unavailable');console.log('Checkout web reachable: '+cfg.project);
