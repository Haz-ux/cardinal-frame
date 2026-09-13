/**
 * Cardinal Frame — STT — whisper.cpp Speech to Text
 *
 * Speech-to-text via whisper.cpp (small/base), ~500MB, fast on the Jetson
 * Orin. Second stage of the JARVIS loop: wake -> transcribe -> companion
 * turn -> speak.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): voice/wakeword.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function transcribe(audioRef) {
  notImplemented('transcribe');
}
