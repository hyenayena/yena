import {EventEmitter} from 'node:events';
import type {EventBus} from './api.js';

export function createEventBus(): EventBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);
	const key = (topic: string) => `ev:${topic}`;
	return {
		emit(topic, payload) {
			emitter.emit(key(topic), payload);
		},
		on(topic, handler) {
			const wrapped = (payload: unknown) => {
				try {
					const result: unknown = handler(payload);
					if (result instanceof Promise) result.catch(() => {});
				} catch {}
			};
			emitter.on(key(topic), wrapped);
			return () => {
				emitter.off(key(topic), wrapped);
			};
		},
	};
}
