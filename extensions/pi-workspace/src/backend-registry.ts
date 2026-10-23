export type BackendRegistration<Backend> = { update(next: Backend): void; dispose(): void };

export class BackendRegistry<Backend> {
    private readonly entries = new Map<string, { backend: Backend }[]>();
    private readonly listeners = new Set<() => void>();
    private selected: string;

    constructor(
        private readonly defaults: ReadonlyMap<string, Backend>,
        private readonly initial: string,
    ) {
        if (!defaults.has(initial)) throw new Error("Initial backend is unavailable");

        this.selected = initial;
    }

    get name(): string {
        return this.selected;
    }

    get current(): Backend {
        const backend =
            this.entries.get(this.selected)?.at(-1)?.backend ?? this.defaults.get(this.selected);
        if (backend === undefined) throw new Error(`Backend is unavailable: ${this.selected}`);
        return backend;
    }

    select(name: string): void {
        if (!this.available(name)) throw new Error(`Unknown backend: ${name}`);

        const previous = this.selected;

        this.transaction(
            () => {
                this.selected = name;
            },
            () => {
                this.selected = previous;
            },
        );
    }

    register(name: string, backend: Backend): BackendRegistration<Backend> {
        if (name.length === 0) throw new Error("Backend name cannot be empty");

        const entries = this.entries.get(name) ?? [];
        const registration = { backend };
        const previousSelection = this.selected;

        this.transaction(
            () => {
                entries.push(registration);
                this.entries.set(name, entries);
            },
            () => {
                entries.pop();

                if (entries.length === 0) this.entries.delete(name);
            },
        );

        let disposed = false;

        return {
            update: (next) => {
                if (disposed) return;

                const previous = registration.backend;

                this.transaction(
                    () => {
                        registration.backend = next;
                    },
                    () => {
                        registration.backend = previous;
                    },
                );
            },
            dispose: () => {
                if (disposed) return;

                const index = entries.indexOf(registration);
                const selection = this.selected;

                this.transaction(
                    () => {
                        entries.splice(index, 1);

                        if (entries.length === 0) {
                            this.entries.delete(name);

                            if (this.selected === name && !this.defaults.has(name)) {
                                this.selected = this.initial;
                                if (this.available(previousSelection))
                                    this.selected = previousSelection;
                            }
                        }
                    },
                    () => {
                        entries.splice(index, 0, registration);
                        this.entries.set(name, entries);
                        this.selected = selection;
                    },
                );
                disposed = true;
            },
        };
    }

    observe(listener: () => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private available(name: string): boolean {
        return this.defaults.has(name) || this.entries.has(name);
    }

    private transaction(apply: () => void, restore: () => void): void {
        const previous = this.current;
        const name = this.selected;
        apply();

        const notified: (() => void)[] = [];

        try {
            if (this.current === previous && this.selected === name) return;

            for (const listener of this.listeners) {
                notified.push(listener);
                listener();
            }
        } catch (cause) {
            restore();

            const failures: unknown[] = [cause];
            for (const listener of notified.reverse()) {
                try {
                    listener();
                } catch (failure) {
                    failures.push(failure);
                }
            }

            if (failures.length > 1)
                throw new AggregateError(failures, "Backend activation and restoration failed");

            throw cause;
        }
    }
}
