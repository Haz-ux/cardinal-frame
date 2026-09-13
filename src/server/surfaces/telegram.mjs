/**
 * Cardinal Frame — Telegram — Pocket Surface
 *
 * The companion pocket surface: full chat, proactive pings, and the
 * approve/deny buttons from the on-call loop — the whole money loop
 * resolves from the lock screen.
 *
 * Bot API with long-polling first: no inbound firewall holes, no webhook
 * server to expose. Same companion.mjs behind it, same relationship
 * memory, same turn loop — a different door into the same room, never a
 * second brain. Trust note: messages transit Telegram servers, so egress
 * classifies before anything is sent and secrets never ride the Bot API.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): companion/companion.mjs, defense/egress.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function start() {
  notImplemented('start');
}
export async function stop() {
  notImplemented('stop');
}
export async function sendMessage(chatId, text, buttons = []) {
  notImplemented('sendMessage');
}
export async function onCallback(cb) {
  notImplemented('onCallback');
}
