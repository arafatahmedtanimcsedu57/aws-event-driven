import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// The read model: one row per order, streamed to keep AppSync subscribers live.
export function createOrdersStore(scope: Construct): dynamodb.Table {
  return new dynamodb.Table(scope, 'OrdersProjection', {
    partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    stream: dynamodb.StreamViewType.NEW_IMAGE,
  });
}
