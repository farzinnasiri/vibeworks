// Transport fault injection only. It never returns geometry and is not exposed to commands.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => { process.exit(17); });
