import { DurableObject } from "cloudflare:workers";

import type { LnurlSuccessAction } from "../src/lightning/lnurl";
import {
  parseAndValidateZapRequest,
  validateZapReceipt,
} from "../src/nostr/zap";

const MAX_SESSION_LIFETIME_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_PROVIDER_METADATA_BYTES = 192 * 1_024;
const MAX_INVOICE_BYTES = 16 * 1_024;
const MAX_NOTE_CHARACTERS = 144;
const MAX_SUCCESS_ACTION_URL_BYTES = 4 * 1_024;
const MAX_ZAP_REQUEST_BYTES = 64 * 1_024;
const MAX_RECEIPT_BYTES = 64 * 1_024;
const MAX_CONTENT_BYTES = 8 * 1_024;
const MAX_TAGS = 128;
const MAX_TAG_FIELDS = 16;
const MAX_TAG_FIELD_BYTES = 8 * 1_024;
const MAX_CONNECTIONS = 16;
const MAX_MESSAGES_PER_CONNECTION = 128;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 8;
const MAX_FILTERS_PER_SUBSCRIPTION = 4;
const MAX_FILTER_VALUES = 16;
const MAX_SUBSCRIPTION_ID_BYTES = 64;

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_128 = /^[0-9a-f]{128}$/u;
const HEX_PREFIX = /^[0-9a-f]{1,64}$/u;
const AMOUNT_MSAT = /^(?:[1-9][0-9]{0,18})$/u;
const BOLT11 = /^ln(?:bc|tb|bcrt)[0-9a-z]+$/u;
const MAX_BITCOIN_SUPPLY_MSAT = 2_100_000_000_000_000_000n;

export interface PaymentSessionInitialization {
  readonly expiresAtMs: number;
  readonly providerMetadata: string;
  readonly amountMsat: string;
  readonly invoice: string;
  readonly note?: string;
  readonly successAction?: LnurlSuccessAction;
  readonly nip57?: {
    readonly providerPubkey: string;
    readonly requestJson: string;
    readonly expectedPaymentHash: string;
  };
}

export interface PaymentSession {
  readonly expiresAtMs: number;
  readonly providerMetadata: string;
  readonly amountMsat: string;
  readonly invoice: string;
  readonly note?: string;
  readonly successAction?: LnurlSuccessAction;
  readonly nip57?: {
    readonly providerPubkey: string;
    readonly requestJson: string;
    readonly expectedPaymentHash: string;
  };
}

export interface Nip57ReceiptEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: 9735;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

interface StoredChannelRow {
  readonly [key: string]: string | number | null;
  readonly session_json: string;
  readonly expires_at_ms: number;
  readonly receipt_json: string | null;
  readonly receipt_id: string | null;
}

