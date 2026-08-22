declare module 'better-sqlite3' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement<Row = unknown, BindParameters extends unknown[] = unknown[]> {
    run(...parameters: BindParameters): RunResult;
    get(...parameters: BindParameters): Row | undefined;
    all(...parameters: BindParameters): Row[];
  }

  interface Transaction<T extends (...args: never[]) => unknown> {
    (...args: Parameters<T>): ReturnType<T>;
    default(...args: Parameters<T>): ReturnType<T>;
  }

  class Database {
    constructor(filename: string, options?: { readonly?: boolean; timeout?: number; fileMustExist?: boolean; verbose?: (message?: unknown) => void });
    exec(source: string): this;
    prepare<Row = unknown, BindParameters extends unknown[] = unknown[]>(source: string): Statement<Row, BindParameters>;
    transaction<T extends (...args: never[]) => unknown>(functionToRun: T): Transaction<T>;
    pragma(source: string, simplify?: boolean): unknown;
    close(): void;
  }

  export default Database;
}
