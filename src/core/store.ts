export type Unsubscribe = () => void;
export type Listener<S> = (state: Readonly<S>) => void;

export class Store<S extends object> {
  #state: Readonly<S>;
  #listeners = new Set<Listener<S>>();

  constructor(state: S) { this.#state = Object.freeze(state); }
  get state() { return this.#state; }

  subscribe(listener: Listener<S>): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setState(patch: Partial<S>) {
    if ((Object.keys(patch) as (keyof S)[]).every(key => this.#state[key] === patch[key])) return;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener(this.#state);
  }
}
