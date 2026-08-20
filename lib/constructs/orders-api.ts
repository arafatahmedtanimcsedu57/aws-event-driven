import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface OrdersApiResources {
  api: apigateway.LambdaRestApi;
  getOrdersFn: lambda.Function;
}

export function createOrdersApi(
  scope: Construct,
  table: dynamodb.Table,
  userPool: cognito.UserPool,
): OrdersApiResources {
  const getOrdersFn = new lambda.Function(scope, 'GetOrdersFn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'get-orders/index.handler',
    code: lambda.Code.fromAsset('lambda'),
    environment: { TABLE_NAME: table.tableName },
    tracing: lambda.Tracing.ACTIVE,
  });
  table.grantReadData(getOrdersFn);

  const apiAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(scope, 'BffApiAuthorizer', {
    cognitoUserPools: [userPool],
  });

  const api = new apigateway.LambdaRestApi(scope, 'BffApi', {
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

  // The CORS preflight (OPTIONS) can't carry a token, so it must NOT require
  // the Cognito authorizer. Strip auth off every OPTIONS method.
  api.methods.forEach((method) => {
    if (method.httpMethod === 'OPTIONS') {
      const cfn = method.node.defaultChild as apigateway.CfnMethod;
      cfn.authorizationType = apigateway.AuthorizationType.NONE;
      cfn.addPropertyOverride('AuthorizerId', undefined);
    }
  });

  return { api, getOrdersFn };
}
