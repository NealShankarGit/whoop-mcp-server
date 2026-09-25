import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { WhoopDatabase } from '../dist/database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'integration-test-only-secret';
process.env.WHOOP_CLIENT_SECRET = secret;

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function start(dbPath, mode = 'ok', weight = '65.68') {
	const port = await freePort();
	const child = spawn(process.execPath, ['--import', './test/mock-whoop.mjs', 'dist/index.js'], {
		cwd: root,
		env: { ...process.env, WHOOP_CLIENT_ID: 'test-client', WHOOP_CLIENT_SECRET: secret,
			DB_PATH: dbPath, MCP_MODE: 'http', PORT: String(port), TEST_WEIGHT_MODE: mode,
			TEST_WEIGHT_KG: weight },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
	const base = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
		try {
			const response = await fetch(`${base}/health`);
			if (response.ok) return { child, base, stderr: () => stderr };
		} catch { // The socket is expected to refuse connections until listen() completes.
			await new Promise(resolve => setTimeout(resolve, 30));
		}
	}
	child.kill('SIGTERM');
	throw new Error(`Server did not start: ${stderr}`);
}

async function stop(server) {
	if (server.child.exitCode !== null) return;
	const exited = new Promise(resolve => server.child.once('exit', resolve));
	server.child.kill('SIGTERM');
	await exited;
}

async function rpc(base, method, params, sessionId) {
	const response = await fetch(`${base}/mcp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
			...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const body = await response.text();
	const data = body.startsWith('event:') ? body.match(/^data: (.*)$/m)?.[1] : body;
	return { status: response.status, sessionId: response.headers.get('mcp-session-id'),
		result: data ? JSON.parse(data) : null };
}

async function getToday(base) {
	const init = await rpc(base, 'initialize', {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'weight-test', version: '1.0' },
	});
	assert.equal(init.status, 200);
	assert.ok(init.sessionId);
	const call = await rpc(base, 'tools/call', { name: 'get_today', arguments: {} }, init.sessionId);
	assert.equal(call.status, 200);
	assert.equal(call.result.result.isError, undefined);
	return { text: call.result.result.content[0].text, sessionId: init.sessionId };
}

test('profile weight, failure, and auth survive the production launch path', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'whoop-weight-'));
	const dbPath = path.join(dir, 'whoop.db');
	let server;
	try {
		const db = new WhoopDatabase(dbPath);
		db.saveTokens({ access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 86_400_000 });
		db.updateSyncState('2026-09-24', '2026-09-24');
		db.close();
		server = await start(dbPath);
		const health = await (await fetch(`${server.base}/health`)).json();
		assert.equal(health.authenticated, true);
		const first = await getToday(server.base);
		assert.match(first.text, /- \*\*Weight\*\*: 144\.8 lbs \(WHOOP profile weight, manually entered; observed since [A-Z][a-z]{2} \d{1,2}, \d{4}\)/);
		const sqlite = new Database(dbPath);
		const observed = sqlite.prepare('SELECT first_observed_at FROM weight_observations').get().first_observed_at;
		assert.equal(sqlite.prepare('SELECT count(*) AS n FROM weight_observations').get().n, 1);
		await stop(server);
		server = await start(dbPath);
		const stale = await rpc(server.base, 'tools/call', { name: 'get_today', arguments: {} }, first.sessionId);
		assert.equal(stale.status, 404);
		assert.equal((await (await fetch(`${server.base}/health`)).json()).authenticated, true);
		const second = await getToday(server.base);
		assert.match(second.text, new RegExp(`observed since ${new Date(observed).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`));
		assert.equal(sqlite.prepare('SELECT count(*) AS n FROM weight_observations').get().n, 1);
		await stop(server);
		sqlite.prepare('UPDATE weight_observations SET first_observed_at = ?').run('2026-07-01T12:00:00.000Z');
		server = await start(dbPath);
		assert.match((await getToday(server.base)).text, /observed since Jul 1, 2026; unchanged for more than 30 days/);
		await stop(server);
		server = await start(dbPath, 'ok', '66.0');
		assert.match((await getToday(server.base)).text, /- \*\*Weight\*\*: 145\.5 lbs \(WHOOP profile weight, manually entered; observed since/);
		assert.equal(sqlite.prepare('SELECT count(*) AS n FROM weight_observations').get().n, 2);
		await stop(server);
		server = await start(dbPath, 'fail');
		assert.match((await getToday(server.base)).text, /- \*\*Weight\*\*: unavailable \(WHOOP API returned HTTP 503\)/);
		assert.match(server.stderr(), /\[whoop\] Weight unavailable: WHOOP API returned HTTP 503/);
		await stop(server);
		server = await start(dbPath, 'invalid');
		assert.match((await getToday(server.base)).text, /- \*\*Weight\*\*: unavailable \(WHOOP returned an invalid profile weight\)/);
		assert.match(server.stderr(), /\[whoop\] Weight unavailable: WHOOP returned an invalid profile weight/);
		sqlite.close();
	} finally {
		if (server) await stop(server);
		await rm(dir, { recursive: true, force: true });
	}
});
