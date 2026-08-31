/**
 * Deriv API integration layer.
 *
 * Every function here is currently a SIMULATED placeholder — the app runs
 * entirely on fake data until these are filled in with real calls to
 * Deriv's WebSocket API (wss://ws.derivws.com/websockets/v3?app_id=...).
 *
 * This file is the ONLY place that should need to change when we go live.
 * The UI calls these functions and doesn't care whether the data is real
 * or simulated.
 *
 * Docs: https://developers.deriv.com/docs/websockets
 */

const APP_ID = import.meta.env.VITE_DERIV_APP_ID || "1089"; // 1089 = Deriv's public demo app_id
const API_TOKEN = import.meta.env.VITE_DERIV_API_TOKEN || "";

let socket = null;
let reqId = 1;
const pending = new Map();
const tickSubscribers = new Map(); // symbol -> Set(callback)

export const isLiveConfigured = () => Boolean(API_TOKEN);

/**
 * Opens the WebSocket connection and authorizes with the API token.
 * Call this once, early in the app's life, before using anything else.
 */
export function connect() {
  return new Promise((resolve, reject) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    socket.onopen = async () => {
      try {
        if (API_TOKEN) {
          await send({ authorize: API_TOKEN });
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    socket.onerror = (err) => reject(err);

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Route tick stream updates to subscribers
      if (data.msg_type === "tick" && data.tick) {
        const subs = tickSubscribers.get(data.tick.symbol);
        if (subs) subs.forEach((cb) => cb(data.tick));
        return;
      }

      // Route request/response pairs back to their caller
      if (data.req_id && pending.has(data.req_id)) {
        const { resolve: res, reject: rej } = pending.get(data.req_id);
        pending.delete(data.req_id);
        if (data.error) rej(data.error);
        else res(data);
      }
    };

    socket.onclose = () => {
      socket = null;
    };
  });
}

function send(payload) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Not connected to Deriv"));
      return;
    }
    const id = reqId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

/**
 * Subscribe to live ticks for a symbol (e.g. "R_10", "R_75", "1HZ75V").
 * Returns an unsubscribe function.
 */
export async function subscribeToTicks(symbol, onTick) {
  if (!tickSubscribers.has(symbol)) tickSubscribers.set(symbol, new Set());
  tickSubscribers.get(symbol).add(onTick);

  await send({ ticks: symbol, subscribe: 1 });

  return () => {
    tickSubscribers.get(symbol)?.delete(onTick);
  };
}

/** Fetch the current account balance. Requires authorize() to have run. */
export async function getBalance() {
  const res = await send({ balance: 1, subscribe: 0 });
  return res.balance; // { balance, currency, ... }
}

/**
 * Get a price quote for a proposed contract before buying.
 * type: "CALL" | "PUT" | "DIGITMATCH" | "DIGITDIFF" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD"
 */
export async function getProposal({ symbol, type, stake, duration, durationUnit = "t", barrier }) {
  const payload = {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: type,
    currency: "USD",
    duration,
    duration_unit: durationUnit,
    symbol,
  };
  if (barrier !== undefined) payload.barrier = String(barrier);
  const res = await send(payload);
  return res.proposal; // { id, ask_price, payout, ... }
}

/** Buy a contract from a proposal id (returned by getProposal). */
export async function buyContract(proposalId, price) {
  const res = await send({ buy: proposalId, price });
  return res.buy; // { contract_id, buy_price, payout, ... }
}

/** Fetch recent closed trades for the History tab. */
export async function getProfitTable(limit = 30) {
  const res = await send({ profit_table: 1, limit, description: 1 });
  return res.profit_table?.transactions || [];
}

export function disconnect() {
  if (socket) socket.close();
  socket = null;
}
