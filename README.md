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
                                   │   YOU, from the CLI      │
                                   │   (stubbed "projection   │
                                   │    consumer" — the       │
                                   │    manual write path)    │
                                   └──────────────────────────┘

  ══════════════════════════════════════════════════════════════════════════════════════════════
  DEPLOY:  all of the above is defined in CDK (lib/bff-live-stack.ts + graphql/schema.graphql)
           and created by a single `cdk deploy`.  Frontend runs locally via `npm run dev`.# aws-event-driven
