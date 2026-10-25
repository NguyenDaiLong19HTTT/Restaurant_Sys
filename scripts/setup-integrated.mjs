// Compatibility entry point. Windows setup performs Docker/port safety checks first.
import {execFileSync} from 'node:child_process';
execFileSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/setup.ps1'],{stdio:'inherit'});
