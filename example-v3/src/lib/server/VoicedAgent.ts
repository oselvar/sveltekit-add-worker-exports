import { Agent } from 'agents';
import { withVoice } from '@cloudflare/voice';

/**
 * Composes an `Agent` (DurableObject-based, from `agents`) with the voice
 * mixin from `@cloudflare/voice`. Present in the example to exercise the
 * plugin's bundling path through these packages — their transitive deps
 * pull in Node built-ins (`async_hooks`, `mime-types` calling
 * `require('path')`, etc.) that the build config in `src/index.ts` has to
 * handle without falling back to the Node-targeted variants of crypto
 * packages.
 */
export class VoicedAgent extends withVoice(Agent)<Env> {}
