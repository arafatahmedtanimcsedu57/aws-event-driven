import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export interface CustomerDbResources {
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  postConfirmationFn: lambda.Function;
}

// Relational store: VPC + RDS Postgres, populated by a Cognito post-confirmation
// trigger. Disposable/dev-sized on purpose (single-AZ, no backups, DESTROY policy).
export function createCustomerDb(scope: Construct, userPool: cognito.UserPool): CustomerDbResources {
  // The private network. NO NAT gateway (natGateways: 0) → no ~$32/mo charge.
  // RDS goes in ISOLATED subnets: private, no internet route — ideal for a DB.
  const vpc = new ec2.Vpc(scope, 'BffVpc', {
    maxAzs: 2,                          // RDS requires 2 AZs even for single-instance
    natGateways: 0,                     // ← critical: avoids the NAT Gateway cost
    subnetConfiguration: [
      {
        name: 'isolated',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,   // no internet in/out
        cidrMask: 24,
      },
    ],
  });

  // Security group for the database — the firewall around RDS.
  const dbSecurityGroup = new ec2.SecurityGroup(scope, 'DbSecurityGroup', {
    vpc,
    description: 'Allow Postgres access from within the VPC only',
    allowAllOutbound: true,
  });

  // The RDS PostgreSQL instance — smallest, cheapest, disposable.
  const database = new rds.DatabaseInstance(scope, 'CustomersDb', {
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16,
    }),
    instanceType: ec2.InstanceType.of(
      ec2.InstanceClass.T4G,            // ARM = cheaper, free-tier eligible
      ec2.InstanceSize.MICRO,           // smallest instance
    ),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [dbSecurityGroup],
    allocatedStorage: 20,               // GB, minimum
    maxAllocatedStorage: 20,            // no autoscaling storage (cost control)
    multiAz: false,                     // single-AZ (cost control)
    databaseName: 'bff',                // creates a DB named "bff"
    // AWS auto-generates the password and stores it in Secrets Manager —
    // you never see or hardcode it. This is the secure pattern.
    credentials: rds.Credentials.fromGeneratedSecret('bffadmin'),
    // Disposable-and-cheap settings:
    removalPolicy: cdk.RemovalPolicy.DESTROY,   // cdk destroy fully removes it
    deletionProtection: false,                  // allow teardown
    backupRetention: cdk.Duration.days(0),      // no backups = no backup storage cost
  });

  // VPC endpoint so the VPC (no internet) can reach Secrets Manager
  vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
    service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  });

  // Post Confirmation trigger Lambda (inside the VPC)
  const postConfirmationFn = new lambda.Function(scope, 'PostConfirmationFn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'post-confirmation/index.handler',
    code: lambda.Code.fromAsset('lambda'),
    vpc,                                                   // ← INSIDE the VPC
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [dbSecurityGroup],                    // same SG so the DB rule allows it
    timeout: cdk.Duration.seconds(30),                    // DB connect can be slow on cold start
    environment: {
      DB_HOST: database.dbInstanceEndpointAddress,
      DB_NAME: 'bff',
      DB_SECRET_ARN: database.secret?.secretArn ?? '',
    },
    tracing: lambda.Tracing.ACTIVE,
  });

  // Let the Lambda read the DB password from Secrets Manager
  database.secret?.grantRead(postConfirmationFn);

  // Allow the Lambda to reach Postgres through the DB security group (self-referencing rule)
  dbSecurityGroup.addIngressRule(
    dbSecurityGroup,
    ec2.Port.tcp(5432),
    'Allow Lambda in this SG to reach Postgres'
  );

  // Attach the trigger to the user pool
  userPool.addTrigger(
    cognito.UserPoolOperation.POST_CONFIRMATION,
    postConfirmationFn
  );

  return { vpc, database, postConfirmationFn };
}
