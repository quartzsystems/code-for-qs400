// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  connectParams,
  libraryName,
  parseConnections,
  profileName,
  secretKey,
  toSetting,
} from '../src/connections/config';
import { errorText, untrustedCertificate } from '../src/connections/prompts';
import { HostRpcError } from '../src/host/client';
import { SessionErrorCodes } from '../src/host/protocol';

suite('Connections: settings', () => {
  test('a full entry parses', () => {
    const { connections, problems } = parseConnections([
      {
        name: 'QSHQ400',
        host: 'qshq400.example.com',
        port: 2320,
        user: 'cwellman',
        tls: { verify: true, caFile: '/etc/qs400/ca.pem' },
        libraryList: { current: 'cwellman', user: ['qgpl', 'QTEMP', 'qgpl'] },
      },
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(connections, [
      {
        name: 'QSHQ400',
        host: 'qshq400.example.com',
        port: 2320,
        user: 'CWELLMAN',
        tls: { verify: true, caFile: '/etc/qs400/ca.pem' },
        libraryList: { current: 'CWELLMAN', user: ['QGPL', 'QTEMP'] },
      },
    ]);
  });

  test('the port is optional and has no default here', () => {
    const { connections } = parseConnections([{ name: 'A', host: 'h', user: 'U' }]);
    assert.deepEqual(connections, [{ name: 'A', host: 'h', user: 'U' }]);
    assert.equal('port' in connectParams(connections[0], 'pw'), false);
  });

  test('bad entries are skipped and reported, not thrown', () => {
    const { connections, problems } = parseConnections([
      'nope',
      { name: 'A', host: 'h' },
      { name: 'B', host: 'h', user: 'U', port: 70000 },
      { name: 'b', host: 'other', user: 'U' },
      { name: 'C', host: 'h', user: 'NOT A PROFILE' },
      { name: 'D', host: 'h', user: 'U', libraryList: { user: ['OK', 'not ok', 5] } },
    ]);
    assert.deepEqual(
      connections.map((c) => c.name),
      ['B', 'D'],
    );
    assert.equal(connections[0].port, undefined);
    assert.deepEqual(connections[1].libraryList, { user: ['OK'] });
    assert.equal(problems.length, 7, problems.join('\n'));
    assert.deepEqual(parseConnections({}).problems, ['code-for-qs400.connections is not an array']);
    assert.deepEqual(parseConnections(undefined), { connections: [], problems: [] });
  });

  test('names compare without case', () => {
    const { connections, problems } = parseConnections([
      { name: 'QSHQ400', host: 'a', user: 'U' },
      { name: 'qshq400', host: 'b', user: 'U' },
    ]);
    assert.equal(connections.length, 1);
    assert.match(problems[0], /used twice/);
  });

  test('a connection round-trips through the setting', () => {
    const c = { name: 'X', host: 'h', user: 'U', libraryList: { current: 'L1', user: ['L2'] } };
    assert.deepEqual(parseConnections([toSetting(c)]).connections, [c]);
    assert.deepEqual(toSetting({ name: 'X', host: 'h', user: 'U', libraryList: { user: [] } }), {
      name: 'X',
      host: 'h',
      user: 'U',
    });
  });

  test('connect params carry the tls block and the password', () => {
    assert.deepEqual(
      connectParams({ name: 'X', host: 'h', port: 9, user: 'U', tls: { caFile: 'ca.pem' } }, 's3cret'),
      { name: 'X', host: 'h', port: 9, user: 'U', password: 's3cret', tls: { caFile: 'ca.pem' } },
    );
  });

  test('trusted certificates round-trip and go to session.connect', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const c = { name: 'X', host: 'h', user: 'U', tls: { certificates: [pem] } };
    assert.deepEqual(parseConnections([toSetting(c)]), { connections: [c], problems: [] });
    assert.deepEqual(connectParams(c).tls, { certificates: [pem] });
    const { connections, problems } = parseConnections([
      { name: 'Y', host: 'h', user: 'U', tls: { certificates: [pem, 'not a certificate', 5] } },
      { name: 'Z', host: 'h', user: 'U', tls: { certificates: pem } },
    ]);
    assert.deepEqual(connections[0].tls, { certificates: [pem] });
    assert.equal(connections[1].tls, undefined);
    assert.equal(problems.length, 2, problems.join('\n'));
  });

  test('an untrusted certificate is offered only when the host sent it', () => {
    const data = { kind: 'untrusted', reason: 'invalid peer certificate: UnknownIssuer', certificate: 'PEM', sha256: 'AB' };
    assert.deepEqual(untrustedCertificate(new HostRpcError(SessionErrorCodes.Transport, 'x', data)), data);
    assert.equal(untrustedCertificate(new HostRpcError(SessionErrorCodes.Transport, 'x', { kind: 'untrusted', reason: 'r' })), undefined);
    assert.equal(untrustedCertificate(new HostRpcError(SessionErrorCodes.Server, 'x', data)), undefined);
    assert.equal(untrustedCertificate(new Error('x')), undefined);
  });

  test('library and profile names', () => {
    assert.equal(libraryName(' qgpl '), 'QGPL');
    assert.equal(libraryName('$TOOLS'), '$TOOLS');
    assert.equal(libraryName('#X_1.A'), '#X_1.A');
    for (const bad of ['', '1ABC', 'ABCDEFGHIJK', 'MY LIB', '*LIBL']) {
      assert.equal(libraryName(bad), undefined, bad);
    }
    assert.equal(profileName('cwellman'), 'CWELLMAN');
    assert.equal(profileName('A.B'), undefined);
  });
});

suite('Connections: secrets and messages', () => {
  test('the secret key is the connection name under the extension prefix', () => {
    assert.equal(secretKey('QSHQ400'), 'code-for-qs400.password.QSHQ400');
    assert.equal(secretKey('dev box'), 'code-for-qs400.password.dev box');
  });

  test('a server message is shown as messageId: text, nothing added', () => {
    const err = new HostRpcError(SessionErrorCodes.Server, 'CPF1107: Password or user profile is not correct.', {
      status: 'SignOnFailed',
      messageId: 'CPF1107',
      text: 'Password or user profile is not correct.',
    });
    assert.equal(errorText(err, 'QSHQ400'), 'CPF1107: Password or user profile is not correct.');
  });

  test('anything else is shown after the connection name', () => {
    const err = new HostRpcError(SessionErrorCodes.Transport, 'connection refused');
    assert.equal(errorText(err, 'QSHQ400'), 'QSHQ400: connection refused');
    assert.equal(errorText(new Error('x')), 'x');
  });

  test('the connection commands are contributed', async () => {
    await vscode.extensions.getExtension('quartzsystems.code-for-qs400')?.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['add', 'edit', 'remove', 'connect', 'disconnect', 'setDefault', 'forgetPassword']) {
      assert.ok(commands.includes(`code-for-qs400.connection.${id}`), id);
    }
  });
});
