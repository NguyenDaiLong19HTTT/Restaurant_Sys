import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const before = JSON.parse(readFileSync('docs/docker-inventory-before.json', 'utf8'));
const stack = JSON.parse(readFileSync('.local/stack.json', 'utf8'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const containers = docker('ps', '-a', '--format', '{{json .}}').split('\n').filter(Boolean).map(JSON.parse);
for (const old of before.containers) {
  const current = containers.find(c => c.ID === old.id);
  assert.ok(current, `Existing container missing: ${old.name}`);
  assert.equal(current.Names, old.name);
  assert.equal(current.State, old.state, `Other container state changed: ${old.name}`);
}
const volumes = docker('volume', 'ls', '--format', '{{.Name}}').split('\n');
const networks = docker('network', 'ls', '--format', '{{.Name}}').split('\n');
for (const old of before.volumes) assert.ok(volumes.includes(old), `Existing volume missing: ${old}`);
for (const old of before.networks) assert.ok(networks.includes(old), `Existing network missing: ${old}`);
const ours = JSON.parse(docker('inspect', ...containers.filter(c => c.Names.startsWith(`${stack.project}-`)).map(c => c.ID)));
for (const c of ours) {
  assert.equal(c.Config.Labels['com.docker.compose.project'], stack.project);
  for (const name of Object.keys(c.NetworkSettings.Networks)) assert.ok(name.startsWith(`${stack.project}_`));
  for (const mount of c.Mounts.filter(m => m.Type === 'volume')) assert.equal(mount.Name, stack.volume);
}
const volume = JSON.parse(docker('volume', 'inspect', stack.volume))[0];
assert.equal(volume.Labels['com.docker.compose.project'], stack.project);
const mysql = ours.find(c => c.Config.Labels['com.docker.compose.service'] === 'mysql');
assert.ok(!Object.values(mysql.HostConfig.PortBindings || {}).some(Boolean), 'MySQL must not publish ports');
const result = { passed: true, checkedAt: new Date().toISOString(), existingContainersUnchanged: before.containers.length, existingVolumesRetained: before.volumes.length, existingNetworksRetained: before.networks.length, newProject: stack.project, newContainers: ours.map(c => ({ name: c.Name.slice(1), state: c.State.Status, health: c.State.Health?.Status, ports: c.HostConfig.PortBindings })), volume: stack.volume, volumeOwner: volume.Labels['com.docker.compose.project'], networks: stack.networkNames };
writeFileSync('docs/docker-isolation-result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
