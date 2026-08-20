import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface EventBusResources {
  projectionConsumerFn: lambda.Function;
  consumerDlq: sqs.Queue;
}

// Domain-event ingestion: default EventBridge bus -> projection consumer, with a
// DLQ so failed deliveries are parked instead of dropped.
export function createEventBus(scope: Construct, table: dynamodb.Table): EventBusResources {
  const consumerDlq = new sqs.Queue(scope, 'ProjectionConsumerDLQ');

  const bus = events.EventBus.fromEventBusName(scope, 'DefaultBus', 'default');

  const projectionConsumerFn = new lambda.Function(scope, 'ProjectionConsumerFn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'projection-consumer/index.handler',
    code: lambda.Code.fromAsset('lambda'),
    environment: { TABLE_NAME: table.tableName },
    tracing: lambda.Tracing.ACTIVE,
  });
  table.grantWriteData(projectionConsumerFn);   // it WRITES the projection (least-privilege)

  new events.Rule(scope, 'OrderEventsRule', {
    eventBus: bus,
    eventPattern: {
      source: ['bff.orders'],                    // events from our "orders domain"
      detailType: ['OrderPlaced', 'OrderUpdated'],
    },
    targets: [
      new targets.LambdaFunction(projectionConsumerFn, {
        deadLetterQueue: consumerDlq,   // failed events land here instead of vanishing
        retryAttempts: 3,
      }),
    ],
  });

  return { projectionConsumerFn, consumerDlq };
}
