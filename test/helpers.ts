import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";

export class FakeD1 implements Pick<D1Database, "prepare"> {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    const schema = readFileSync(
      fileURLToPath(new URL("../schema.sql", import.meta.url).href),
      "utf8",
    );
    this.db.exec(schema);
  }

  prepare(sql: string): D1PreparedStatement {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async run() {
        const r = db.prepare(sql).run(...(bound as never[]));
        return {
          success: true,
          meta: { changes: Number(r.changes) },
          results: [],
        };
      },
      async first() {
        return (db.prepare(sql).get(...(bound as never[])) ?? null) as never;
      },
      async all() {
        return {
          success: true,
          results: db.prepare(sql).all(...(bound as never[])),
          meta: {},
        };
      },
      async raw() {
        return [];
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }
}

export function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as Env["OAUTH_PROVIDER"],
    ADMIN_PASSWORD: "test-admin-password",
    OWTRACKS_USER: "owntracks",
    OWTRACKS_PASSWORD: "test-owntracks-password",
    HISTORY_SIZE: "10",
  };
}

export function makeCtx(): ExecutionContext & {
  awaited: Promise<unknown>[];
} {
  const awaited: Promise<unknown>[] = [];
  return {
    awaited,
    waitUntil(p: Promise<unknown>) {
      awaited.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext & { awaited: Promise<unknown>[] };
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

export function locationBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _type: "location",
    lat: 37.7749,
    lon: -122.4194,
    acc: 5,
    batt: 80,
    tst: Math.floor(Date.now() / 1000),
    tid: "JJ",
    ...overrides,
  });
}