interface ReceiptFilter {
  readonly ids?: readonly string[];
  readonly authors?: readonly string[];
  readonly kinds?: readonly number[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly "#p"?: readonly string[];
}

interface SocketState {
  readonly messageCount: number;
  readonly subscriptions: Readonly<Record<string, readonly ReceiptFilter[]>>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sessionJson(session: PaymentSession): string {
  return JSON.stringify({
    expiresAtMs: session.expiresAtMs,
    providerMetadata: session.providerMetadata,
    amountMsat: session.amountMsat,
    invoice: session.invoice,
    ...(session.note === undefined ? {} : { note: session.note }),
    ...(session.successAction === undefined
      ? {}
      : { successAction: session.successAction }),
    ...(session.nip57 === undefined ? {} : { nip57: session.nip57 }),
  });
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s/gu, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)
  ) {
    return undefined;
  }
  try {
    const binary = atob(compact);
    if (btoa(binary) !== compact) return undefined;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function normalizeSuccessAction(
  value: unknown,
): LnurlSuccessAction | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.tag !== "string") {
    throw new TypeError("Invalid payment success action.");
  }
  if (
    value.tag === "message" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    [...value.message].length <= MAX_NOTE_CHARACTERS &&
    !value.message.includes("\u0000")
  ) {
    return Object.freeze({ tag: "message", message: value.message });
  }
  if (
    value.tag === "url" &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    [...value.description].length <= MAX_NOTE_CHARACTERS &&
    typeof value.url === "string" &&
    byteLength(value.url) <= MAX_SUCCESS_ACTION_URL_BYTES
  ) {
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError("Invalid payment success action URL.");
    }
    return Object.freeze({
      tag: "url",
      description: value.description,
      url: url.toString(),
    });
  }
  if (
    value.tag === "aes" &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    [...value.description].length <= MAX_NOTE_CHARACTERS &&
    typeof value.ciphertext === "string" &&
    value.ciphertext.length > 0 &&
    value.ciphertext.length <= 4_096 &&
    typeof value.iv === "string" &&
    value.iv.length === 24
  ) {
    const ciphertext = decodeStrictBase64(value.ciphertext);
    const iv = decodeStrictBase64(value.iv);
    if (
      ciphertext === undefined ||
      ciphertext.length === 0 ||
      ciphertext.length % 16 !== 0 ||
      iv?.length !== 16
    ) {
      throw new TypeError("Invalid payment success action.");
    }
    return Object.freeze({
      tag: "aes",
      description: value.description,
      ciphertext: value.ciphertext,
      iv: value.iv,
    });
  }
  throw new TypeError("Invalid payment success action.");
}

function normalizeNip57Context(value: unknown): PaymentSession["nip57"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["providerPubkey", "requestJson", "expectedPaymentHash"]),
    ) ||
    typeof value.providerPubkey !== "string" ||
    !HEX_64.test(value.providerPubkey) ||
    typeof value.requestJson !== "string" ||
    value.requestJson.length < 1 ||
    byteLength(value.requestJson) > MAX_ZAP_REQUEST_BYTES ||
    typeof value.expectedPaymentHash !== "string" ||
    !HEX_64.test(value.expectedPaymentHash)
  ) {
    throw new TypeError("Invalid NIP-57 payment context.");
  }
  parseAndValidateZapRequest(value.requestJson, {
    expectedProviderPubkey: value.providerPubkey,
  });
  return Object.freeze({
    providerPubkey: value.providerPubkey,
    requestJson: value.requestJson,
    expectedPaymentHash: value.expectedPaymentHash,
  });
}

export function normalizePaymentSessionInitialization(
  value: unknown,
  nowMs = Date.now(),
): PaymentSession {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        "expiresAtMs",
        "providerMetadata",
        "amountMsat",
        "invoice",
        "note",
        "successAction",
        "nip57",
      ]),
    ) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    Number(value.expiresAtMs) <= nowMs ||
    Number(value.expiresAtMs) - nowMs > MAX_SESSION_LIFETIME_MS ||
    typeof value.providerMetadata !== "string" ||
    value.providerMetadata.length === 0 ||
    byteLength(value.providerMetadata) > MAX_PROVIDER_METADATA_BYTES ||
    typeof value.amountMsat !== "string" ||
    !AMOUNT_MSAT.test(value.amountMsat) ||
    BigInt(value.amountMsat) > MAX_BITCOIN_SUPPLY_MSAT ||
    typeof value.invoice !== "string" ||
    byteLength(value.invoice) > MAX_INVOICE_BYTES ||
    !BOLT11.test(value.invoice) ||
    (value.note !== undefined &&
      (typeof value.note !== "string" ||
        [...value.note].length > MAX_NOTE_CHARACTERS ||
        value.note.includes("\u0000")))
  ) {
    throw new TypeError("Invalid payment session initialization.");
  }

  const successAction = normalizeSuccessAction(value.successAction);
  const nip57 = normalizeNip57Context(value.nip57);

  return Object.freeze({
    expiresAtMs: Number(value.expiresAtMs),
    providerMetadata: value.providerMetadata,
    amountMsat: value.amountMsat,
    invoice: value.invoice,
    ...(value.note === undefined ? {} : { note: value.note }),
    ...(successAction === undefined ? {} : { successAction }),
    ...(nip57 === undefined ? {} : { nip57 }),
  });
}

