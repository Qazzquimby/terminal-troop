import { z } from "zod";
import type { CandidateType, PeerDiagnostics } from "../../voice/index.js";

const Transport = z.object({
  type: z.literal("transport"),
  selectedCandidatePairId: z.string(),
});

const CandidatePair = z.object({
  type: z.literal("candidate-pair"),
  localCandidateId: z.string(),
  remoteCandidateId: z.string(),
  state: z.string().optional(),
  nominated: z.boolean().optional(),
  /** Firefox marks the pair in use on the pair itself. */
  selected: z.boolean().optional(),
});

const Candidate = z.object({
  type: z.enum(["local-candidate", "remote-candidate"]),
  candidateType: z.enum(["host", "srflx", "prflx", "relay"]),
});

const InboundAudio = z.object({
  type: z.literal("inbound-rtp"),
  kind: z.literal("audio"),
  bytesReceived: z.number(),
});

/** What a connection's statistics say about its route and the audio it received. */
export interface ConnectionStats {
  route: PeerDiagnostics["route"];
  bytesReceived: number;
}

type CandidatePair = z.infer<typeof CandidatePair>;

/**
 * The pair in use: the one the transport names, or failing that one marked selected, or a
 * nominated pair that succeeded.
 */
function selectedPair(report: ReadonlyMap<string, unknown>) {
  const pairs: CandidatePair[] = [];
  let namedId: string | null = null;
  for (const stat of report.values()) {
    const transport = Transport.safeParse(stat);
    if (transport.success) namedId = transport.data.selectedCandidatePairId;
    const pair = CandidatePair.safeParse(stat);
    if (pair.success) pairs.push(pair.data);
  }
  const named = namedId === null ? undefined : report.get(namedId);
  const parsed = CandidatePair.safeParse(named);
  if (parsed.success) return parsed.data;
  return (
    pairs.find((pair) => pair.selected === true) ??
    pairs.find((pair) => pair.nominated === true && pair.state === "succeeded")
  );
}

function candidateType(
  report: ReadonlyMap<string, unknown>,
  id: string,
): CandidateType | null {
  const parsed = Candidate.safeParse(report.get(id));
  return parsed.success ? parsed.data.candidateType : null;
}

/** Reads the route and received audio bytes out of an `RTCPeerConnection.getStats()` report. */
export function connectionStats(
  report: ReadonlyMap<string, unknown>,
): ConnectionStats {
  let bytesReceived = 0;
  for (const stat of report.values()) {
    const inbound = InboundAudio.safeParse(stat);
    if (inbound.success) bytesReceived += inbound.data.bytesReceived;
  }
  const pair = selectedPair(report);
  if (pair === undefined) return { route: null, bytesReceived };
  const local = candidateType(report, pair.localCandidateId);
  const remote = candidateType(report, pair.remoteCandidateId);
  return {
    route: local === null || remote === null ? null : { local, remote },
    bytesReceived,
  };
}
