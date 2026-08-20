import * as path from 'path';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface LiveUpdatesResources {
  graph: appsync.GraphqlApi;
  streamFn: lambda.Function;
}

// AppSync subscription fan-out, fed by a Lambda that tails the orders table's stream.
export function createLiveUpdates(
  scope: Construct,
  table: dynamodb.Table,
  userPool: cognito.UserPool,
): LiveUpdatesResources {
  const graph = new appsync.GraphqlApi(scope, 'BffGraphApi', {
    name: 'bff-graph-api',
    definition: appsync.Definition.fromFile(
      path.join(__dirname, '..', '..', 'graphql', 'schema.graphql')
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

  const streamFn = new lambda.Function(scope, 'StreamHandlerFn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'stream-handler/index.handler',
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

  return { graph, streamFn };
}
