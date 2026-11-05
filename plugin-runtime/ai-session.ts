/**
 * App-owned generation entry. Prompt UI and provider plugins call this instead of useAIHandlers.
 */

export const AI_SESSION_SERVICE = 'ai.session';

export interface AiSession {
  generate(): void;
}
