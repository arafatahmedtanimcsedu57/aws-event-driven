import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createOrdersStore } from './constructs/orders-store';
import { createAuth } from './constructs/auth';
import { createOrdersApi } from './constructs/orders-api';
import { createLiveUpdates } from './constructs/live-updates';
import { createEventBus } from './constructs/event-bus';
import { createMonitoring } from './constructs/monitoring';
import { createCustomerDb } from './constructs/customer-db';

// Verified SES identity: sends Cognito signup email and receives CloudWatch alarms.
const NOTIFY_EMAIL = 'arafat.csedu.57@gmail.com';

export class BffLiveStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = createOrdersStore(this);
    const { userPool, userPoolClient } = createAuth(this, NOTIFY_EMAIL);
    const { api, getOrdersFn } = createOrdersApi(this, table, userPool);
    const { graph, streamFn } = createLiveUpdates(this, table, userPool);
    createEventBus(this, table);
    createMonitoring(this, { table, api, getOrdersFn, streamFn, notifyEmail: NOTIFY_EMAIL });
    const { database } = createCustomerDb(this, userPool);

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'GraphqlUrl', { value: graph.graphqlUrl });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: database.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: database.secret?.secretArn ?? 'none' });
  }
}
