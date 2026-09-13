# ADR 0021: Voice Layer — Fully Local JARVIS Loop

Date: 2026-09-12
Status: Accepted

## Context

Shane wants a JARVIS-type voice system where nobody can tell it is AI, with a
distinct voice per AI (companion, Ikaris, Aries, Minerva). Cloud voice APIs
would stream household audio to third parties; the local-first pillar demands
better.

## Decision

Fully local stack on the Jetson Orin Nano, well under 1GB added footprint:

- Wake word: openWakeWord (always listening, negligible footprint).
- Speech-to-text: whisper.cpp (small/base).
- Speech out: Kokoro TTS — the natural-voice pick (Piper evaluated, rejected
  as audibly synthetic; StyleTTS 2 is the upgrade path).
- Brain: the already-resident MiniCPM 2B.

Honest bar: "no one can tell on a 30-second approval call" is achievable with
current local models; hour-long conversation is not. Spoken interactions are
designed *short* — the voice earns trust in bursts, long-form stays in text.

Voice is cast per persona by `identity/voice-cast.mjs`, following the same
stage -> explicit user select -> announce discipline as avatars. The companion
keeps one voice; crew modes use subtle variants. Household rule: voices stay
masculine-presenting.

ElevenLabs is the cloud overflow tier for maximum-naturalness moments (the
sev-1 call), gated by `defense/egress.mjs` like every other outbound — a
fallback, not the default.

## Consequences

- New modules: `voice/` (wakeword, stt, tts-local, tts-cloud).
- Voice profiles live on the identity record (migration 017).
