/* THROWAWAY CAPTURE FIXTURE (cloud scratch only -- never shipped, never in the repo).
   Twenty-four public rooms, built through the room model's own `summariseSandboxRoom` shape so the page reads
   exactly what the server's `rooms` frame carries: code, status, hostNickname, players[], seatCap,
   playerCount, variants, anteUjuno, createdAtMs. Deterministic: no clock, no randomness. */
export const FIXTURE_JS = `(function () {
  var STANDARD = {
    length: "standard", mode: "live", delayedAuction: false, gentleRust: false,
    unpredictableRevenue: false, dynamicStockMarket: false, expandedMap: false,
    plusTiles: false, levelPlayingField: false, rules: 0
  };
  var NAMES = ["Bram","Ines","Kolya","Marisol","Teodor","Wen","Ada","Oisin","Rune","Halla","Cato","Nuri",
               "Sable","Joaquin","Mira","Dev","Esben","Liv","Ozan","Pia","Ruth","Sol","Tamas","Yara"];
  function seats(n, readyCount) {
    var out = [];
    for (var i = 0; i < n; i += 1) out.push({ id: "p" + i, nickname: NAMES[(i * 5 + n) % NAMES.length], isReady: i < readyCount });
    return out;
  }
  function room(spec) {
    var variants = Object.assign({}, STANDARD, spec.variants || {});
    var boardMax = variants.levelPlayingField ? 7 : variants.expandedMap ? 6 : 6;
    var cap = spec.playerCount != null ? Math.min(spec.playerCount, boardMax) : boardMax;
    return {
      code: spec.code,
      status: spec.status || "waiting",
      hostNickname: spec.host,
      players: seats(spec.seated, spec.ready == null ? Math.max(0, spec.seated - 1) : spec.ready),
      seatCap: cap,
      playerCount: spec.playerCount == null ? null : spec.playerCount,
      variants: variants,
      anteUjuno: spec.ante || "0",
      createdAtMs: spec.at
    };
  }
  var ROOMS = [
    room({ code: "JUNO-4T2", host: "Bram",     seated: 4, at: 2400 }),
    room({ code: "JUNO-9KP", host: "Ines",     seated: 2, at: 2380, variants: { delayedAuction: true } }),
    room({ code: "JUNO-C7V", host: "Kolya",    seated: 5, at: 2360, playerCount: 6, variants: { expandedMap: true, plusTiles: true } }),
    room({ code: "JUNO-QX8", host: "Marisol",  seated: 3, at: 2340, variants: { mode: "async", length: "long" } }),
    room({ code: "JUNO-2HD", host: "Teodor",   seated: 6, at: 2320 }),
    room({ code: "JUNO-LM5", host: "Wen",      seated: 1, at: 2300, variants: { gentleRust: true, dynamicStockMarket: true } }),
    room({ code: "JUNO-B3F", host: "Ada",      seated: 3, at: 2280, playerCount: 4, variants: { expandedMap: true, levelPlayingField: true, plusTiles: true, length: "long" } }),
    room({ code: "JUNO-7YN", host: "Oisin",    seated: 2, at: 2260, variants: { mode: "async" } }),
    room({ code: "JUNO-TR6", host: "Rune",     seated: 4, at: 2240, variants: { unpredictableRevenue: true } }),
    room({ code: "JUNO-V1Z", host: "Halla",    seated: 2, at: 2220, playerCount: 3, variants: { length: "short" } }),
    room({ code: "JUNO-8QW", host: "Cato",     seated: 5, at: 2200, variants: { expandedMap: true } }),
    room({ code: "JUNO-KD9", host: "Nuri",     seated: 1, at: 2180, variants: { mode: "async", delayedAuction: true, gentleRust: true } }),
    room({ code: "JUNO-3PS", host: "Sable",    seated: 4, at: 2160, playerCount: 4 }),
    room({ code: "JUNO-XJ4", host: "Joaquin",  seated: 2, at: 2140, variants: { expandedMap: true, plusTiles: true, dynamicStockMarket: true } }),
    room({ code: "JUNO-6WB", host: "Mira",     seated: 3, at: 2120, variants: { mode: "async", length: "long", unpredictableRevenue: true } }),
    room({ code: "JUNO-ZF7", host: "Dev",      seated: 7, at: 2100, variants: { expandedMap: true, levelPlayingField: true, plusTiles: true, length: "long" } }),

    room({ code: "JUNO-N5C", host: "Esben",   status: "playing", seated: 4, at: 2080 }),
    room({ code: "JUNO-G2R", host: "Liv",     status: "playing", seated: 5, at: 2060, variants: { expandedMap: true, plusTiles: true } }),
    room({ code: "JUNO-A8L", host: "Ozan",    status: "playing", seated: 3, at: 2040, variants: { mode: "async", length: "long", delayedAuction: true } }),
    room({ code: "JUNO-P4M", host: "Pia",     status: "playing", seated: 6, at: 2020, variants: { gentleRust: true } }),
    room({ code: "JUNO-H9T", host: "Ruth",    status: "playing", seated: 2, at: 2000, playerCount: 2, variants: { length: "short" } }),
    room({ code: "JUNO-Y6D", host: "Sol",     status: "playing", seated: 4, at: 1980, variants: { mode: "async", dynamicStockMarket: true, unpredictableRevenue: true } }),
    room({ code: "JUNO-W3K", host: "Tamas",   status: "playing", seated: 7, at: 1960, variants: { expandedMap: true, levelPlayingField: true, plusTiles: true, length: "long" } }),
    room({ code: "JUNO-E1B", host: "Yara",    status: "playing", seated: 3, at: 1940, variants: { expandedMap: true, mode: "async" } })
  ];
  window.__HARNESS_ROOMS__ = { state: "ready", rooms: ROOMS };
  window.__HARNESS_ROOM_STATES__ = {
    ready: { state: "ready", rooms: ROOMS },
    empty: { state: "ready", rooms: [] },
    loading: { state: "loading" },
    error: { state: "error", message: "[server] Could not load the game list: the connection was lost." }
  };
})();`;
