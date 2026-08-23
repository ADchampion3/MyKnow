import fs from "node:fs";
import path from "node:path";
import { createDatabase, migrate } from "@myknow/db";

const args = process.argv.slice(2);
if (args[0] !== "--confirm" || !args[1]) throw new Error("usage: node scripts/recreate-db.js --confirm <database-file>");
const target = path.resolve(args[1]);
if (path.extname(target).toLowerCase() !== ".db" || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("database-file must be an existing .db file");
fs.rmSync(target);
const { sqlite } = createDatabase(`file:${target}`);
const result = migrate(sqlite);
sqlite.close();
console.log(JSON.stringify({ database: target, schemaVersion: result.schemaVersion, rawStoragePreserved: true }));
