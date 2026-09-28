// Fixture: EMSC standing_order websocket message shapes (recorded live 2026-09-28).
// Use in the websocket-poller test to decode messages without hitting the network.
// action: "create" (new event) | "update" (revision) | "delete".
export const WS_CREATE = {
  action: "create",
  data: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [18.6576, -69.0627, -7.0] },
    id: "20260928_0000230",
    properties: {
      source_id: "1779128",
      source_catalog: "EMSC-RTS",
      lastupdate: "2026-09-28T17:07:46.000000Z",
      time: "2026-09-28T17:07:46.0Z",
      flynn_region: "PUERTO RICO",
      lat: 18.6576,
      lon: -69.0627,
      depth: -7.0,
      evtype: "ke",
      auth: "RSNC",
      mag: 2.0,
      magtype: "md",
      unid: "20260928_0000230",
    },
  },
}

export const WS_UPDATE = {
  action: "update",
  data: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-14.5, 19.0, 31.0] },
    id: "20260927_0000262",
    properties: {
      source_id: "17791af27d",
      source_catalog: "EMSC-RTS",
      lastupdate: "2026-09-28T17:12:00.000000Z",
      time: "2026-09-27T00:34:42.97Z",
      flynn_region: "ISLAND OF HAWAII, HAWAII",
      lat: 19.0,
      lon: -14.5,
      depth: 31.3,
      evtype: "ke",
      auth: "GEOFON",
      mag: 2.3,
      magtype: "ml",
      unid: "20260927_0000262",
    },
  },
}

export const WS_DELETE = {
  action: "delete",
  data: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0, 0] },
    id: "20260928_0000220",
    properties: { unid: "20260928_0000220" },
  },
}