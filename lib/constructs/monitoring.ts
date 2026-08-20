import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface MonitoringProps {
  table: dynamodb.Table;
  api: apigateway.LambdaRestApi;
  getOrdersFn: lambda.Function;
  streamFn: lambda.Function;
  notifyEmail: string;
}

// SNS alarm topic + error/5xx alarms, plus a CloudWatch dashboard for the whole system.
export function createMonitoring(scope: Construct, props: MonitoringProps): void {
  const { table, api, getOrdersFn, streamFn, notifyEmail } = props;

  const alarmTopic = new sns.Topic(scope, 'BffAlarmTopic', {
    displayName: 'BFF Live Alarms',
  });
  alarmTopic.addSubscription(new subscriptions.EmailSubscription(notifyEmail));

  const notify = new cwactions.SnsAction(alarmTopic);

  // Alarm 1 — stream Lambda is erroring (live-update path broken)
  streamFn.metricErrors({ period: cdk.Duration.minutes(1) })
    .createAlarm(scope, 'StreamFnErrorsAlarm', {
      alarmName: 'BFF-StreamHandlerFn-Errors',
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    .addAlarmAction(notify);

  // Alarm 2 — read Lambda is erroring (initial load broken)
  getOrdersFn.metricErrors({ period: cdk.Duration.minutes(1) })
    .createAlarm(scope, 'GetOrdersFnErrorsAlarm', {
      alarmName: 'BFF-GetOrdersFn-Errors',
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    .addAlarmAction(notify);

  // Alarm 3 — API Gateway returning 5xx (server errors reaching users)
  api.metricServerError({ period: cdk.Duration.minutes(1) })
    .createAlarm(scope, 'ApiServerErrorsAlarm', {
      alarmName: 'BFF-Api-5xx',
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    .addAlarmAction(notify);

  const dashboard = new cloudwatch.Dashboard(scope, 'BffDashboard', {
    dashboardName: 'BFF-Live-Health',
  });

  dashboard.addWidgets(
    // Row 1 — invocations and errors for both Lambdas
    new cloudwatch.GraphWidget({
      title: 'Lambda Invocations',
      left: [
        getOrdersFn.metricInvocations({ period: cdk.Duration.minutes(5) }),
        streamFn.metricInvocations({ period: cdk.Duration.minutes(5) }),
      ],
      width: 12,
    }),
    new cloudwatch.GraphWidget({
      title: 'Lambda Errors',
      left: [
        getOrdersFn.metricErrors({ period: cdk.Duration.minutes(5) }),
        streamFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      ],
      width: 12,
    }),
  );

  dashboard.addWidgets(
    // Row 2 — latency (how slow) and API traffic
    new cloudwatch.GraphWidget({
      title: 'Lambda Duration (ms)',
      left: [
        getOrdersFn.metricDuration({ period: cdk.Duration.minutes(5) }),
        streamFn.metricDuration({ period: cdk.Duration.minutes(5) }),
      ],
      width: 12,
    }),
    new cloudwatch.GraphWidget({
      title: 'API Requests & Errors',
      left: [
        api.metricCount({ period: cdk.Duration.minutes(5) }),
        api.metricServerError({ period: cdk.Duration.minutes(5) }),
        api.metricClientError({ period: cdk.Duration.minutes(5) }),
      ],
      width: 12,
    }),
  );

  dashboard.addWidgets(
    // Row 3 — DynamoDB read usage, and a single "current error count" number
    new cloudwatch.GraphWidget({
      title: 'DynamoDB Read Capacity',
      left: [
        table.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5) }),
      ],
      width: 12,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Stream Errors (last 5 min)',
      metrics: [streamFn.metricErrors({ period: cdk.Duration.minutes(5) })],
      width: 12,
    }),
  );
}
