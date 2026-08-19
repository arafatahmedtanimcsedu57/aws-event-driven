import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class BffLiveStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const consumerDlq = new sqs.Queue(this, 'ProjectionConsumerDLQ');

    const table = new dynamodb.Table(this, 'OrdersProjection', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    const getOrdersFn = new lambda.Function(this, 'GetOrdersFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE_NAME: table.tableName },
      tracing: lambda.Tracing.ACTIVE,
    });
    table.grantReadData(getOrdersFn);

    // User pool declared BEFORE the API so the authorizer can reference it
    const userPool = new cognito.UserPool(this, 'BffUserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'BffUserPoolClient', {
      userPool,
      authFlows: { userSrp: true, userPassword: true },
    });

    // NEW: Cognito authorizer for the REST API
    const apiAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'BffApiAuthorizer', {
      cognitoUserPools: [userPool],
    });

    const api = new apigateway.LambdaRestApi(this, 'BffApi', {
      handler: getOrdersFn,
      proxy: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Authorization', 'Content-Type'],
      },
      defaultMethodOptions: {
        authorizer: apiAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
      deployOptions: {
        stageName: 'orders',
        tracingEnabled: true,
      },
    });

    // ── ADD THIS ──────────────────────────────────────────────
    // The CORS preflight (OPTIONS) can't carry a token, so it must
    // NOT require the Cognito authorizer. Strip auth off every OPTIONS method.
    api.methods.forEach((method) => {
      if (method.httpMethod === 'OPTIONS') {
        const cfn = method.node.defaultChild as apigateway.CfnMethod;
        cfn.authorizationType = apigateway.AuthorizationType.NONE;
        cfn.addPropertyOverride('AuthorizerId', undefined);
      }
    });

    const graph = new appsync.GraphqlApi(this, 'BffGraphApi', {
      name: 'bff-graph-api',
      definition: appsync.Definition.fromFile(
        path.join(__dirname, '..', 'graphql', 'schema.graphql')
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [
          { authorizationType: appsync.AuthorizationType.IAM },
        ],
      },
    });

    const noneDs = graph.addNoneDataSource('NoneDS');
    noneDs.createResolver('PublishResolver', {
      typeName: 'Mutation',
      fieldName: 'publishOrderUpdate',
      requestMappingTemplate: appsync.MappingTemplate.fromString(`{
  "version": "2017-02-28",
  "payload": $util.toJson($context.arguments.order)
}`),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`$util.toJson($context.result)`),
    });

    const streamFn = new lambda.Function(this, 'StreamHandlerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'stream.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { APPSYNC_URL: graph.graphqlUrl },
      tracing: lambda.Tracing.ACTIVE,
    });
    streamFn.addEventSource(new DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 5,
      retryAttempts: 2,
    }));
    graph.grantMutation(streamFn, 'publishOrderUpdate');


        // ── Event-driven ingestion: broker + projection consumer ────────
    // The event bus — our broker. (Using the default bus keeps it simple.)
    const bus = events.EventBus.fromEventBusName(this, 'DefaultBus', 'default');

    // The projection consumer — writes the read model when a domain event arrives
    const projectionConsumerFn = new lambda.Function(this, 'ProjectionConsumerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'consumer.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE_NAME: table.tableName },
      tracing: lambda.Tracing.ACTIVE,
    });
    table.grantWriteData(projectionConsumerFn);   // it WRITES the projection (least-privilege)

    // The rule — routes matching domain events to the consumer
    new events.Rule(this, 'OrderEventsRule', {
      eventBus: bus,
      eventPattern: {
        source: ['bff.orders'],                    // events from our "orders domain"
        detailType: ['OrderPlaced', 'OrderUpdated'],
      },
      targets: [   new targets.LambdaFunction(projectionConsumerFn, {
      deadLetterQueue: consumerDlq,   // ← failed events land here instead of vanishing
      retryAttempts: 3,
    }),],
    });

        // ── Monitoring: SNS topic that emails you on alarm ──────────────
    const alarmTopic = new sns.Topic(this, 'BffAlarmTopic', {
      displayName: 'BFF Live Alarms',
    });
    alarmTopic.addSubscription(
      new subscriptions.EmailSubscription('arafat.csedu.57@gmail.com')   // ← your email
    );

    const notify = new cwactions.SnsAction(alarmTopic);

    // Alarm 1 — stream Lambda is erroring (live-update path broken)
    streamFn.metricErrors({ period: cdk.Duration.minutes(1) })
      .createAlarm(this, 'StreamFnErrorsAlarm', {
        alarmName: 'BFF-StreamHandlerFn-Errors',
        threshold: 1,               // 1 or more errors in a minute
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,  // no data ≠ broken
      })
      .addAlarmAction(notify);

    // Alarm 2 — read Lambda is erroring (initial load broken)
    getOrdersFn.metricErrors({ period: cdk.Duration.minutes(1) })
      .createAlarm(this, 'GetOrdersFnErrorsAlarm', {
        alarmName: 'BFF-GetOrdersFn-Errors',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    // Alarm 3 — API Gateway returning 5xx (server errors reaching users)
    api.metricServerError({ period: cdk.Duration.minutes(1) })
      .createAlarm(this, 'ApiServerErrorsAlarm', {
        alarmName: 'BFF-Api-5xx',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);


        // ── Monitoring dashboard: one screen for system health ──────────
    const dashboard = new cloudwatch.Dashboard(this, 'BffDashboard', {
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


    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'GraphqlUrl', { value: graph.graphqlUrl });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}