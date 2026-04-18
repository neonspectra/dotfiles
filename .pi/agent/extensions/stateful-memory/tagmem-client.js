/**
 * TagmemClient — MCP client for the tagmem semantic memory store.
 *
 * Connects to the tagmem proxy over a Unix domain socket using JSON-RPC 2.0
 * (newline-delimited JSON). Handles the MCP initialize handshake automatically.
 *
 * @example
 * ```js
 * const client = new TagmemClient();
 * await client.connect();
 * const results = await client.search('memory system', { limit: 5 });
 * const entry = await client.show(results.entries[0].id);
 * await client.close();
 * ```
 */

import net from "node:net";

const DEFAULT_SOCKET_PATH =
  (process.env.XDG_RUNTIME_DIR || "/run/user/1002") + "/tagmem.sock";

const REQUEST_TIMEOUT_MS = 30_000;
const ADD_TIMEOUT_MS = 60_000;

export class TagmemClient {
  /** @type {string} */
  #socketPath;
  /** @type {net.Socket|null} */
  #socket = null;
  /** @type {number} */
  #nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
  #pending = new Map();
  /** @type {string} */
  #buffer = "";
  /** @type {boolean} */
  #connected = false;

  /**
   * @param {object} [opts]
   * @param {string} [opts.socketPath] — Unix socket path (defaults to $XDG_RUNTIME_DIR/tagmem.sock)
   */
  constructor(opts = {}) {
    this.#socketPath = opts.socketPath || DEFAULT_SOCKET_PATH;
  }

  /**
   * Connect to the tagmem proxy and complete the MCP initialize handshake.
   * @returns {Promise<object>} The server's initialize result (capabilities, serverInfo, etc.)
   */
  async connect() {
    if (this.#connected) return;

    await new Promise((resolve, reject) => {
      this.#socket = net.connect(this.#socketPath);
      this.#socket.once("connect", resolve);
      this.#socket.once("error", reject);
    });

    this.#socket.on("data", (chunk) => this.#onData(chunk));
    this.#socket.on("error", (err) => this.#onError(err));
    this.#socket.on("close", () => this.#onClose());

    // MCP initialize handshake
    const initResult = await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-stateful-memory", version: "1.0.0" },
    });

    // Send initialized notification (no id = notification)
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });

    this.#connected = true;
    return initResult;
  }

  /**
   * Search tagmem entries by semantic similarity.
   * @param {string} query — Search query text
   * @param {object} [opts]
   * @param {number} [opts.depth] — Filter by depth level
   * @param {string} [opts.tag] — Filter by tag
   * @param {number} [opts.limit] — Max results (default varies by server)
   * @returns {Promise<{entries: object[], results: object[]}>}
   */
  async search(query, opts = {}) {
    const args = { query, ...opts };
    return this.#callTool("tagmem_search", args);
  }

  /**
   * Retrieve a single entry by ID.
   * @param {number} id — Entry ID
   * @returns {Promise<{entry: object}>}
   */
  async show(id) {
    return this.#callTool("tagmem_show_entry", { id });
  }

  /**
   * Add a new entry to the tagmem store.
   * @param {object} entry
   * @param {string} entry.title
   * @param {string} entry.body
   * @param {number} [entry.depth]
   * @param {string[]} [entry.tags]
   * @param {string} [entry.source]
   * @param {string} [entry.origin]
   * @returns {Promise<{entry: object}>}
   */
  async add(entry) {
    return this.#callTool("tagmem_add_entry", entry, { timeoutMs: ADD_TIMEOUT_MS });
  }

  /**
   * Get store status (total entries, depth counts, tags, etc.).
   * @returns {Promise<object>}
   */
  async status() {
    return this.#callTool("tagmem_status", {});
  }

  /**
   * List entries with optional filtering. Note: may be slow with large result sets.
   * @param {object} [opts]
   * @param {number} [opts.depth] — Filter by depth level
   * @param {string} [opts.tag] — Filter by tag
   * @param {number} [opts.limit] — Max results
   * @returns {Promise<{entries: object[]}>}
   */
  async list(opts = {}) {
    return this.#callTool("tagmem_list_entries", opts);
  }

  /**
   * Delete an entry by ID.
   * @param {number} id — Entry ID
   * @returns {Promise<object>}
   */
  async deleteEntry(id) {
    return this.#callTool("tagmem_delete_entry", { id }, { timeoutMs: ADD_TIMEOUT_MS });
  }

  /**
   * Close the connection and reject any pending requests.
   */
  close() {
    this.#connected = false;
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
    }
    this.#pending.clear();
    this.#buffer = "";
  }

  // ── Internals ──

  /**
   * Call an MCP tool and return the parsed structuredContent (or parsed text content).
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<object>}
   */
  async #callTool(toolName, args, opts = {}) {
    const result = await this.#request("tools/call", {
      name: toolName,
      arguments: args,
    }, opts);

    // Check for tool-level error
    if (result.isError) {
      const msg =
        result.content?.[0]?.text || JSON.stringify(result.content) || "Unknown tool error";
      throw new Error(`tagmem tool error (${toolName}): ${msg}`);
    }

    // Prefer structuredContent (already parsed), fall back to parsing content[0].text
    if (result.structuredContent) {
      return result.structuredContent;
    }
    if (result.content?.[0]?.text) {
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        return result.content[0].text;
      }
    }
    return result;
  }

  /**
   * Send a JSON-RPC request and return a promise for the result.
   * @param {string} method
   * @param {object} params
   * @returns {Promise<object>}
   */
  #request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`tagmem request timeout (${method}, id=${id})`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", method, id, params });
    });
  }

  /**
   * Write a JSON-RPC message to the socket.
   * @param {object} msg
   */
  #send(msg) {
    if (!this.#socket || this.#socket.destroyed) {
      throw new Error("tagmem socket not connected");
    }
    this.#socket.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Handle incoming data: buffer, split on newlines, dispatch responses.
   * @param {Buffer} chunk
   */
  #onData(chunk) {
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop(); // keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }

      // Only dispatch responses (messages with an id matching a pending request)
      if (msg.id != null && this.#pending.has(msg.id)) {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.error) {
          pending.reject(
            new Error(`tagmem RPC error: ${msg.error.message || JSON.stringify(msg.error)}`)
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  /**
   * Handle socket errors: reject all pending requests.
   * @param {Error} err
   */
  #onError(err) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
    this.#connected = false;
  }

  /**
   * Handle socket close.
   */
  #onClose() {
    this.#connected = false;
  }
}

export default TagmemClient;
