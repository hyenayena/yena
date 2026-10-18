import {createHostLogger, installProcessHooks} from '../../src/log/index.js';

const [mode = 'normal', root = '', message = 'child', maxBytes = '', count = '200'] = process.argv.slice(2);

function crash(kind: string) {
	if (kind === 'throw') throw new Error('boom sk-ant-oat-TESTVALUE0123456789abcdef');
	if (kind === 'reject') void Promise.reject(new Error('rejected'));
}

const hooked = mode !== 'baseline-throw' && mode !== 'baseline-reject';
const logger = createHostLogger({root, env: process.env, ...(maxBytes ? {maxBytes: Number(maxBytes)} : {})});
if (hooked) {
	installProcessHooks(logger);
	installProcessHooks(logger);
}

switch (mode) {
	case 'exit3':
		process.exit(3);
		break;
	case 'throw':
	case 'baseline-throw':
		crash('throw');
		break;
	case 'reject':
	case 'baseline-reject':
		crash('reject');
		break;
	case 'append':
		for (let i = 0; i < Number(count); i++) logger.info(`${message} ${i}`, {i, pad: 'p'.repeat(100)});
		break;
	default:
		logger.info('hello');
}
