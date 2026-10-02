// server/src/aws/deploy/migration/natEvidence.ts
//
// ==================================================================
//  COST-2B: THE NAT GATEWAY IS OUTSIDE TERRAFORM -- ITS DELETION NEEDS PROOF THAT NOTHING ELSE USES IT
// ==================================================================
//
// The ECS tasks reached the internet through a NAT gateway this repository never created (the LIVE-5 network was an
// EXISTING VPC). After the teardown (SINGLE_HOST_MIGRATION.md step 20) it costs ~$33/month for nothing -- IF nothing else
// routes through it. Deleting a NAT another workload uses cuts that workload off the internet, and no plan shows it.
// So deletion is NEVER treated as automatically safe: `infra/aws/scripts/capture-nat-evidence` captures read-only AWS
// answers, and this judge must say PASS before the owner's GO for the manual deletion (step 23). Every check FAILS
// CLOSED: a missing or unreadable file, an unexpected shape, a datapoint gap -- each is a FAIL, never "probably fine".
//
//   N1 identified   exactly the named NAT, `available`, in the named VPC
//   N2 routing      every route table of the VPC that routes to this NAT, and the subnets those tables serve (the MAIN
//                   table serves every subnet without an explicit association)
//   N3 no workload  NO network interface in those subnets -- no ECS task, no endpoint, no Lambda, no instance, no
//                   Transit Gateway attachment, no load balancer, nothing (after the teardown there must be none)
//   N4 no attachment no Transit Gateway / VPC peering / VPN route in a table that routes to the NAT (another network's
//                   traffic may enter through those and leave through the NAT)
//   N5 quiet        the NAT's own CloudWatch metrics, from the teardown until the capture, cover >= `minQuietHours`
//                   (default 24) hourly datapoints with zero connections and zero bytes in both directions
//   N6 the capture  one environment, region, NAT and VPC across every file; captured after the window ended
//
// PASS is evidence, not permission: the owner still decides, and the ECS-era inventory (step 24) must be clean first.

import type { Check } from "../deployVerify";

type Json = unknown;
type Obj = Record<string, Json>;
const obj = (value: Json): Obj => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : null);

export const NAT_EVIDENCE_FORMAT = "18COSMOS/COST-2B-NAT-EVIDENCE/v1";
export const NAT_FILES = Object.freeze({
  capture: "capture.json",
  natGateways: "nat-gateways.json",
  routeTables: "route-tables.json",
  subnets: "subnets.json",
  networkInterfaces: "network-interfaces.json",
  activeConnections: "nat-metric-active-connections.json",
  bytesOut: "nat-metric-bytes-out.json",
  bytesIn: "nat-metric-bytes-in.json",
});
export type NatFileKey = keyof typeof NAT_FILES;
/** Each file's parsed JSON, or undefined when it is missing / unreadable. */
export type NatEvidence = Readonly<Record<NatFileKey, Json | undefined>>;

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });

const HOUR = 3600 * 1000;

