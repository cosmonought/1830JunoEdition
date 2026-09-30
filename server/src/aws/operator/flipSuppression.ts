// server/src/aws/operator/flipSuppression.ts
//
// ==================================================================
//  LIVE-6 L6-5B: THE FLIP WINDOW'S SUPPRESSOR DATAPOINTS -- CLOUDWATCH PutMetricData, OPERATOR NAMESPACE ONLY
// ==================================================================
//
// The production `FlipSuppressionPort` (`controlPlane/flipSuppression.ts` computes WHAT is published and why it is
// bounded). One request per batch of datums, into `18Cosmos/Operator` and nowhere else (the operator role's IAM allows
// only that namespace; the port refuses any other before sending). The client is `awsClients.ts`'s (retries off, bounded,
// throwing timeouts); every call carries `deadline()`. Nothing here reads, sets, enables or disables an alarm.

import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";

import { deadline } from "../awsClients";
import { FLIP_SUPPRESSION, type FlipSuppressionPort } from "../controlPlane/flipSuppression";

export function cloudWatchSuppression(client: CloudWatchClient): FlipSuppressionPort {
  return {
    async publish(namespace, datums) {
      if (namespace !== FLIP_SUPPRESSION.namespace) throw new Error(`refusing to publish into ${namespace}: the flip window writes only ${FLIP_SUPPRESSION.namespace}`);
      if (datums.length === 0) return;
      await client.send(
        new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: datums.map((d) => ({ MetricName: d.MetricName, Dimensions: d.Dimensions.map((x) => ({ Name: x.Name, Value: x.Value })), Timestamp: new Date(d.Timestamp), Value: d.Value, Unit: d.Unit })),
        }),
        { abortSignal: deadline() },
      );
    },
  };
}
