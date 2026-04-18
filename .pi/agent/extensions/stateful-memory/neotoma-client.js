/**
 * NeotomaClient — CLI wrapper for the Neotoma entity/observation store.
 *
 * Calls `neotoma --offline --json <subcommand>` via child_process.execFile.
 * All methods return parsed JSON. Stderr warnings (e.g. Node experimental
 * feature notices) are ignored.
 *
 * @example
 * ```js
 * const client = new NeotomaClient();
 * const { entities } = await client.listEntities();
 * const entity = await client.getEntity(entities[0].entity_id);
 * ```
 */

import { execFile } from "node:child_process";

const DEFAULT_DATA_DIR = "/home/monika/.pi/neotoma";
const DEFAULT_BINARY = "neotoma";
const EXEC_TIMEOUT_MS = 15_000;

export class NeotomaClient {
  /** @type {string} */
  #dataDir;
  /** @type {string} */
  #binary;

  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir] — Path to Neotoma data directory
   * @param {string} [opts.binary] — Path to neotoma binary (default: "neotoma")
   */
  constructor(opts = {}) {
    this.#dataDir = opts.dataDir || DEFAULT_DATA_DIR;
    this.#binary = opts.binary || DEFAULT_BINARY;
  }

  /**
   * List all entities.
   * @returns {Promise<{entities: object[], limit: number, offset: number, total: number}>}
   */
  async listEntities() {
    return this.#exec(["entities", "list"]);
  }

  /**
   * Get a single entity by ID.
   * @param {string} id — Entity ID (e.g. "ent_abc123...")
   * @returns {Promise<object>} The entity object
   */
  async getEntity(id) {
    return this.#exec(["entities", "get", id]);
  }

  /**
   * Search entities by text query.
   * @param {string} query — Search text
   * @returns {Promise<{entities: object[], total: number}>}
   */
  async searchEntities(query) {
    return this.#exec(["entities", "search", query]);
  }

  /**
   * Store observations for one or more entities.
   * Creates entities if they don't exist; appends observations to existing ones.
   *
   * @param {Array<{entity_type: string, name: string, observations: string[]}>} entities
   * @param {object} [opts]
   * @param {string} [opts.idempotency_key] — Optional idempotency key
   * @returns {Promise<{success: boolean, entities_created: object[], observations_created: number, source_id: string}>}
   */
  async storeObservations(entities, opts = {}) {
    const payload = JSON.stringify(entities);
    const args = ["store", "--entities", payload];
    if (opts.idempotency_key) {
      args.push("--idempotency-key", opts.idempotency_key);
    }
    return this.#exec(args);
  }

  // ── Internals ──

  /**
   * Execute a neotoma CLI command and return parsed JSON.
   * @param {string[]} subArgs — Arguments after `--offline --json`
   * @returns {Promise<object>}
   */
  #exec(subArgs) {
    const args = ["--offline", "--json", ...subArgs];
    const env = {
      ...process.env,
      NEOTOMA_DATA_DIR: this.#dataDir,
      // Data lives in neotoma.db (development), not neotoma.prod.db
      // NEOTOMA_ENV intentionally omitted to use default (development)
    };

    return new Promise((resolve, reject) => {
      execFile(
        this.#binary,
        args,
        { timeout: EXEC_TIMEOUT_MS, env, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // Include stderr context for debugging but don't fail on warnings alone
            const detail = stderr ? ` (stderr: ${stderr.trim().slice(0, 200)})` : "";
            reject(new Error(`neotoma error: ${err.message}${detail}`));
            return;
          }

          const text = stdout.trim();
          if (!text) {
            resolve({});
            return;
          }

          try {
            resolve(JSON.parse(text));
          } catch (parseErr) {
            reject(
              new Error(
                `neotoma JSON parse error: ${parseErr.message} — stdout: ${text.slice(0, 200)}`
              )
            );
          }
        }
      );
    });
  }
}

export default NeotomaClient;