function normalizeTags(value: unknown): readonly (readonly string[])[] | null {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return null;
  const tags: string[][] = [];
  for (const candidate of value) {
    if (
      !Array.isArray(candidate) ||
      candidate.length === 0 ||
      candidate.length > MAX_TAG_FIELDS
    ) {
      return null;
    }
    const tag: string[] = [];
    for (const field of candidate) {
      if (
        typeof field !== "string" ||
        byteLength(field) > MAX_TAG_FIELD_BYTES
      ) {
        return null;
      }
      tag.push(field);
    }
    tags.push(tag);
  }
  return tags;
}

export function normalizeNip57ReceiptEvent(
  value: unknown,
): Nip57ReceiptEvent | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["id", "pubkey", "created_at", "kind", "tags", "content", "sig"]),
    ) ||
    typeof value.id !== "string" ||
    !HEX_64.test(value.id) ||
    typeof value.pubkey !== "string" ||
    !HEX_64.test(value.pubkey) ||
    !Number.isSafeInteger(value.created_at) ||
    Number(value.created_at) < 0 ||
    value.kind !== 9735 ||
    typeof value.content !== "string" ||
    byteLength(value.content) > MAX_CONTENT_BYTES ||
    typeof value.sig !== "string" ||
    !HEX_128.test(value.sig)
  ) {
    return null;
  }
  const tags = normalizeTags(value.tags);
  if (tags === null) return null;

  const event: Nip57ReceiptEvent = {
    id: value.id,
    pubkey: value.pubkey,
    created_at: Number(value.created_at),
    kind: 9735,
    tags,
    content: value.content,
    sig: value.sig,
  };
  return byteLength(JSON.stringify(event)) <= MAX_RECEIPT_BYTES
    ? Object.freeze(event)
    : null;
}

function normalizeStringArray(
  value: unknown,
  pattern?: RegExp,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILTER_VALUES) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      byteLength(entry) > 256 ||
      (pattern !== undefined && !pattern.test(entry))
    ) {
      return null;
    }
    strings.push(entry);
  }
  return strings;
}

function normalizeFilter(value: unknown): ReceiptFilter | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["ids", "authors", "kinds", "since", "until", "limit", "#p"]),
    )
  ) {
    return null;
  }

  const ids =
    value.ids === undefined
      ? undefined
      : normalizeStringArray(value.ids, HEX_PREFIX);
  const authors =
    value.authors === undefined
      ? undefined
      : normalizeStringArray(value.authors, HEX_PREFIX);
  const pValues =
    value["#p"] === undefined ? undefined : normalizeStringArray(value["#p"]);
  const kinds = value.kinds;
  if (
    ids === null ||
    authors === null ||
    pValues === null ||
    (kinds !== undefined &&
      (!Array.isArray(kinds) ||
        kinds.length > MAX_FILTER_VALUES ||
        !kinds.every(
          (kind) =>
            Number.isSafeInteger(kind) &&
            Number(kind) >= 0 &&
            Number(kind) <= 65_535,
        ))) ||
    (value.since !== undefined &&
      (!Number.isSafeInteger(value.since) || Number(value.since) < 0)) ||
    (value.until !== undefined &&
      (!Number.isSafeInteger(value.until) || Number(value.until) < 0)) ||
    (value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) ||
        Number(value.limit) < 0 ||
        Number(value.limit) > 1))
  ) {
    return null;
  }

  return {
    ...(ids === undefined ? {} : { ids }),
    ...(authors === undefined ? {} : { authors }),
    ...(kinds === undefined ? {} : { kinds: kinds.map(Number) }),
    ...(value.since === undefined ? {} : { since: Number(value.since) }),
    ...(value.until === undefined ? {} : { until: Number(value.until) }),
    ...(value.limit === undefined ? {} : { limit: Number(value.limit) }),
    ...(pValues === undefined ? {} : { "#p": pValues }),
  };
}

function matchesPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function matchesReceiptFilter(
  event: Nip57ReceiptEvent,
  filter: ReceiptFilter,
): boolean {
  if (filter.limit === 0) return false;
  if (filter.ids !== undefined && !matchesPrefix(event.id, filter.ids))
    return false;
  if (
    filter.authors !== undefined &&
    !matchesPrefix(event.pubkey, filter.authors)
  ) {
    return false;
  }
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind))
    return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  if (
    filter["#p"] !== undefined &&
    !event.tags.some(
      (tag) => tag[0] === "p" && filter["#p"]!.includes(tag[1] ?? ""),
    )
  ) {
    return false;
  }
  return true;
}

function normalizeSocketState(value: unknown): SocketState {
  if (!isRecord(value) || !Number.isSafeInteger(value.messageCount)) {
    return { messageCount: 0, subscriptions: {} };
  }
  const subscriptions: Record<string, readonly ReceiptFilter[]> = {};
  if (isRecord(value.subscriptions)) {
    for (const [subscriptionId, filters] of Object.entries(
      value.subscriptions,
    )) {
      if (
        Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION ||
        byteLength(subscriptionId) > MAX_SUBSCRIPTION_ID_BYTES ||
        !Array.isArray(filters) ||
        filters.length > MAX_FILTERS_PER_SUBSCRIPTION
      ) {
        continue;
      }
      const normalized = filters.map(normalizeFilter);
      if (normalized.every((filter) => filter !== null)) {
        subscriptions[subscriptionId] = normalized as ReceiptFilter[];
      }
    }
  }
  return {
    messageCount: Number(value.messageCount),
    subscriptions,
  };
}

function send(ws: WebSocket, message: readonly unknown[]): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The peer can disappear between getWebSockets() and send().
  }
}

