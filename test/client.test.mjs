/**
 * Client bundle contract test. The boot manifest keys a plugin's client graph
 * row by its package name, and dsh-client-modules rejects the bundle unless it
 * registers exactly that id via __ModuleLoader__.load (a trailing "/client" is
 * normalized away). This guards the scoped-package rename from drifting away
 * from the hand-authored bundle id again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8');

test('client bundle registers under the package name', () => {
  const registrations = [];
  const context = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  };
  vm.runInNewContext(clientSource, context, { filename: 'lib/client.js' });

  assert.equal(registrations.length, 1, 'bundle must call __ModuleLoader__.load exactly once');
  const registration = registrations[0];
  assert.equal(typeof registration.factory, 'function', 'registration must expose a factory');
  const id = registration.id.endsWith('/client') ? registration.id.slice(0, -7) : registration.id;
  assert.equal(id, pkg.name, 'client registration id must match the package name');
});
