// frontend/src/money/escrowDeployment.ts
//
// ==================================================================
//  ESCROW-4: THE ONE ESCROW THIS BUILD WILL EVER SIGN FOR -- PINNED WHEN THE BUNDLE IS BUILT
// ==================================================================
//
// The server says which escrow a table uses (`RoomView.money.deployment`), and the browser believes none of it for its
// own money actions: before Keplr is asked to sign anything, the table's deployment is compared field by field with the
// deployment pinned into THIS bundle (`REACT_APP_ESCROW_DEPLOYMENT`, a JSON object read at build time). A table that
// names another chain, contract, code checksum or denomination is refused, whatever the server says -- a compromised
// server cannot point a deposit at an escrow this build was not built for.
//
//   REACT_APP_ESCROW_DEPLOYMENT={"backend":"juno-cosmwasm","chainId":"uni-7","networkClass":"testnet",
//     "contract":"juno1...","codeChecksum":"c3bd0618...","denom":"ujunox","symbol":"JUNOX","exponent":6,
//     "rpc":"https://...","rest":"https://...","chainName":"Juno testnet","gasPrice":"0.075","explorerTx":null}
//
// No pin: no money action exists in this build (a table is still playable; its money panel says why nothing can be
// signed here). Mainnet: refused in this phase, whatever the pin says (the server refuses mainnet tables too; KMS is
// not wired until LIVE-5). This is a DEPLOYMENT pin (which contract), never a build-identity comparison.

import { DEPLOYMENT_FIELDS, type MoneyDeploymentView, type MoneyNetworkClass } from "../utils/moneyProtocol";

export interface PinnedEscrowDeployment extends MoneyDeploymentView {
  /** The chain's Tendermint RPC: the browser reads the chain and broadcasts through it (https; http only on `local`). */
  readonly rpc: string;
  /** The chain's REST (LCD) endpoint, for Keplr's chain suggestion. */
  readonly rest: string;
  /** What the network is called on screen ("Juno testnet"). */
  readonly chainName: string;
  /** The gas price in `denom`, a decimal string ("0.075"): what Keplr is asked to pay the network per unit of gas. */
  readonly gasPrice: string;
  /** A block explorer's transaction URL with `{hash}`, or null. */
  readonly explorerTx: string | null;
}

export type PinnedDeploymentResult = { readonly ok: true; readonly pin: PinnedEscrowDeployment } | { readonly ok: false; readonly reason: string };

/** Juno mainnet's chain id. */
const JUNO_MAINNET_CHAIN_ID = "juno-1";
/** Mainnet money is not open in this phase: a build pinned to mainnet signs nothing. */
export const MAINNET_MONEY_OPEN = false;

const KEYS = ["backend", "chainId", "networkClass", "contract", "codeChecksum", "denom", "symbol", "exponent", "rpc", "rest", "chainName", "gasPrice", "explorerTx"];
const NETWORK_CLASSES: readonly MoneyNetworkClass[] = ["mainnet", "testnet", "local"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function endpoint(value: unknown, networkClass: MoneyNetworkClass): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.protocol === "https:") return value.replace(/\/+$/, "");
  if (url.protocol === "http:" && networkClass === "local") return value.replace(/\/+$/, "");
  return null;
}

