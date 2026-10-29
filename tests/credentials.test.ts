import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CredentialAccount, CredentialCaller, CredentialProvider} from '../src/api.js';
import {createCredentialBroker} from '../src/credentials.js';

type Call = {op: string; args: unknown[]; caller: CredentialCaller};

function fakeProvider(label = 'p') {
	const calls: Call[] = [];
	const account: CredentialAccount = {name: 'a', kind: 'github', fields: {}, secrets: [], disabled: false, missing: []};
	const record = (op: string, args: unknown[]) => {
		calls.push({op, args: args.slice(0, -1), caller: args.at(-1) as CredentialCaller});
	};
	const provider: CredentialProvider = {
		async grants(...args) {
			record('grants', args);
			return [];
		},
		async list(...args) {
			record('list', args);
			return [account];
		},
		async read(...args) {
			record('read', args);
			return label;
		},
		async write(...args) {
			record('write', args);
		},
		async create(...args) {
			record('create', args);
			return account;
		},
		async remove(...args) {
			record('remove', args);
		},
	};
	return {provider, calls};
}

test('without a provider every operation fails with the install hint and available() is false', async () => {
	const broker = createCredentialBroker();
	const handle = broker.handleFor('claude', {claude: 'write'});
	assert.equal(handle.available(), false);
	const hint = /^Error: No credential store is installed \(mod install account\)$/;
	await assert.rejects(handle.grants(), hint);
	await assert.rejects(handle.list(), hint);
	await assert.rejects(handle.read('a', 'token'), hint);
	await assert.rejects(handle.write('a', 'token', 'x'), hint);
	await assert.rejects(handle.create({name: 'a', kind: 'claude'}), hint);
	await assert.rejects(handle.remove('a'), hint);
});

test('every operation reaches the provider with the bound caller and its declaration', async () => {
	const broker = createCredentialBroker();
	const handle = broker.handleFor('claude', {claude: 'write', github: 'read'});
	const {provider, calls} = fakeProvider();
	assert.equal(broker.register(provider, 'account'), true);
	assert.equal(handle.available(), true);

	await handle.grants();
	await handle.list('github');
	await handle.list();
	assert.equal(await handle.read('a', 'token'), 'p');
	await handle.write('a', 'token', undefined);
	await handle.create({name: 'b', kind: 'claude', fields: {x: '1'}});
	await handle.remove('b');

	assert.deepEqual(
		calls.map(c => [c.op, c.args]),
		[
			['grants', []],
			['list', ['github']],
			['list', [undefined]],
			['read', ['a', 'token']],
			['write', ['a', 'token', undefined]],
			['create', [{name: 'b', kind: 'claude', fields: {x: '1'}}]],
			['remove', ['b']],
		],
	);
	for (const c of calls) assert.deepEqual(c.caller, {module: 'claude', declared: {claude: 'write', github: 'read'}});
});

test('two handles reach the provider as their own modules, whatever the arguments say', async () => {
	const broker = createCredentialBroker();
	const {provider, calls} = fakeProvider();
	broker.register(provider, 'account');
	const a = broker.handleFor('alpha', {github: 'read'});
	const b = broker.handleFor('beta', {});
	const spoof = {module: 'alpha', declared: {github: 'write'}};
	await (b.read as (...args: unknown[]) => Promise<unknown>)('x', 'token', spoof);
	await (b.list as (...args: unknown[]) => Promise<unknown>)(undefined, spoof);
	await a.read('x', 'token');
	assert.deepEqual(
		calls.map(c => c.caller),
		[
			{module: 'beta', declared: {}},
			{module: 'beta', declared: {}},
			{module: 'alpha', declared: {github: 'read'}},
		],
	);
});

test('the caller and its declaration are frozen copies', async () => {
	const broker = createCredentialBroker();
	const {provider, calls} = fakeProvider();
	broker.register(provider, 'account');
	const declared: Record<string, 'read' | 'write'> = {github: 'read'};
	const handle = broker.handleFor('alpha', declared);
	declared.github = 'write';
	await handle.grants();
	const {caller} = calls[0]!;
	assert.equal(caller.declared.github, 'read');
	assert.ok(Object.isFrozen(caller) && Object.isFrozen(caller.declared));
	assert.ok(Object.isFrozen(handle));
});

test('the first provider wins', async () => {
	const broker = createCredentialBroker();
	const first = fakeProvider('first');
	const second = fakeProvider('second');
	assert.equal(broker.register(first.provider, 'account'), true);
	assert.equal(broker.register(second.provider, 'evil'), false);
	assert.equal(await broker.handleFor('m', {}).read('a', 'f'), 'first');
	assert.equal(second.calls.length, 0);
});

test('a handle made before the provider registers uses it once it is there', async () => {
	const broker = createCredentialBroker();
	const handle = broker.handleFor('m', {});
	await assert.rejects(handle.grants(), /No credential store/);
	broker.register(fakeProvider().provider, 'account');
	assert.deepEqual(await handle.grants(), []);
});

test('an invalid provider is refused', () => {
	const broker = createCredentialBroker();
	assert.throws(() => broker.register({} as CredentialProvider, 'bad'), /invalid credential provider from bad/);
	assert.throws(() => broker.register(null as unknown as CredentialProvider, 'bad'), /invalid credential provider/);
	assert.equal(broker.handleFor('m', {}).available(), false);
});

test('provider errors reach the module unchanged', async () => {
	const broker = createCredentialBroker();
	const failure = Object.assign(new Error('denied'), {code: 'CREDENTIAL_ACCESS'});
	const {provider} = fakeProvider();
	broker.register({...provider, read: async () => Promise.reject(failure)}, 'account');
	await assert.rejects(broker.handleFor('m', {}).read('a', 'f'), e => e === failure);
});
