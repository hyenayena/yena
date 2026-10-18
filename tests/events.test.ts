import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createEventBus} from '../src/events.js';

test('emit reaches handlers and off unsubscribes', () => {
	const bus = createEventBus();
	const seen: unknown[] = [];
	const off = bus.on('t', p => seen.push(p));
	bus.emit('t', 1);
	off();
	bus.emit('t', 2);
	assert.deepEqual(seen, [1]);
});

test('a throwing handler does not affect emit or other handlers', () => {
	const bus = createEventBus();
	const seen: unknown[] = [];
	bus.on('t', () => {
		throw new Error('boom');
	});
	bus.on('t', p => seen.push(p));
	assert.doesNotThrow(() => bus.emit('t', 1));
	assert.deepEqual(seen, [1]);
});

test('the "error" topic is not special', () => {
	const bus = createEventBus();
	assert.doesNotThrow(() => bus.emit('error', new Error('x')));
});
