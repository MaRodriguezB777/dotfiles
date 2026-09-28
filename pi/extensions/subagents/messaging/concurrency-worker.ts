/**
 * Child process used by concurrency.test.ts: sends N messages to one hub and
 * prints the resulting ids as JSON on stdout.
 */
import { sendMessage } from "./index.ts";

const [runDir, senderId, hub, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const out: { message_id: string; thread_id: string }[] = [];
for (let i = 0; i < count; i++) {
	out.push(sendMessage(runDir, { id: senderId, generation: 1 }, { to: hub, text: `${senderId} #${i}` }));
}
process.stdout.write(JSON.stringify(out));
