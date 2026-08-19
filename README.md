# bff-live

An event-driven BFF (Backend-For-Frontend) on AWS: a React client reads orders over
a REST API and stays live via a GraphQL subscription, while the read model is kept
up to date by two independent write paths — a DynamoDB Streams pipe and an
EventBridge domain-event consumer. Everything is provisioned with AWS CDK.

## Architecture

```
                                    ┌────────────────────────────────────────────┐
                                    │        BROWSER   (React + Amplify)         │
                                    │  • login → holds Cognito JWT               │
                                    │  • Channel 1: fetch() initial list         │
                                    │  • Channel 2: subscribe() for live deltas  │
                                    └────┬──────────────────────────▲────────────┘
                                         │                          │
                    ┌────────────────────┘                          └──────────────────────┐
                    │ (1) GET /prod  + JWT                        (6) push order delta     │
                    │     [ HTTPS ]                                   [ WebSocket / wss ]  │
                    ▼                                                                      │
         ┌──────────────────────┐                                          ┌───────────────┴──────────────┐
         │   API GATEWAY        │                                          │          APPSYNC             │
         │   (BffApi)           │                                          │       (BffGraphApi)          │
         │  ┌────────────────┐  │                                          │  ┌────────────────────────┐  │
         │  │ Cognito        │  │◄───── validates JWT ──────┐              │  │ subscription           │  │
         │  │ Authorizer     │  │                           │              │  │ onOrderUpdate          │  │
         │  └────────────────┘  │                           │              │  │ (Cognito auth)         │  │
         └──────────┬───────────┘                           │              │  └───────────▲────────────┘  │
                    │ (2) forward request                   │              │  ┌───────────┴────────────┐  │
                    ▼                                       │              │  │ mutation               │  │
         ┌──────────────────────┐                           │              │  │ publishOrderUpdate     │  │
         │   LAMBDA             │                   ┌───────┴──────┐       │  │ → NONE data source     │  │
         │   GetOrdersFn        │                   │  COGNITO     │       │  │   (writes nothing,     │  │
         │  (handler.js)        │                   │  User Pool   │       │  │    echoes input)       │  │
         │   scan + return JSON │                   │  (users)     │       │  └───────────▲────────────┘  │
         └──────────┬───────────┘                   └──────────────┘       └──────────────┼───────────────┘
                    │ (3) Scan  [IAM: grantReadData]                                      │
                    ▼                                                       (5) signed publish mutation
         ┌─────────────────────────────────────────────┐                      [ HTTPS + SigV4 / IAM ]
         │            DYNAMODB                         │                                  │
         │        OrdersProjection table               │                     ┌────────────┴──────────┐
         │   (the read model / projection)             │                     │   LAMBDA              │
         └───────┬────────────────────────────▲────────┘                     │   StreamHandlerFn     │
                 │                            │                              │   (stream.js)         │
                 │ (b) Stream (CDC)           │ (a) write                    │  reads NewImage,      │
                 │  NEW_IMAGE                 │  put-item / update-item      │  calls the mutation   │
                 ▼                            │                              └───────────▲───────────┘
      ┌────────────────────────┐              │                                          │
      │  EVENT SOURCE MAPPING  │              │                        (4) invokes StreamHandlerFn
      │  (AWS-managed; POLLS   │              │                            with the changed records
      │   the stream for you,  │──────────────┼──────────────────────────────────────────┘
      │   then invokes Lambda) │              │
      └────────────────────────┘              │
                                              │
                                   ┌──────────┴───────────────┐
                                   │  EVENTBRIDGE (default bus)│
                                   │  OrderPlaced/OrderUpdated  │
                                   │  source: bff.orders       │
                                   └──────────┬────────────────┘
                                              │ invokes
                                              ▼
                                   ┌───────────────────────────┐
                                   │  LAMBDA                    │
                                   │  ProjectionConsumerFn      │
                                   │  (consumer.js)              │
                                   │  writes projection row     │
                                   │  from event.detail          │
                                   └────────────────────────────┘
```

### Request/update flow

1. The browser calls `GET /orders` on API Gateway with a Cognito JWT.
2. API Gateway's Cognito authorizer validates the token and forwards the request.
3. `GetOrdersFn` scans the `OrdersProjection` DynamoDB table and returns the items as JSON.
4. Any write to `OrdersProjection` emits a DynamoDB Stream record (`NEW_IMAGE`).
5. An AWS-managed event source mapping polls the stream and invokes `StreamHandlerFn` with the changed records.
6. `StreamHandlerFn` SigV4-signs a `publishOrderUpdate` mutation and posts it straight to AppSync using the Lambda's IAM role — no API key involved.
7. AppSync's `NONE` data source resolver echoes the mutation input back out through the `onOrderUpdate` subscription.
8. Every browser subscribed over the Cognito-authenticated WebSocket receives the delta live.

In parallel, domain events (`OrderPlaced` / `OrderUpdated`, source `bff.orders`) published to the
default EventBridge bus are routed by an `events.Rule` to `ProjectionConsumerFn`, which writes the
denormalized row into `OrdersProjection` — this is the second, independent path that keeps the read
model current and in turn triggers the same stream → AppSync → subscription fan-out above.

## Project structure

```
bin/bff-live.ts          CDK app entry point
lib/bff-live-stack.ts    The whole stack: DynamoDB, Lambdas, API Gateway, Cognito,
                          AppSync, EventBridge rule, SNS alarms, CloudWatch dashboard
lambda/
  handler.js              GetOrdersFn — scans OrdersProjection, returns JSON
  stream.js                StreamHandlerFn — signs & posts publishOrderUpdate to AppSync
  consumer.js              ProjectionConsumerFn — writes projection rows from EventBridge events
graphql/schema.graphql    AppSync schema (Query/Mutation/Subscription + auth directives)
client/                   React + Vite frontend (Amplify auth, Apollo/AppSync subscription)
test/                     Jest unit tests for the CDK stack
```

## Prerequisites

- Node.js 20+
- An AWS account and credentials configured locally (`aws configure` or equivalent)
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html) bootstrapped in the target account/region (`cdk bootstrap`)

## Deploy the backend

```bash
npm install
npm run build     # tsc
npx cdk deploy    # provisions everything in lib/bff-live-stack.ts
```

The stack outputs `ApiUrl`, `GraphqlUrl`, `UserPoolId`, and `UserPoolClientId` — you'll need
these for the frontend `.env`.

Other useful commands:

```bash
npm run watch      # tsc in watch mode
npm test           # run Jest tests
npx cdk diff        # compare deployed stack with current state
npx cdk synth        # emit the synthesized CloudFormation template
```

## Run the frontend

```bash
cd client
cp .env.example .env   # fill in with the CDK stack outputs
npm install
npm run dev
```

`client/.env` expects:

```
VITE_REGION=              # AWS region the stack was deployed to
VITE_APPSYNC_URL=         # GraphqlUrl stack output
VITE_APPSYNC_API_KEY=     # unused (auth is via Cognito user pool, not an API key)
VITE_REST_URL=            # ApiUrl stack output
VITE_USER_POOL_ID=        # UserPoolId stack output
VITE_USER_POOL_CLIENT_ID= # UserPoolClientId stack output
```

Sign up a user (self sign-up is enabled on the user pool, email as the sign-in alias) to log in
and see the initial order list load, then watch it update live as projection writes come in
through either the DynamoDB Streams or EventBridge path.

## Monitoring

The stack also provisions a CloudWatch dashboard (`BFF-Live-Health`) and three alarms
(stream handler errors, get-orders errors, API 5xx) that notify an SNS topic by email.
