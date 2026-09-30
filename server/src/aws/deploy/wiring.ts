// server/src/aws/deploy/wiring.ts
//
// LIVE-5 L5-8: the production ports of the deploy tool, from the runtime's own implementations (so the tool reads SSM
// and KMS exactly as a task does). `tools/awsDeploy.ts` reaches the runtime and the KMS binding only through here: the
// import boundary (`awsClients.test.ts`) lets `aws/deploy/` -- and nothing else outside the runtime -- compose them.

import type { KMSClient } from "@aws-sdk/client-kms";

import type { KmsClient } from "../../escrow/juno/signer";
import { kmsDigestClient } from "../kms/kmsDigestClient";
import { ssmParameterSource, type ParameterSource } from "../runtime/configSource";

/** SSM `String` parameters by ARN, each read through a client for the ARN's own region (the task's `ParameterSource`). */
export const ssmParameterSourceFor = (): ParameterSource => ssmParameterSource();

/** The KMS digest client the task uses (key ARNs in `region` only; the spec, usage and algorithm checked on every answer). */
export const kmsDigestClientFor = (client: KMSClient, region: string): KmsClient => kmsDigestClient(client, { region });
