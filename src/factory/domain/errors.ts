/**
 * A typed Factory domain error. Factory-owned operations (state transitions,
 * persistence) throw these so callers can distinguish a rejected domain rule
 * from an infrastructure failure by its stable `code`.
 */
export class FactoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FactoryError';
  }
}
