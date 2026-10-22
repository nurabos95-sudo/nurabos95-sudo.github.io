// Nachbau der Cloudflare-D1-Schnittstelle über node:sqlite – damit der Worker ohne Cloudflare lokal getestet werden kann.
// (node --experimental-sqlite, ab Node 22)
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.db, this.sql, a); }
  _p() { return this.db.prepare(this.sql); }
  async first(col) { const r = this._p().get(...this.args); return r == null ? null : col ? r[col] : { ...r }; }
  async all() { return { results: this._p().all(...this.args).map((r) => ({ ...r })), success: true }; }
  async run() { const r = this._p().run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}
export class D1 {
  constructor(schemaFile) { this.db = new DatabaseSync(":memory:"); if (schemaFile) this.db.exec(readFileSync(schemaFile, "utf8")); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
}
