import WebSocket, { type ClientOptions, type RawData } from "ws";
import { safeError } from "./common.js";

export interface PersistentSocketOptions {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
  onOpen(socket: WebSocket, generation: number): void;
  onMessage(data: RawData, socket: WebSocket, generation: number): void;
  onState(state: "connecting" | "live" | "reconnecting" | "closed", generation: number, reason?: string): void;
}

export class PersistentSocket {
  #socket: WebSocket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;
  #generation = 0;
  #attempt = 0;

  constructor(private readonly options: PersistentSocketOptions) {}

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close(1000, "runtime stopping");
    this.#socket = null;
    this.options.onState("closed", this.#generation);
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#generation += 1;
    const generation = this.#generation;
    this.options.onState(this.#attempt === 0 ? "connecting" : "reconnecting", generation);
    const clientOptions: ClientOptions = {};
    if (this.options.headers) clientOptions.headers = this.options.headers;
    const socket = this.options.protocols
      ? new WebSocket(this.options.url, this.options.protocols, clientOptions)
      : new WebSocket(this.options.url, clientOptions);
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#stopped || generation !== this.#generation) return;
      this.#attempt = 0;
      this.options.onState("live", generation);
      this.options.onOpen(socket, generation);
    });
    socket.on("message", (data) => {
      if (this.#stopped || generation !== this.#generation) return;
      try {
        this.options.onMessage(data, socket, generation);
      } catch (reason) {
        this.options.onState("reconnecting", generation, `message_parse_error:${safeError(reason)}`);
        socket.close(1011, "message parse error");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", (code) => {
      if (this.#stopped || generation !== this.#generation) return;
      this.#socket = null;
      this.#attempt += 1;
      this.options.onState("reconnecting", generation, `websocket_closed:${code}`);
      const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt, 6));
      this.#timer = setTimeout(() => this.#connect(), delayMs);
      this.#timer.unref();
    });
  }
}