/** The pin from its JSON text, checked field by field (anything else is refused -- never half-read). */
export function parsePinnedDeployment(raw: string | undefined | null): PinnedDeploymentResult {
  if (raw === undefined || raw === null || raw.trim() === "") return { ok: false, reason: "This build has no Juno escrow configured, so real-money actions can't be signed here." };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "This build's Juno escrow setting isn't readable, so nothing can be signed here." };
  }
  const bad = (field: string): PinnedDeploymentResult => ({ ok: false, reason: `This build's Juno escrow setting has a bad \`${field}\`, so nothing can be signed here.` });
  if (!isObject(value)) return bad("(the object)");
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !KEYS.includes(key));
  if (unknown !== undefined) return bad(unknown);
  const fields: Record<string, unknown> = value;
  const missing = KEYS.find((key) => key !== "explorerTx" && !(key in fields));
  if (missing !== undefined) return bad(missing);
  if (value.backend !== "juno-cosmwasm") return bad("backend");
  if (typeof value.chainId !== "string" || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(value.chainId)) return bad("chainId");
  if (typeof value.networkClass !== "string" || !NETWORK_CLASSES.includes(value.networkClass as MoneyNetworkClass)) return bad("networkClass");
  const networkClass = value.networkClass as MoneyNetworkClass;
  if (typeof value.contract !== "string" || !/^juno1[02-9ac-hj-np-z]{38,90}$/.test(value.contract)) return bad("contract");
  if (typeof value.codeChecksum !== "string" || !/^[0-9a-f]{64}$/.test(value.codeChecksum)) return bad("codeChecksum");
  if (typeof value.denom !== "string" || !/^[a-z][a-z0-9/:._-]{1,127}$/.test(value.denom)) return bad("denom");
  if (typeof value.symbol !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(value.symbol)) return bad("symbol");
  if (value.exponent !== 6) return bad("exponent");
  const rpc = endpoint(value.rpc, networkClass);
  if (rpc === null) return bad("rpc");
  const rest = endpoint(value.rest, networkClass);
  if (rest === null) return bad("rest");
  if (typeof value.chainName !== "string" || !/^[\x20-\x7e]{1,48}$/.test(value.chainName)) return bad("chainName");
  if (typeof value.gasPrice !== "string" || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/.test(value.gasPrice) || (/^0(\.0+)?$/.test(value.gasPrice) && networkClass !== "local")) return bad("gasPrice");
  const explorerTx = value.explorerTx ?? null;
  if (explorerTx !== null && (typeof explorerTx !== "string" || !explorerTx.startsWith("https://") || !explorerTx.includes("{hash}") || explorerTx.length > 256)) return bad("explorerTx");
  /* Juno's mainnet is refused by its chain id too, whatever class the pin claims (review S-L4; the server's
     configuration refuses `juno-1` the same way). */
  if ((networkClass === "mainnet" || value.chainId === JUNO_MAINNET_CHAIN_ID) && !MAINNET_MONEY_OPEN) return { ok: false, reason: "Real-money play on Juno mainnet isn't open yet, so this build signs nothing on mainnet." };
  return {
    ok: true,
    pin: Object.freeze({
      backend: "juno-cosmwasm",
      chainId: value.chainId,
      networkClass,
      contract: value.contract,
      codeChecksum: value.codeChecksum,
      denom: value.denom,
      symbol: value.symbol,
      exponent: 6,
      rpc,
      rest,
      chainName: value.chainName,
      gasPrice: value.gasPrice,
      explorerTx: explorerTx as string | null,
    }),
  };
}

let cached: PinnedDeploymentResult | null = null;

/** This bundle's pinned escrow (read once: CRA substitutes the variable at build time). */
export function pinnedDeployment(): PinnedDeploymentResult {
  if (cached === null) cached = parsePinnedDeployment(process.env.REACT_APP_ESCROW_DEPLOYMENT);
  return cached;
}

/** Tests: forget the cached pin (the next read parses the environment again). */
export function resetPinnedDeploymentForTests(): void {
  cached = null;
}

/** The first field on which a table's deployment differs from the pin, or null when they name the same escrow. */
export function deploymentMismatch(pin: MoneyDeploymentView, view: MoneyDeploymentView): string | null {
  for (const field of DEPLOYMENT_FIELDS) if (pin[field] !== view[field]) return field;
  return null;
}

/** A transaction's explorer link under the pin, or null. */
export function explorerLink(pin: PinnedEscrowDeployment, txHash: string): string | null {
  return pin.explorerTx === null || !/^[0-9A-Fa-f]{64}$/.test(txHash) ? null : pin.explorerTx.replace("{hash}", txHash.toUpperCase());
}
