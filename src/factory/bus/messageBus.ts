export type MessageHandler<T = unknown> = (message: T) => void;

/**
 * In-process publish/subscribe seam (spec §19: the MessageBus/Queue is
 * initially in-process). MVP delivery is synchronous; handlers are isolated so
 * one subscriber cannot corrupt another.
 */
export interface MessageBus {
  publish<T>(topic: string, message: T): void;
  /** Subscribe to a topic; returns an unsubscribe function. */
  subscribe<T>(topic: string, handler: MessageHandler<T>): () => void;
}

export function createMessageBus(): MessageBus {
  const subscribers = new Map<string, Set<MessageHandler<unknown>>>();

  return {
    publish(topic, message) {
      const handlers = subscribers.get(topic);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        handler(message);
      }
    },

    subscribe(topic, handler) {
      const handlers = subscribers.get(topic) ?? new Set<MessageHandler<unknown>>();
      subscribers.set(topic, handlers);
      const registered = handler as MessageHandler<unknown>;
      handlers.add(registered);
      return () => {
        handlers.delete(registered);
      };
    },
  };
}
