/**
 * node:sqlite 的最小类型声明。
 *
 * 项目锁定的 @types/node 版本尚未包含 node:sqlite，这里只声明用到的接口，
 * 避免为运行时内置模块升级整个 types 包。
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