export class Nip57ReceiptRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.createSchema());
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_json TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        receipt_json TEXT,
        receipt_id TEXT
      )
    `);
  }

  private row(): StoredChannelRow | null {
    return (
      this.ctx.storage.sql
        .exec<StoredChannelRow>(
          `SELECT session_json, expires_at_ms, receipt_json, receipt_id
           FROM channel_state WHERE singleton = 1`,
        )
        .toArray()[0] ?? null
    );
  }

  private async expire(): Promise<void> {
    await this.ctx.storage.deleteAll();
    // deleteAll() removes SQLite tables as well as rows. Recreate the empty
    // schema because the in-memory instance may receive an RPC before eviction.
    this.createSchema();
    for (const ws of this.ctx.getWebSockets()) {
      send(ws, ["NOTICE", "expired: payment session expired"]);
      try {
        ws.close(1000, "payment session expired");
      } catch {
        // Closing an already closed hibernating socket is harmless.
      }
    }
  }

  private async activeRow(): Promise<StoredChannelRow | null> {
    const row = this.row();
    if (row !== null && row.expires_at_ms <= Date.now()) {
      await this.expire();
      return null;
    }
    return row;
  }

  async initialize(
    input: PaymentSessionInitialization,
  ): Promise<PaymentSession> {
    const session = normalizePaymentSessionInitialization(input);
    const encoded = sessionJson(session);
    let existing = this.row();
    if (existing !== null && existing.expires_at_ms <= Date.now()) {
      await this.expire();
      existing = null;
    }
    if (existing !== null) {
      if (existing.session_json !== encoded) {
        throw new Error("Payment session is already initialized.");
      }
      await this.ctx.storage.setAlarm(existing.expires_at_ms);
      return session;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO channel_state
         (singleton, session_json, expires_at_ms, receipt_json, receipt_id)
       VALUES (1, ?, ?, NULL, NULL)`,
      encoded,
      session.expiresAtMs,
    );
    await this.ctx.storage.setAlarm(session.expiresAtMs);
    return session;
  }

  async getPaymentSession(): Promise<PaymentSession | null> {
    const row = await this.activeRow();
    if (row === null) return null;
    return normalizePaymentSessionInitialization(
      JSON.parse(row.session_json) as unknown,
      Math.min(Date.now(), row.expires_at_ms - 1),
    );
  }

  async getReceipt(): Promise<Nip57ReceiptEvent | null> {
    const row = await this.activeRow();
    if (row?.receipt_json === null || row === null) return null;
    return normalizeNip57ReceiptEvent(JSON.parse(row.receipt_json) as unknown);
  }

  override async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    if ((await this.activeRow()) === null) {
      return new Response("Payment session is not active.", { status: 404 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Connection limit reached.", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      messageCount: 0,
      subscriptions: {},
    } satisfies SocketState);
    return new Response(null, { status: 101, webSocket: client });
  }

  private currentReceipt(): Nip57ReceiptEvent | null {
    const encoded = this.row()?.receipt_json;
    if (encoded === null || encoded === undefined) return null;
    return normalizeNip57ReceiptEvent(JSON.parse(encoded) as unknown);
  }

  private publishToSubscriptions(event: Nip57ReceiptEvent): void {
    for (const socket of this.ctx.getWebSockets()) {
      const state = normalizeSocketState(socket.deserializeAttachment());
      for (const [subscriptionId, filters] of Object.entries(
        state.subscriptions,
      )) {
        if (filters.some((filter) => matchesReceiptFilter(event, filter))) {
          send(socket, ["EVENT", subscriptionId, event]);
        }
      }
    }
  }

  private handleEvent(ws: WebSocket, message: readonly unknown[]): void {
    const suppliedId =
      isRecord(message[1]) && typeof message[1].id === "string"
        ? message[1].id
        : "";
    if (message.length !== 2) {
      send(ws, ["OK", suppliedId, false, "invalid: malformed EVENT"]);
      return;
    }
    const event = normalizeNip57ReceiptEvent(message[1]);
    if (event === null) {
      send(ws, ["OK", suppliedId, false, "invalid: malformed kind 9735 event"]);
      return;
    }

    const row = this.row();
    if (row === null) {
      send(ws, [
        "OK",
        event.id,
        false,
        "expired: payment session is not active",
      ]);
      return;
    }
    if (row.receipt_json !== null) {
      const duplicate =
        row.receipt_id === event.id &&
        row.receipt_json === JSON.stringify(event);
      send(ws, [
        "OK",
        event.id,
        duplicate,
        duplicate
          ? "duplicate: receipt already stored"
          : "restricted: this channel already has a receipt",
      ]);
      return;
    }

    let session: PaymentSession;
    try {
      session = normalizePaymentSessionInitialization(
        JSON.parse(row.session_json) as unknown,
        Math.min(Date.now(), row.expires_at_ms - 1),
      );
      if (session.nip57 === undefined) {
        throw new TypeError("This payment session does not accept receipts.");
      }
      const request = parseAndValidateZapRequest(session.nip57.requestJson, {
        expectedProviderPubkey: session.nip57.providerPubkey,
      });
      validateZapReceipt(event, {
        request,
        providerPubkey: session.nip57.providerPubkey,
        expectedInvoice: session.invoice,
        expectedPaymentHash: session.nip57.expectedPaymentHash,
      });
    } catch {
      send(ws, [
        "OK",
        event.id,
        false,
        "invalid: receipt does not match this payment",
      ]);
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE channel_state SET receipt_json = ?, receipt_id = ?
       WHERE singleton = 1 AND receipt_json IS NULL`,
      JSON.stringify(event),
      event.id,
    );
    send(ws, ["OK", event.id, true, ""]);
    this.publishToSubscriptions(event);
  }

  private handleRequest(ws: WebSocket, message: readonly unknown[]): void {
    if (
      message.length < 3 ||
      message.length > MAX_FILTERS_PER_SUBSCRIPTION + 2 ||
      typeof message[1] !== "string" ||
      message[1].length === 0 ||
      byteLength(message[1]) > MAX_SUBSCRIPTION_ID_BYTES
    ) {
      send(ws, ["NOTICE", "invalid: malformed REQ"]);
      return;
    }
    const subscriptionId = message[1];
    const filters = message.slice(2).map(normalizeFilter);
    if (filters.some((filter) => filter === null)) {
      send(ws, ["NOTICE", "invalid: unsupported REQ filter"]);
      return;
    }

    const state = normalizeSocketState(ws.deserializeAttachment());
    const subscriptions = { ...state.subscriptions };
    if (
      subscriptions[subscriptionId] === undefined &&
      Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION
    ) {
      send(ws, ["NOTICE", "restricted: subscription limit reached"]);
      return;
    }
    subscriptions[subscriptionId] = filters as ReceiptFilter[];
    ws.serializeAttachment({ ...state, subscriptions } satisfies SocketState);

    const receipt = this.currentReceipt();
    if (
      receipt !== null &&
      filters.some(
        (filter) => filter !== null && matchesReceiptFilter(receipt, filter),
      )
    ) {
      send(ws, ["EVENT", subscriptionId, receipt]);
    }
    send(ws, ["EOSE", subscriptionId]);
  }

  private handleClose(ws: WebSocket, message: readonly unknown[]): void {
    if (
      message.length !== 2 ||
      typeof message[1] !== "string" ||
      byteLength(message[1]) > MAX_SUBSCRIPTION_ID_BYTES
    ) {
      send(ws, ["NOTICE", "invalid: malformed CLOSE"]);
      return;
    }
    const state = normalizeSocketState(ws.deserializeAttachment());
    const subscriptions = { ...state.subscriptions };
    delete subscriptions[message[1]];
    ws.serializeAttachment({ ...state, subscriptions } satisfies SocketState);
  }

  override async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    if ((await this.activeRow()) === null) {
      send(ws, ["NOTICE", "expired: payment session expired"]);
      ws.close(1000, "payment session expired");
      return;
    }
    if (typeof raw !== "string" || byteLength(raw) > MAX_RECEIPT_BYTES) {
      send(ws, ["NOTICE", "invalid: text message required"]);
      ws.close(1009, "invalid relay message");
      return;
    }

    const previousState = normalizeSocketState(ws.deserializeAttachment());
    const messageCount = previousState.messageCount + 1;
    if (messageCount > MAX_MESSAGES_PER_CONNECTION) {
      send(ws, ["NOTICE", "rate-limited: message limit reached"]);
      ws.close(1008, "message limit reached");
      return;
    }
    ws.serializeAttachment({
      ...previousState,
      messageCount,
    } satisfies SocketState);

    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      send(ws, ["NOTICE", "invalid: malformed JSON"]);
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      send(ws, ["NOTICE", "invalid: malformed relay message"]);
      return;
    }

    switch (message[0]) {
      case "EVENT":
        this.handleEvent(ws, message);
        return;
      case "REQ":
        this.handleRequest(ws, message);
        return;
      case "CLOSE":
        this.handleClose(ws, message);
        return;
      default:
        send(ws, ["NOTICE", "unsupported: relay command"]);
    }
  }

  override webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    void _wasClean;
    try {
      ws.close(code, reason);
    } catch {
      // Current compatibility dates automatically reciprocate close frames.
    }
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    void _error;
    try {
      ws.close(1011, "relay error");
    } catch {
      // The runtime can report the error after the socket has closed.
    }
  }

  override async alarm(): Promise<void> {
    const row = this.row();
    if (row !== null && row.expires_at_ms > Date.now()) {
      await this.ctx.storage.setAlarm(row.expires_at_ms);
      return;
    }
    await this.expire();
  }
}
