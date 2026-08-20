import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export interface AuthResources {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

export function createAuth(scope: Construct, notifyEmail: string): AuthResources {
  const userPool = new cognito.UserPool(scope, 'BffUserPool', {
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    autoVerify: { email: true },
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    email: cognito.UserPoolEmail.withSES({
      fromEmail: notifyEmail,          // verified SES identity
      fromName: 'BFF Live',
      sesRegion: 'ap-south-1',
    }),
  });

  const userPoolClient = new cognito.UserPoolClient(scope, 'BffUserPoolClient', {
    userPool,
    authFlows: { userSrp: true, userPassword: true },
  });

  return { userPool, userPoolClient };
}