export function judgeNatEvidence(e: NatEvidence, opts: { readonly minQuietHours?: number } = {}): { readonly verdict: "PASS" | "FAIL"; readonly checks: readonly Check[] } {
  const checks: Check[] = [];
  const minHours = opts.minQuietHours ?? 24;
  const missing = (Object.keys(NAT_FILES) as NatFileKey[]).filter((k) => e[k] === undefined);
  if (missing.length > 0) {
    checks.push(fail("N6 the capture is complete", `missing or unreadable: ${missing.map((k) => NAT_FILES[k]).join(", ")}`));
    return { verdict: "FAIL", checks };
  }
  /* A truncated listing (a NextToken left: --no-paginate or --max-items) proves nothing about what it left out. */
  const truncated = (["natGateways", "routeTables", "subnets", "networkInterfaces", "activeConnections", "bytesOut", "bytesIn"] as NatFileKey[]).filter((k) => obj(e[k]).NextToken !== undefined);
  if (truncated.length > 0) {
    checks.push(fail("N6 the capture is complete", `truncated listing(s) (NextToken present): ${truncated.map((k) => NAT_FILES[k]).join(", ")} -- capture again without --no-paginate / --max-items`));
    return { verdict: "FAIL", checks };
  }
  const cap = obj(e.capture);
  const natId = str(cap.nat_gateway_id) ?? "";
  const vpcId = str(cap.vpc_id) ?? "";
  const start = Date.parse(String(cap.metrics_start));
  const end = Date.parse(String(cap.metrics_end));
  const teardown = Date.parse(String(cap.teardown_applied_at));
  const captured = Date.parse(String(cap.captured_at));
  const capOk = cap.format === NAT_EVIDENCE_FORMAT && /^nat-[0-9a-f]{8,17}$/.test(natId) && /^vpc-[0-9a-f]{8,17}$/.test(vpcId) && [start, end, teardown, captured].every(Number.isFinite) && start >= teardown && end > start && captured >= end;
  checks.push(
    capOk
      ? pass("N6 the capture is complete", `${natId} in ${vpcId}; window ${String(cap.metrics_start)} .. ${String(cap.metrics_end)} (teardown ${String(cap.teardown_applied_at)})`)
      : fail("N6 the capture is complete", `capture.json: format ${String(cap.format)}, NAT ${natId || "?"}, VPC ${vpcId || "?"}, the metrics window must start at or after the teardown and end before the capture`),
  );

  /* N1 */
  const nats = arr(obj(e.natGateways).NatGateways).map(obj);
  const nat = nats.find((n) => n.NatGatewayId === natId);
  const natEnis = new Set(arr(nat?.NatGatewayAddresses).map((a) => str(obj(a).NetworkInterfaceId)).filter((x): x is string => x !== null));
  checks.push(
    nats.length === 1 && nat !== undefined && nat.State === "available" && nat.VpcId === vpcId
      ? pass("N1 the NAT is identified", `${natId}: available, ${vpcId}, subnet ${String(nat.SubnetId)}, ENI ${[...natEnis].join(",")}`)
      : fail("N1 the NAT is identified", `${nats.length} NAT gateway(s) in the capture; ${nat === undefined ? `${natId} absent` : `state ${String(nat.State)}, VPC ${String(nat.VpcId)}`}`),
  );

  /* N2 */
  const tables = arr(obj(e.routeTables).RouteTables).map(obj);
  const subnets = arr(obj(e.subnets).Subnets).map(obj);
  const foreignTables = tables.filter((t) => t.VpcId !== vpcId).length + subnets.filter((s) => s.VpcId !== vpcId).length;
  const viaNat = tables.filter((t) => arr(t.Routes).some((r) => obj(r).NatGatewayId === natId));
  const explicit = new Set<string>();
  for (const t of tables) for (const a of arr(t.Associations).map(obj)) if (typeof a.SubnetId === "string") explicit.add(a.SubnetId);
  const routed = new Set<string>();
  let mainViaNat = false;
  for (const t of viaNat) {
    for (const a of arr(t.Associations).map(obj)) {
      if (typeof a.SubnetId === "string") routed.add(a.SubnetId);
      if (a.Main === true) mainViaNat = true;
    }
  }
  if (mainViaNat) for (const s of subnets) if (typeof s.SubnetId === "string" && !explicit.has(s.SubnetId)) routed.add(s.SubnetId);
  /* Every subnet an association or an interface names must be in the subnet listing (else the MAIN table's implicit set is
     unknowable), and every interface must name its subnet. */
  const listed = new Set(subnets.map((x) => String(x.SubnetId)));
  const unlisted = [...explicit].filter((x) => !listed.has(x));
  checks.push(
    foreignTables === 0 && tables.length > 0 && subnets.length > 0 && unlisted.length === 0
      ? pass("N2 the subnets routed through the NAT", `${viaNat.length} route table(s) (${viaNat.map((t) => String(t.RouteTableId)).join(", ") || "none"}) serve ${routed.size} subnet(s): ${[...routed].sort().join(", ") || "none"}${mainViaNat ? " (including the MAIN table's implicit subnets)" : ""}`)
      : fail("N2 the subnets routed through the NAT", tables.length === 0 || subnets.length === 0 ? "no route table or subnet captured (the capture must list the whole VPC)" : unlisted.length > 0 ? `associated subnet(s) missing from subnets.json: ${unlisted.join(", ")}` : `${foreignTables} route table(s) / subnet(s) of another VPC in the capture`),
  );

  /* N3 */
  const enis = arr(obj(e.networkInterfaces).NetworkInterfaces).map(obj);
  const foreignEnis = enis.filter((n) => n.VpcId !== undefined && n.VpcId !== vpcId);
  const users = enis.filter((n) => !natEnis.has(String(n.NetworkInterfaceId)) && (typeof n.SubnetId !== "string" || !listed.has(n.SubnetId) || routed.has(n.SubnetId)));
  checks.push(
    foreignEnis.length === 0 && users.length === 0
      ? pass("N3 no workload behind the NAT", `${enis.length} network interface(s) in the VPC; none in a subnet routed through ${natId}`)
      : fail(
          "N3 no workload behind the NAT",
          foreignEnis.length > 0
            ? `${foreignEnis.length} interface(s) of another VPC in the capture`
            : `${users.length} interface(s) still behind the NAT: ${users
                .slice(0, 6)
                .map((n) => `${String(n.NetworkInterfaceId)} (${String(n.InterfaceType ?? "interface")}, ${String(n.Description ?? "")}${n.RequesterId !== undefined ? `, requester ${String(n.RequesterId)}` : ""})`)
                .join("; ")} -- something else may depend on this NAT: DO NOT DELETE`,
        ),
  );

  /* N4 */
  const crossing = viaNat.flatMap((t) =>
    arr(t.Routes)
      .map(obj)
      .filter((r) => r.TransitGatewayId !== undefined || r.VpcPeeringConnectionId !== undefined || r.CoreNetworkArn !== undefined || (typeof r.GatewayId === "string" && /^vgw-/.test(r.GatewayId)))
      .map((r) => `${String(t.RouteTableId)} -> ${String(r.TransitGatewayId ?? r.VpcPeeringConnectionId ?? r.CoreNetworkArn ?? r.GatewayId)}`),
  );
  checks.push(crossing.length === 0 ? pass("N4 no other network attached", "no Transit Gateway, peering, Cloud WAN or VPN route in a table that routes to the NAT") : fail("N4 no other network attached", `${crossing.join("; ")} -- another network's traffic may leave through this NAT: DO NOT DELETE`));

  /* N5 */
  const series: Array<[string, NatFileKey, string]> = [
    ["ActiveConnectionCount", "activeConnections", "Maximum"],
    ["BytesOutToDestination", "bytesOut", "Sum"],
    ["BytesInFromSource", "bytesIn", "Sum"],
  ];
  const quietProblems: string[] = [];
  const windowHours = Number.isFinite(end - start) ? Math.floor((end - start) / HOUR) : 0;
  if (windowHours < minHours) quietProblems.push(`the window is ${windowHours} h (>= ${minHours} h after the teardown required)`);
  for (const [metric, key, stat] of series) {
    const m = obj(e[key]);
    const points = arr(m.Datapoints).map(obj);
    if (m.Label !== metric) quietProblems.push(`${NAT_FILES[key]} is not ${metric} (label ${String(m.Label)})`);
    const inWindow = points.filter((p) => {
      const t = Date.parse(String(p.Timestamp));
      return Number.isFinite(t) && t >= start && t < end;
    });
    /* Exactly one datapoint per whole hour of the window, on the hour grid from the start: a count alone would accept 24
       points in one hour, or five-minute points covering two. */
    const hoursSeen = new Set(inWindow.map((p) => Date.parse(String(p.Timestamp))));
    const grid = Array.from({ length: windowHours }, (_, k) => start + k * HOUR);
    const onGrid = grid.every((t) => hoursSeen.has(t)) && hoursSeen.size === grid.length && inWindow.length === grid.length;
    if (windowHours < minHours || !onGrid || inWindow.length < points.length) quietProblems.push(`${metric}: ${hoursSeen.size} distinct hourly datapoint(s) for the ${windowHours} whole hours of the window, ${inWindow.length} in all (one per hour on the hour grid required; a gap proves nothing)`);
    const busy = inWindow.filter((p) => typeof p[stat] !== "number" || p[stat] !== 0);
    if (busy.length > 0) quietProblems.push(`${metric}: ${busy.length} hour(s) not zero (first ${String(busy[0].Timestamp)}: ${String(busy[0][stat])})`);
  }
  checks.push(quietProblems.length === 0 ? pass("N5 the NAT is quiet", `${windowHours} h since the teardown: zero connections, zero bytes either way`) : fail("N5 the NAT is quiet", quietProblems.join("; ")));

  return { verdict: checks.every((c) => c.status === "pass") ? "PASS" : "FAIL", checks };
}
